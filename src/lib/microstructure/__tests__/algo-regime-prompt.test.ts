import { describe, it, expect } from "vitest";
import { formatAlgoRegimePromptBlock, summarizeAlgoRegime } from "@/lib/microstructure/algo-regime-prompt";
import { buildHeuristicDecision } from "@/lib/heuristic-decision";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";

const extreme: AlgoRegimeSnapshot = {
  volBurst: true, liquidityVacuum: true, whipsaw: false, correlationSpike: true, gapFade: false,
  score: 3, tier: "extreme",
  multipliers: { maxParticipation: 0.02, sizeScale: 0.4, tailHedgeBoostPctNav: 0.01, blockNewBuys: true },
  reason: "active: vol_burst, liquidity_vacuum, correlation_spike",
};

describe("algo-regime prompt block", () => {
  it("emits an empty string when snapshot is missing", () => {
    expect(formatAlgoRegimePromptBlock(null)).toBe("");
  });

  it("includes tier, active signals and blocking guidance for extreme regimes", () => {
    const block = formatAlgoRegimePromptBlock(extreme);
    expect(block).toMatch(/tier=extreme/);
    expect(block).toMatch(/volatility_burst/);
    expect(block).toMatch(/liquidity_vacuum/);
    expect(block).toMatch(/blockNewBuys=true/);
    expect(block).toMatch(/BLOCK new market buys/);
  });

  it("summarizes for the heuristic path", () => {
    expect(summarizeAlgoRegime(extreme)).toMatch(/tier=extreme/);
    expect(summarizeAlgoRegime(null)).toBe("algo-regime: unknown");
  });
});

describe("heuristic decision + algo regime", () => {
  const features = [
    { symbol: "AAA", rsi14: 40, change5d: -0.06, change30d: -0.12, macd_hist: -0.1 },
    { symbol: "BBB", rsi14: 80, change5d: 0.01, change30d: 0.02, macd_hist: 0 },
    { symbol: "CCC", rsi14: 55, change5d: -0.06, change30d: -0.11, macd_hist: -0.05 },
    { symbol: "DDD", rsi14: 78, change5d: -0.05, change30d: -0.11, macd_hist: -0.02 },
    { symbol: "EEE", rsi14: 82, change5d: -0.06, change30d: -0.10, macd_hist: -0.01 },
  ];
  const holdings = features.map((f) => ({ symbol: f.symbol, quantity: 10 }));

  it("raises the protective-sell cap under extreme algo regime", () => {
    const normal = buildHeuristicDecision({ holdings, features, reason: "429 rate limit" });
    const extreme_ = buildHeuristicDecision({
      holdings, features, reason: "429 rate limit", algoRegime: extreme,
    });
    expect(normal.orders.length).toBeLessThanOrEqual(3);
    expect(extreme_.orders.length).toBeGreaterThan(normal.orders.length);
    expect(extreme_.briefing).toMatch(/tier=extreme/);
    expect(extreme_.rationale).toMatch(/protective-sell cap raised/);
  });
});
