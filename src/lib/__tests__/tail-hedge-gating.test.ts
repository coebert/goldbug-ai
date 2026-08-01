// Tail-hedge execution gating.
//
// The advisory from `computeTailHedge` is only half the story: the executor
// decides whether the advised leg actually books. Historically it suppressed
// legs that were perfectly safe to execute —
//   * holdings mirrored from the broker as "SGLN:xlon" missed a raw
//     `.get("SGLN.L")` and reported "no SGLN.L to unwind" while the position
//     sat right there (the same keying bug that killed the AAPL trim);
//   * a missing quote dropped a de-risking SELL entirely, even though the
//     position's own cost basis is a perfectly safe sizing basis for a
//     reduction;
//   * whole-share rounding at the broker floored a real reduction to zero.
//
// Gating principle these tests lock: a reduction is suppressed ONLY when
// there is genuinely nothing to sell. Anything the position can support
// executes at the safe size. Adds stay conservative — a BUY still needs a
// live quote and still never borrows.

import { describe, it, expect } from "vitest";
import {
  applyTailHedgeToPaperPortfolio,
  defaultHedgeSymbolFor,
} from "@/lib/hedging/tail-hedge-executor.server";
import type { TailHedgeDecision } from "@/lib/hedging/tail-hedge";
import { classifyDeferralReason } from "@/lib/hedging/tail-hedge-reconcile";
import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

function holding(symbol: string, quantity: number, avgCost = 50): Holding {
  return {
    id: `h-${symbol}`,
    portfolio_id: "p1",
    symbol,
    asset_class: "etf",
    quantity,
    avg_cost: avgCost,
    updated_at: "2026-08-01T09:00:00Z",
    opened_at: "2026-07-01T09:00:00Z",
    high_water_mark: avgCost,
  } as Holding;
}

function sellDecision(deltaNotional: number): TailHedgeDecision {
  return {
    action: "sell",
    targetNotional: 1000,
    deltaNotional: -Math.abs(deltaNotional),
    targetPctNav: 0.01,
    regime: "risk_off",
    reason: "regime cut",
  };
}

function buyDecision(deltaNotional: number): TailHedgeDecision {
  return {
    action: "buy",
    targetNotional: 3000,
    deltaNotional: Math.abs(deltaNotional),
    targetPctNav: 0.03,
    regime: "low_vol",
    reason: "cape stretched",
  };
}

const BASE = {
  portfolioId: "p1",
  portfolioCurrency: "GBP",
  hedgeSymbol: "SGLN.L",
};

