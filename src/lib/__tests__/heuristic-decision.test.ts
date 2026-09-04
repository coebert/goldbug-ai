import { describe, it, expect } from "vitest";
import { buildHeuristicSells, buildHeuristicDecision } from "../heuristic-decision";

describe("heuristic-decision", () => {
  const holdings = [
    { symbol: "AAA", quantity: 10 }, // will trip 30d
    { symbol: "BBB", quantity: 5 },  // will trip RSI overbought
    { symbol: "CCC", quantity: 7 },  // no signal
    { symbol: "DDD", quantity: 3 },  // 5d + MACD
  ];
  const features = [
    { symbol: "AAA", rsi14: 50, change5d: 0.01, change30d: -0.15, macd_hist: 0.1 },
    { symbol: "BBB", rsi14: 82, change5d: 0.02, change30d: 0.05, macd_hist: 0.05 },
    { symbol: "CCC", rsi14: 55, change5d: 0.00, change30d: 0.02, macd_hist: 0.0 },
    { symbol: "DDD", rsi14: 40, change5d: -0.06, change30d: -0.03, macd_hist: -0.2 },
  ];

  it("emits protective sells for weak/overbought holdings only", () => {
    const sells = buildHeuristicSells(holdings, features);
    const syms = sells.map((s) => s.symbol).sort();
    expect(syms).toEqual(["AAA", "BBB", "DDD"]);
    for (const s of sells) {
      expect(s.side).toBe("sell");
      expect(s.quantity).toBeGreaterThan(0);
      expect(s.reason).toMatch(/heuristic exit/);
    }
  });

  it("never emits buys and caps at maxSells", () => {
    const sells = buildHeuristicSells(holdings, features, { maxSells: 1 });
    expect(sells.length).toBe(1);
    // Worst-scored symbol should be first; must be one of the flagged.
    expect(["AAA", "BBB", "DDD"]).toContain(sells[0].symbol);
  });

  it("skips holdings with zero quantity or no features", () => {
    const sells = buildHeuristicSells(
      [{ symbol: "AAA", quantity: 0 }, { symbol: "ZZZ", quantity: 1 }],
      features,
    );
    expect(sells).toEqual([]);
  });

  it("buildHeuristicDecision returns a decision with rationale citing the reason", () => {
    const d = buildHeuristicDecision({
      holdings, features, reason: "Forbidden 403",
    });
    expect(d.orders.length).toBeGreaterThan(0);
    expect(d.rationale).toContain("Forbidden 403");
    expect(d.briefing).toMatch(/AI unavailable/);
  });

  it("returns empty orders (but valid decision) when no signals fire", () => {
    const d = buildHeuristicDecision({
      holdings: [{ symbol: "CCC", quantity: 1 }],
      features: [{ symbol: "CCC", rsi14: 55, change5d: 0, change30d: 0, macd_hist: 0 }],
      reason: "gateway 429",
    });
    expect(d.orders).toEqual([]);
    expect(d.briefing).toMatch(/heuristic found no signals/);
  });
});

describe("fallback sizing when the AI is down", () => {
  const feats = [
    { symbol: "AAA", rsi14: 60, change5d: 0.03, change30d: 0.1, macd_hist: 0.4, assetClass: "stock" },
  ];

  it("stands aside in extreme greed", () => {
    expect(
      buildHeuristicBuys([], feats, { cashValue: 10_000, riskLevel: "aggressive", fearLabel: "extreme_greed" }),
    ).toEqual([]);
  });

  it("halves the sleeve in ordinary greed", () => {
    const greedy = buildHeuristicBuys([], feats, { cashValue: 10_000, riskLevel: "balanced", fearLabel: "greed" });
    const neutral = buildHeuristicBuys([], feats, { cashValue: 10_000, riskLevel: "balanced", fearLabel: "neutral" });
    expect(greedy[0]!.percent).toBeCloseTo(neutral[0]!.percent / 2);
  });

  it("keeps the single-name ceiling well under a concentrated bet", () => {
    expect(FALLBACK_MAX_NAME_WEIGHT_PCT).toBeLessThanOrEqual(10);
  });
});
