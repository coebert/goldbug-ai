// The fill-unit backfill has to be conservative in a very specific way: it
// must fix pence rows without touching rows that are already pounds, and it
// must refuse to "fix" a gap that isn't a unit error at all.

import { describe, it, expect } from "vitest";
import {
  planFillUnitBackfill,
  referenceCloseFor,
  type BackfillFill,
  type CloseSeries,
} from "../fill-unit-backfill";

function closes(entries: Record<string, Array<[string, number]>>): CloseSeries {
  const m: CloseSeries = new Map();
  for (const [symbol, rows] of Object.entries(entries)) {
    m.set(
      symbol.toUpperCase(),
      rows.map(([date, close]) => ({ date, close })),
    );
  }
  return m;
}

function fill(over: Partial<BackfillFill> & { id: string; symbol: string }): BackfillFill {
  return {
    portfolio_id: "p1",
    side: "buy",
    quantity: 10,
    fill_price: 1,
    currency: "GBP",
    filled_at: "2026-08-05T07:00:00Z",
    ...over,
  };
}

const LSE_CLOSES = closes({
  // price_cache stores LSE common stocks in raw pence.
  "HSBA.L": [["2026-08-05", 1556.0]],
  "MKS.L": [["2026-08-05", 405.0]],
  // Vanguard UK is quoted in pounds by the same feed.
  "VUKE.L": [["2026-08-05", 47.2]],
  AAPL: [["2026-08-05", 342.0]],
});

describe("planFillUnitBackfill", () => {
  it("folds a pence row into pounds", () => {
    const plan = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "HSBA.L", fill_price: 1556.2 })],
      closes: LSE_CLOSES,
    });
    const d = plan.decisions[0]!;
    expect(d.action).toBe("fold_gbx");
    expect(d.correctedPrice).toBeCloseTo(15.562, 6);
    expect(plan.changes).toHaveLength(1);
  });

  it("leaves an already-folded row alone", () => {
    const plan = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "HSBA.L", fill_price: 15.518 })],
      closes: LSE_CLOSES,
    });
    expect(plan.decisions[0]!.action).toBe("ok");
    expect(plan.changes).toHaveLength(0);
  });

  it("is idempotent — re-running over corrected output changes nothing", () => {
    const first = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "MKS.L", fill_price: 405.278662 })],
      closes: LSE_CLOSES,
    });
    const second = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "MKS.L", fill_price: first.decisions[0]!.correctedPrice })],
      closes: LSE_CLOSES,
    });
    expect(first.changes).toHaveLength(1);
    expect(second.changes).toHaveLength(0);
  });

  it("re-inflates a row that was folded twice", () => {
    const plan = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "HSBA.L", fill_price: 0.15562 })],
      closes: LSE_CLOSES,
    });
    expect(plan.decisions[0]!.action).toBe("unfold_gbx");
    expect(plan.decisions[0]!.correctedPrice).toBeCloseTo(15.562, 6);
  });

  it("never folds pound-quoted LSE ETFs or non-LSE listings", () => {
    const plan = planFillUnitBackfill({
      fills: [
        fill({ id: "a", symbol: "VUKE.L", fill_price: 47.255 }),
        fill({ id: "b", symbol: "AAPL", fill_price: 342.87, currency: "USD" }),
      ],
      closes: LSE_CLOSES,
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.counts.ok).toBe(2);
  });

  it("flags an unexplained gap instead of rescaling it", () => {
    const plan = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "HSBA.L", fill_price: 120 })],
      closes: LSE_CLOSES,
    });
    const d = plan.decisions[0]!;
    expect(d.action).toBe("unexplained");
    expect(d.correctedPrice).toBe(120);
    expect(plan.changes).toHaveLength(0);
  });

  it("uses agreeing peer fills when the day has no cached close", () => {
    const plan = planFillUnitBackfill({
      fills: [
        fill({ id: "good", symbol: "MKS.L", fill_price: 4.05 }),
        fill({
          id: "orphan",
          symbol: "MKS.L",
          fill_price: 404.43,
          filled_at: "2026-08-04T11:00:00Z", // no close cached for this day
        }),
      ],
      closes: closes({ "MKS.L": [["2026-08-05", 405.0]] }),
    });
    const orphan = plan.decisions.find((d) => d.id === "orphan")!;
    expect(orphan.referenceSource).toBe("peer_fills");
    expect(orphan.action).toBe("fold_gbx");
    expect(orphan.correctedPrice).toBeCloseTo(4.0443, 6);
  });

  it("leaves rows with no reference and zero prices untouched", () => {
    const plan = planFillUnitBackfill({
      fills: [
        fill({ id: "a", symbol: "ZZZZ.L", fill_price: 900 }),
        fill({ id: "b", symbol: "HSBA.L", fill_price: 0 }),
      ],
      closes: LSE_CLOSES,
    });
    expect(plan.counts.no_reference).toBe(2);
    expect(plan.changes).toHaveLength(0);
  });

  it("rewrites a GBX currency label to GBP", () => {
    const plan = planFillUnitBackfill({
      fills: [fill({ id: "a", symbol: "HSBA.L", fill_price: 15.518, currency: "GBX" })],
      closes: LSE_CLOSES,
    });
    const d = plan.decisions[0]!;
    expect(d.correctedCurrency).toBe("GBP");
    expect(d.changed).toBe(true);
  });

  it("reports the portfolios that need a P&L recompute", () => {
    const plan = planFillUnitBackfill({
      fills: [
        fill({ id: "a", symbol: "HSBA.L", fill_price: 1556.2, portfolio_id: "pA" }),
        fill({ id: "b", symbol: "HSBA.L", fill_price: 15.5, portfolio_id: "pB" }),
      ],
      closes: LSE_CLOSES,
    });
    expect(plan.affectedPortfolioIds).toEqual(["pA"]);
  });
});

describe("referenceCloseFor", () => {
  it("carries the last close forward and folds pence", () => {
    expect(referenceCloseFor(LSE_CLOSES, "HSBA.L", "2026-08-06")).toBeCloseTo(15.56, 6);
  });

  it("returns null before the first cached close", () => {
    expect(referenceCloseFor(LSE_CLOSES, "HSBA.L", "2026-01-01")).toBeNull();
  });
});