describe("tail-hedge SELL is not suppressed when the position can support it", () => {
  it("finds a broker-native holding spelled SGLN:xlon", () => {
    const holdings = new Map<string, Holding>([["SGLN:xlon", holding("SGLN:xlon", 100)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: holdings,
      workingCash: 1000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(res.qty).toBeCloseTo(10, 6);
    expect(res.reason).not.toContain("to unwind");
  });

  it("finds a holding under the canonical uppercase key", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("sgln.l", 100)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
  });

  it("sizes the unwind off cost basis when no live quote exists", () => {
    const holdings = new Map<string, Holding>([["GLD", holding("GLD", 100, 40)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      portfolioCurrency: "USD",
      hedgeSymbol: "GLD",
      decision: sellDecision(400),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map(), // quote feed gap
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(res.priceSource).toBe("avg_cost");
    expect(res.qty).toBeCloseTo(10, 6);
    expect(res.reason).toContain("cost basis");
  });

  it("uses the stored LSE cost basis verbatim (already GBP), like the engine does", () => {
    // avg_cost is persisted in base currency by the broker-sync writers, so a
    // £40 SGLN.L line sizes a £400 clip at 10 units. Re-dividing by 100 here
    // would size 1000 units and disagree with the engine's exposure maths.
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 100, 40)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(400),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map(),
      isLivePortfolio: false,
    });
    expect(res.priceSource).toBe("avg_cost");
    expect(res.qty).toBeCloseTo(10, 6);
  });

  it("sells what the position can support instead of dropping the leg", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 4)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(1000), // wants 20 units, only 4 held
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(res.qty).toBe(4);
    expect(res.partial).toBe(true);
    expect(res.reason).toContain("partial");
  });

  it("closes the tail rather than leaving dust behind", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 10)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(10 * 50 - 1e-10),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.qty).toBe(10);
    expect(holdings.has("SGLN.L")).toBe(false);
  });

  it("live: never floors a real reduction to zero", () => {
    const holdings = new Map<string, Holding>([["SGLN:xlon", holding("SGLN:xlon", 6)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(20), // 0.4 shares at 50
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: true,
    });
    expect(res.applied).toBe(true);
    expect(res.qty).toBe(1);
  });

  it("live: closes an odd lot smaller than one share", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 0.4)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: true,
    });
    expect(res.applied).toBe(true);
    expect(res.qty).toBeCloseTo(0.4, 6);
  });

  it("live: takes the whole position when the residual would be an odd lot", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 5.5)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(5.2 * 50),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: true,
    });
    expect(res.qty).toBeCloseTo(5.5, 6);
  });

  it("live: does not mutate the local mirror — the broker is authoritative", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 100)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: holdings,
      workingCash: 1000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: true,
    });
    expect(res.applied).toBe(true);
    expect(Number(holdings.get("SGLN.L")!.quantity)).toBe(100);
    expect(res.workingCash).toBe(1000);
    expect(res.trade!.reason).toContain("routed via broker executor");
  });

  it("still refuses to short when nothing is held", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: new Map(),
      workingCash: 1000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("to unwind");
    expect(classifyDeferralReason(sellDecision(500), {
      applied: false, reason: res.reason, symbol: res.symbol, qty: 0, notional: 0,
    })).toBe("no_position_to_sell");
  });

  it("still refuses when only dust is held", () => {
    const holdings = new Map<string, Holding>([["SGLN.L", holding("SGLN.L", 1e-12)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(500),
      holdingsByS: holdings,
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
  });
});

describe("tail-hedge BUY stays conservative", () => {
  it("never borrows — spend is capped by cash minus the buffer", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: buyDecision(10_000),
      holdingsByS: new Map(),
      workingCash: 1000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(res.notional).toBeLessThanOrEqual(1000 * 0.99 + 1e-9);
    expect(res.partial).toBe(true);
    expect(res.workingCash).toBeGreaterThanOrEqual(0);
  });

  it("refuses to size a BUY off a stale mark when there is no quote", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: buyDecision(500),
      holdingsByS: new Map([["SGLN.L", holding("SGLN.L", 10)]]),
      workingCash: 10_000,
      priceMap: new Map(),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("no price");
  });

  it("live: requires a whole share", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: buyDecision(30),
      holdingsByS: new Map(),
      workingCash: 40,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: true,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("insufficient cash");
  });

  it("paper: books a fractional add rather than dropping it", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: buyDecision(30),
      holdingsByS: new Map(),
      workingCash: 40,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(res.qty).toBeGreaterThan(0);
    expect(res.qty).toBeLessThan(1);
  });

  it("adds to a broker-native holding under its existing key", () => {
    const holdings = new Map<string, Holding>([["SGLN:xlon", holding("SGLN:xlon", 10, 40)]]);
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: buyDecision(500),
      holdingsByS: holdings,
      workingCash: 10_000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(true);
    expect(holdings.size).toBe(1); // no duplicate position created
    expect(Number(holdings.get("SGLN:xlon")!.quantity)).toBeCloseTo(20, 6);
  });
});

describe("unchanged guards", () => {
  it("holds when the advisory says hold", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: { ...sellDecision(0), action: "hold", deltaNotional: 0 },
      holdingsByS: new Map([["SGLN.L", holding("SGLN.L", 10)]]),
      workingCash: 1000,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("hold");
  });

  it("skips sub-ticket deltas", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      decision: sellDecision(0.5),
      holdingsByS: new Map([["SGLN.L", holding("SGLN.L", 10)]]),
      workingCash: 0,
      priceMap: new Map([["SGLN.L", 50]]),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
  });

  it("rejects an unknown hedge symbol", () => {
    const res = applyTailHedgeToPaperPortfolio({
      ...BASE,
      hedgeSymbol: "NOTATHING.XX",
      decision: sellDecision(500),
      holdingsByS: new Map(),
      workingCash: 1000,
      priceMap: new Map(),
      isLivePortfolio: false,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("unknown hedge symbol");
  });

  it("keeps the currency-based default hedge proxy", () => {
    expect(defaultHedgeSymbolFor("USD")).toBe("GLD");
    expect(defaultHedgeSymbolFor("GBP")).toBe("SGLN.L");
  });
});
