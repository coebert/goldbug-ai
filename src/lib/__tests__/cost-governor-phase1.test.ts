// Phase 1 cost-leak controls: ticket aggregation, edge-per-cost ranking,
// smooth NAV bands, churn reconciliation and sector concentration.

import { describe, it, expect } from "vitest";
import { aggregateOrders } from "../order-aggregation";
import { edgePerCost, governorForNav, planAdmissions } from "../cost-governor";
import { resolveChurnPolicy } from "../churn-policy";
import { planSectorAdmissions, DEFAULT_SECTOR_BUDGET } from "../sector-concentration";

describe("order aggregation", () => {
  it("collapses repeated same-side tickets into one at the weighted price", () => {
    const res = aggregateOrders([
      { symbol: "MKS.L", side: "buy", quantity: 100, price: 3 },
      { symbol: "MKS.L", side: "buy", quantity: 300, price: 3.4 },
    ]);
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]!.quantity).toBe(400);
    expect(res.orders[0]!.price).toBeCloseTo((100 * 3 + 300 * 3.4) / 400, 10);
    expect(res.ticketsSaved).toBe(1);
  });

  it("keeps the exit whole and drops the opposing buy leg", () => {
    const res = aggregateOrders([
      { symbol: "VOD.L", side: "buy", quantity: 500, price: 1 },
      { symbol: "VOD.L", side: "sell", quantity: 200, price: 1 },
    ]);
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]!.side).toBe("sell");
    expect(res.orders[0]!.quantity).toBe(200);
  });

  it("never nets a protective sell away, even when the legs are equal", () => {
    const res = aggregateOrders([
      { symbol: "VOD.L", side: "buy", quantity: 200, price: 1 },
      { symbol: "VOD.L", side: "sell", quantity: 200, price: 1 },
    ]);
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]!.side).toBe("sell");
    expect(res.orders[0]!.quantity).toBe(200);
  });

  it("preserves other order fields from the first ticket", () => {
    const res = aggregateOrders([
      { symbol: "AAPL:xnas", side: "buy", quantity: 1, price: 100, instrument_ccy: "USD", conviction: 0.8 },
      { symbol: "AAPL:xnas", side: "buy", quantity: 1, price: 102, instrument_ccy: "USD", conviction: 0.8 },
    ]);
    expect(res.orders[0]).toMatchObject({ instrument_ccy: "USD", conviction: 0.8, quantity: 2 });
  });
});

describe("edge per cost ranking", () => {
  it("prefers a high-conviction small ticket over a low-conviction large one", () => {
    const good = edgePerCost({ symbol: "A", side: "buy", notionalBase: 500, estCostBase: 5, edgeScore: 0.9 });
    const bad = edgePerCost({ symbol: "B", side: "buy", notionalBase: 5_000, estCostBase: 25, edgeScore: 0.05 });
    expect(good).toBeGreaterThan(bad);
  });

  it("spends a scarce budget on the best idea first", () => {
    const cfg = {
      navBase: 10_000,
      buysAlreadyToday: 0,
      // 50 already spent against a 60 floor (6 x 10 typical ticket) leaves
      // room for exactly one ticket.
      trailingCostBase: 50,
      lastBuyDaysAgo: {},
      ...governorForNav(10_000),
      costBudgetPctOfNav: 0.0015,
    };
    const plan = planAdmissions(
      [
        { symbol: "WEAK", side: "buy", notionalBase: 1_000, estCostBase: 10, edgeScore: 0.1 },
        { symbol: "STRONG", side: "buy", notionalBase: 1_000, estCostBase: 10, edgeScore: 0.95 },
      ],
      cfg,
    );
    const admitted = plan.decisions.filter((d) => d.kind === "admit").map((d) => d.candidate.symbol);
    expect(admitted).toContain("STRONG");
    expect(admitted).not.toContain("WEAK");
  });

  it("never gates a sell", () => {
    const plan = planAdmissions(
      [{ symbol: "X", side: "sell", notionalBase: 10, estCostBase: 500 }],
      {
        navBase: 10_000,
        buysAlreadyToday: 99,
        trailingCostBase: 1e9,
        lastBuyDaysAgo: {},
        ...governorForNav(10_000),
      },
    );
    expect(plan.decisions.every((d) => d.kind === "admit")).toBe(true);
  });
});

describe("NAV-scaled governor profile", () => {
  it("is continuous across the old band boundaries", () => {
    const below = governorForNav(49_999);
    const above = governorForNav(50_001);
    expect(Math.abs(below.minTicketPctOfNav - above.minTicketPctOfNav)).toBeLessThan(0.0005);
    expect(Math.abs(below.absoluteMinTicketBase - above.absoluteMinTicketBase)).toBeLessThan(5);
  });

  it("loosens monotonically with account size", () => {
    const small = governorForNav(10_000);
    const mid = governorForNav(80_000);
    const large = governorForNav(500_000);
    expect(small.minTicketPctOfNav).toBeGreaterThan(mid.minTicketPctOfNav);
    expect(mid.minTicketPctOfNav).toBeGreaterThan(large.minTicketPctOfNav);
    expect(small.maxBuysPerDay).toBeLessThanOrEqual(mid.maxBuysPerDay);
    expect(mid.maxBuysPerDay).toBeLessThanOrEqual(large.maxBuysPerDay);
  });

  it("clamps below and above the anchor range", () => {
    expect(governorForNav(500).absoluteMinTicketBase).toBe(250);
    expect(governorForNav(5_000_000).absoluteMinTicketBase).toBe(2_000);
  });
});

describe("churn policy", () => {
  it("takes the longer of the style and cost cooldowns", () => {
    expect(resolveChurnPolicy({ styleReentryMinDays: 2, governorCooldownDays: 5 }).cooldownDays).toBe(5);
    expect(resolveChurnPolicy({ styleReentryMinDays: 9, governorCooldownDays: 5 }).cooldownDays).toBe(9);
  });

  it("falls back to the cost floor when no style rule is set", () => {
    const p = resolveChurnPolicy({ styleReentryMinDays: null, governorCooldownDays: 4 });
    expect(p.cooldownDays).toBe(4);
    expect(p.boundBy).toBe("cost");
  });
});

describe("sector concentration", () => {
  it("blocks a buy that would push a sector past its share of NAV", () => {
    const plan = planSectorAdmissions(
      [{ symbol: "NVDA", sector: "tech", notionalBase: 2_000 }],
      { tech: 2_000 },
      { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET },
    );
    expect(plan.decisions[0]!.kind).toBe("skip");
  });

  it("admits inside the cap and tracks resulting exposure", () => {
    const plan = planSectorAdmissions(
      [{ symbol: "NVDA", sector: "tech", notionalBase: 500 }],
      { tech: 1_000 },
      { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET },
    );
    expect(plan.decisions[0]!.kind).toBe("admit");
    expect(plan.exposureAfter["tech"]).toBe(1_500);
  });

  it("holds unknown-sector names to the same leash as a named sector", () => {
    // Unknown names are no longer on a tighter 15% leash — the per-name
    // position cap and the strong-signal stretch govern them instead.
    const inside = planSectorAdmissions(
      [{ symbol: "???", sector: null, notionalBase: 1_600 }],
      {},
      { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET },
    );
    expect(inside.decisions[0]!.kind).toBe("admit");
    const past = planSectorAdmissions(
      [{ symbol: "???", sector: null, notionalBase: 2_600 }],
      {},
      { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET },
    );
    expect(past.decisions[0]!.kind).toBe("skip");
  });
});
