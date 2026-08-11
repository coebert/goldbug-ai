// Locks the randomized-execution model used by the Monte-Carlo backtest:
// the RNG must be reproducible, the draws must stay inside their declared
// bounds, and the percentile statistics must be correct — otherwise a
// "1-in-20 bad year" number is meaningless.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXECUTION_SIM,
  DETERMINISTIC_DRAW,
  makeExecutionSampler,
  mulberry32,
  percentile,
  percentileStats,
  standardNormal,
} from "@/lib/execution-monte-carlo";

const sampleN = (n: number, cfg = {}, seed = 1) => {
  const s = makeExecutionSampler(cfg, seed);
  return Array.from({ length: n }, () => s());
};

describe("mulberry32", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    const c = Array.from({ length: 5 }, mulberry32(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("stays in [0,1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("standardNormal", () => {
  it("has roughly zero mean and unit variance", () => {
    const rng = mulberry32(11);
    const xs = Array.from({ length: 20_000 }, () => standardNormal(rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
    expect(xs.every(Number.isFinite)).toBe(true);
  });
});

describe("execution sampler", () => {
  it("is reproducible for the same seed", () => {
    expect(sampleN(50, {}, 99)).toEqual(sampleN(50, {}, 99));
    expect(sampleN(50, {}, 99)).not.toEqual(sampleN(50, {}, 100));
  });

  it("keeps every draw inside its declared bounds", () => {
    const draws = sampleN(20_000);
    for (const d of draws) {
      expect(d.slippageMult).toBeGreaterThanOrEqual(0);
      expect(d.slippageMult).toBeLessThanOrEqual(DEFAULT_EXECUTION_SIM.maxSlippageMult);
      expect(d.fillRatio).toBeGreaterThanOrEqual(0);
      expect(d.fillRatio).toBeLessThanOrEqual(1);
      // A partial fill is never smaller than the configured floor.
      if (d.fillRatio > 0) {
        expect(d.fillRatio).toBeGreaterThanOrEqual(DEFAULT_EXECUTION_SIM.minFillRatio);
      }
    }
  });

  it("centres the slippage multiplier on 1 (unit median, fat right tail)", () => {
    const mults = sampleN(20_000).map((d) => d.slippageMult).sort((a, b) => a - b);
    expect(percentile(mults, 0.5)).toBeGreaterThan(0.9);
    expect(percentile(mults, 0.5)).toBeLessThan(1.1);
    // Fat tail: mean sits above the median, and the 99th percentile is far out.
    const mean = mults.reduce((a, b) => a + b, 0) / mults.length;
    expect(mean).toBeGreaterThan(percentile(mults, 0.5));
    expect(percentile(mults, 0.99)).toBeGreaterThan(3);
  });

  it("hits the configured full / partial / no-fill mix", () => {
    const draws = sampleN(40_000, { fullFillProb: 0.7, noFillProb: 0.1 });
    const share = (f: (r: number) => boolean) => draws.filter((d) => f(d.fillRatio)).length / draws.length;
    expect(share((r) => r === 0)).toBeGreaterThan(0.08);
    expect(share((r) => r === 0)).toBeLessThan(0.12);
    expect(share((r) => r === 1)).toBeGreaterThan(0.66);
    expect(share((r) => r === 1)).toBeLessThan(0.74);
    expect(share((r) => r > 0 && r < 1)).toBeGreaterThan(0.16);
  });

  it("degenerates to deterministic execution when randomness is switched off", () => {
    const draws = sampleN(500, { slippageSigma: 0, tailProb: 0, fullFillProb: 1, noFillProb: 0 });
    for (const d of draws) {
      expect(d.slippageMult).toBeCloseTo(DETERMINISTIC_DRAW.slippageMult, 9);
      expect(d.fillRatio).toBe(DETERMINISTIC_DRAW.fillRatio);
    }
  });

  it("widens the distribution as sigma rises", () => {
    const spread = (sigma: number) => {
      const m = sampleN(8000, { slippageSigma: sigma }, 5).map((d) => d.slippageMult).sort((a, b) => a - b);
      return percentile(m, 0.95) - percentile(m, 0.05);
    };
    expect(spread(1.0)).toBeGreaterThan(spread(0.3));
  });
});

describe("percentile statistics", () => {
  it("interpolates percentiles of a known series", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 1)).toBe(5);
    expect(percentile(xs, 0.25)).toBe(2);
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("summarizes a sample with ordered percentiles and tail risk", () => {
    const xs = [-10, -4, -1, 0, 1, 2, 3, 4, 5, 20];
    const s = percentileStats(xs);
    expect(s.n).toBe(10);
    expect(s.worst).toBe(-10);
    expect(s.best).toBe(20);
    expect(s.p5).toBeLessThanOrEqual(s.p25);
    expect(s.p25).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.p75);
    expect(s.p75).toBeLessThanOrEqual(s.p95);
    expect(s.probLoss).toBeCloseTo(0.3, 9);
    // CVaR5 on 10 points falls back to the single worst observation.
    expect(s.cvar5).toBe(-10);
    expect(s.cvar5).toBeLessThanOrEqual(s.p5);
    expect(s.mean).toBeCloseTo(2, 9);
  });

  it("is order-independent and ignores non-finite values", () => {
    const a = percentileStats([3, 1, 2]);
    const b = percentileStats([2, 3, 1]);
    expect(a).toEqual(b);
    expect(percentileStats([1, NaN, 2, Infinity]).n).toBe(2);
  });

  it("returns NaNs rather than throwing on an empty sample", () => {
    const s = percentileStats([]);
    expect(s.n).toBe(0);
    expect(s.median).toBeNaN();
  });
});
