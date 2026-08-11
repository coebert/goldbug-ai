import { describe, expect, it } from "vitest";
import {
  walkForwardRegime,
  walkForwardAllRegimes,
  fitWeights,
  edgeOf,
  DEFAULT_WALK_FORWARD,
  type RegimeObservation,
} from "../regime-walkforward";
import type { StrategyWeights } from "../regime-matrix";

const prior: StrategyWeights = { trend: 0.2, mean_reversion: 0.2, quality: 0.2, carry: 0.2, breakout: 0.2 };

const ts = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

// Deterministic pseudo-random so folds are reproducible.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Universe where `driver` genuinely predicts the forward return and the rest is noise. */
function observations(n: number, driver: keyof StrategyWeights, regime = "trending"): RegimeObservation[] {
  const r = rng(7);
  return Array.from({ length: n }, (_, i) => {
    const signal = r() * 2 - 1;
    const noise = r() * 2 - 1;
    return {
      ts: ts(i),
      regime,
      perModel: {
        trend: driver === "trend" ? signal : noise,
        mean_reversion: driver === "mean_reversion" ? signal : r() * 2 - 1,
        quality: driver === "quality" ? signal : r() * 2 - 1,
        carry: driver === "carry" ? signal : r() * 2 - 1,
        breakout: driver === "breakout" ? signal : r() * 2 - 1,
      },
      forwardBps: signal * 100 + (r() * 2 - 1) * 20,
    };
  });
}

describe("regime walk-forward", () => {
  it("reports insufficient data below the sample floor", () => {
    const res = walkForwardRegime("trending", observations(50, "trend"), prior);
    expect(res.verdict).toBe("insufficient_data");
    expect(res.recommendedWeights).toEqual(prior);
  });

  it("fits weight toward the model that actually predicts returns", () => {
    const w = fitWeights(observations(300, "trend"), prior);
    expect(w.trend).toBeGreaterThan(prior.trend);
    expect(w.trend).toBeGreaterThan(w.carry);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("never re-enables a model the regime prior switched off", () => {
    const off: StrategyWeights = { ...prior, breakout: 0 };
    const w = fitWeights(observations(300, "breakout"), off);
    expect(w.breakout).toBe(0);
  });

  it("adopts fitted weights when they beat the prior out of sample", () => {
    const res = walkForwardRegime("trending", observations(900, "trend"), prior);
    expect(res.folds.length).toBeGreaterThan(1);
    expect(res.verdict).toBe("supported");
    expect(res.recommendedWeights.trend).toBeGreaterThan(prior.trend);
    expect(res.summary).toContain("recommend adopting");
  });

  it("keeps the prior when the fit adds nothing out of sample", () => {
    // Pure noise: no model predicts the forward return.
    const r = rng(11);
    const noise: RegimeObservation[] = Array.from({ length: 900 }, (_, i) => ({
      ts: ts(i),
      regime: "range_bound",
      perModel: {
        trend: r() * 2 - 1, mean_reversion: r() * 2 - 1, quality: r() * 2 - 1,
        carry: r() * 2 - 1, breakout: r() * 2 - 1,
      },
      forwardBps: (r() * 2 - 1) * 100,
    }));
    const res = walkForwardRegime("range_bound", noise, prior);
    expect(res.verdict).toBe("not_supported");
    expect(res.recommendedWeights).toEqual(prior);
  });

  it("evaluates folds on untouched forward data", () => {
    const res = walkForwardRegime("trending", observations(900, "trend"), prior);
    for (const f of res.folds) {
      expect(f.testFrom > f.trainFrom).toBe(true);
      expect(f.testSamples).toBe(DEFAULT_WALK_FORWARD.testSize);
    }
  });

  it("measures edge as the return earned by the composite's sign", () => {
    const obs: RegimeObservation[] = [
      { ts: ts(0), regime: "r", perModel: { trend: 1 }, forwardBps: 50 },
      { ts: ts(1), regime: "r", perModel: { trend: -1 }, forwardBps: -30 },
      { ts: ts(2), regime: "r", perModel: { trend: 0 }, forwardBps: 999 },
    ];
    expect(edgeOf(obs, prior)).toBeCloseTo(40, 9);
  });

  it("sorts observations chronologically before folding", () => {
    const obs = observations(900, "trend");
    const shuffled = [...obs].reverse();
    const a = walkForwardRegime("trending", obs, prior);
    const b = walkForwardRegime("trending", shuffled, prior);
    expect(b.folds.map((f) => f.testFrom)).toEqual(a.folds.map((f) => f.testFrom));
  });

  it("splits by regime and returns the biggest sample first", () => {
    const all = [...observations(900, "trend", "trending"), ...observations(120, "quality", "risk_off")];
    const results = walkForwardAllRegimes(all, { trending: prior, risk_off: prior, unknown: prior });
    expect(results.map((r) => r.regime)).toEqual(["trending", "risk_off"]);
    expect(results[1]!.verdict).toBe("insufficient_data");
  });
});
