import { describe, expect, it } from "vitest";

import { buildRiskLimitSummary, computeDecisionConfidence } from "@/lib/decision-confidence";

describe("computeDecisionConfidence", () => {
  it("returns an unscored reading when nothing was recorded", () => {
    const c = computeDecisionConfidence({ action: "buy", marketInputs: {} });
    expect(c.score).toBe(0);
    expect(c.components).toHaveLength(0);
    expect(c.coverage).toBe(0);
    expect(c.summary).toMatch(/No structured evidence/);
  });

  it("scores aligned bullish evidence high and misaligned evidence low", () => {
    const mi = {
      regime: { regime: "bull", confidence: 0.9 },
      sector: { strength: 0.8 },
      features: { news_score: 0.8, news_contributors: 4, rank_info: { percentile: 0.92 } },
    };
    const bull = computeDecisionConfidence({ action: "buy", marketInputs: mi, riskReward: 3, eventCount: 5 });
    const bear = computeDecisionConfidence({ action: "sell", marketInputs: mi, riskReward: 3, eventCount: 5 });
    expect(bull.score).toBeGreaterThan(bear.score);
    expect(bull.band).toBe("high");
    expect(bull.coverage).toBeGreaterThan(0.6);
  });

  it("shrinks thin evidence toward neutral", () => {
    const thin = computeDecisionConfidence({
      action: "buy",
      marketInputs: { regime: { regime: "bull", confidence: 1 } },
    });
    const rich = computeDecisionConfidence({
      action: "buy",
      marketInputs: {
        regime: { regime: "bull", confidence: 1 },
        sector: { strength: 1 },
        breakout: { applies: true, quality: 1 },
        features: { news_score: 1, rank_info: { percentile: 1 }, fundamentals_score: { score: 1 } },
      },
      riskReward: 3,
      eventCount: 5,
    });
    expect(thin.score).toBeLessThan(rich.score);
    expect(thin.score).toBeGreaterThan(50);
    expect(rich.score).toBeLessThanOrEqual(100);
  });
});

describe("buildRiskLimitSummary", () => {
  const cfg = {
    per_symbol_limit_pct: 0.1,
    asset_class_limits: { stock: 0.6 },
    stop_loss_pct: 0.07,
    take_profit_pct: 0.2,
    max_hold_days: 60,
    max_daily_loss_pct: 0.03,
    max_drawdown_halt_pct: 0.12,
    vol_target_pct: 0.01,
    size_multiplier: 0.75,
  };

  it("computes utilisation from notional and equity", () => {
    const s = buildRiskLimitSummary({
      level: 2,
      levelName: "Cautious",
      config: cfg,
      assetClass: "stock",
      notional: 500,
      equity: 10_000,
    });
    const perSymbol = s.items.find((i) => i.key === "per_symbol")!;
    expect(perSymbol.value).toBe("10%");
    expect(perSymbol.utilisation).toBeCloseTo(0.5);
    expect(s.notes.some((n) => n.includes("0.75x"))).toBe(true);
  });

  it("flags a position above the per-position cap", () => {
    const s = buildRiskLimitSummary({
      level: 2,
      levelName: "Cautious",
      config: cfg,
      notional: 2_000,
      equity: 10_000,
    });
    expect(s.items.find((i) => i.key === "per_symbol")!.utilisation).toBe(1);
    expect(s.notes.some((n) => n.includes("above the per-position cap"))).toBe(true);
  });

  it("omits utilisation and explains why when equity is unknown", () => {
    const s = buildRiskLimitSummary({ level: null, levelName: "Balanced", config: cfg, notional: 100 });
    expect(s.items.every((i) => i.utilisation === null)).toBe(true);
    expect(s.notes.some((n) => n.includes("equity was not recorded"))).toBe(true);
  });
});
