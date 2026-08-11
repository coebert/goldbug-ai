// Locks the correlated-shock execution model: rho must actually induce
// cross-symbol correlation, the stress regime must persist and bite, and a
// zeroed config must degenerate back to independent draws — otherwise the
// "joint worst case" is just the independent one with extra steps.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CORRELATED_EXECUTION,
  makeCorrelatedExecutionSampler,
  marketVolZScores,
} from "@/lib/execution-correlated-shocks";
import { percentile } from "@/lib/execution-monte-carlo";

const NAMES = 8;

/** Runs `bars` bars of `NAMES` symbols and returns per-bar slippage vectors. */
function runBars(cfg: Parameters<typeof makeCorrelatedExecutionSampler>[0], bars = 3000, seed = 3) {
  const s = makeCorrelatedExecutionSampler(cfg, seed);
  const rows: { stressed: boolean; mults: number[]; fills: number[] }[] = [];
  for (let b = 0; b < bars; b++) {
    const r = s.beginBar(0);
    const mults: number[] = [];
    const fills: number[] = [];
    for (let n = 0; n < NAMES; n++) {
      const d = s.draw();
      mults.push(d.slippageMult);
      fills.push(d.fillRatio);
    }
    rows.push({ stressed: r.stressed, mults, fills });
  }
  return { rows, sampler: s };
}

const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
};

/** Average pairwise correlation of log slippage across symbols. */
function meanCrossCorr(rows: { mults: number[] }[]): number {
  const cols = Array.from({ length: NAMES }, (_, n) => rows.map((r) => Math.log(r.mults[n]!)));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < NAMES; i++) {
    for (let j = i + 1; j < NAMES; j++) {
      sum += corr(cols[i]!, cols[j]!);
      count++;
    }
  }
  return sum / count;
}

describe("correlated execution sampler", () => {
  it("is reproducible for a seed and differs across seeds", () => {
    const a = runBars({}, 50, 11).rows;
    const b = runBars({}, 50, 11).rows;
    const c = runBars({}, 50, 12).rows;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("induces cross-symbol slippage correlation close to rho", () => {
    const calm = { stressEnterProb: 0, volStressZ: Infinity, tailProb: 0 };
    const low = meanCrossCorr(runBars({ ...calm, rho: 0 }).rows);
    const mid = meanCrossCorr(runBars({ ...calm, rho: 0.5 }).rows);
    const high = meanCrossCorr(runBars({ ...calm, rho: 0.9 }).rows);
    expect(Math.abs(low)).toBeLessThan(0.06);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(high).toBeGreaterThan(0.85);
  });

  it("keeps draws inside the declared bounds even under stress", () => {
    const { rows } = runBars({ stressEnterProb: 0.5, stressSlippageMult: 6 });
    for (const r of rows) {
      for (const m of r.mults) {
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(DEFAULT_CORRELATED_EXECUTION.maxSlippageMult);
      }
      for (const f of r.fills) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });

  it("makes stressed bars materially worse for slippage and fills", () => {
    const { rows } = runBars({ stressEnterProb: 0.06, rho: 0.6 });
    const stressed = rows.filter((r) => r.stressed);
    const calm = rows.filter((r) => !r.stressed);
    expect(stressed.length).toBeGreaterThan(50);
    const medMult = (rs: typeof rows) => percentile(rs.flatMap((r) => r.mults).sort((a, b) => a - b), 0.5);
    const noFillRate = (rs: typeof rows) => {
      const f = rs.flatMap((r) => r.fills);
      return f.filter((v) => v === 0).length / f.length;
    };
    expect(medMult(stressed)).toBeGreaterThan(medMult(calm) * 1.5);
    expect(noFillRate(stressed)).toBeGreaterThan(noFillRate(calm) * 2);
  });

  it("clusters stress rather than flickering bar to bar", () => {
    const { rows } = runBars({ stressEnterProb: 0.03, stressExitProb: 0.2 }, 6000);
    const runsOf = rows.reduce<number[]>((acc, r, i) => {
      if (!r.stressed) return acc;
      if (i > 0 && rows[i - 1]!.stressed) acc[acc.length - 1]! += 1;
      else acc.push(1);
      return acc;
    }, []);
    const meanRun = runsOf.reduce((a, b) => a + b, 0) / runsOf.length;
    // Mean length ≈ 1/stressExitProb = 5 bars; independent draws would give ~1.
    expect(meanRun).toBeGreaterThan(3);
  });

  it("forces stress when the volatility z-score breaches the threshold", () => {
    const s = makeCorrelatedExecutionSampler(
      { stressEnterProb: 0, stressExitProb: 1, volStressZ: 1.5 },
      7,
    );
    expect(s.beginBar(0).stressed).toBe(false);
    const hot = s.beginBar(3);
    expect(hot.stressed).toBe(true);
    // Extra vol above the threshold widens slippage further.
    expect(hot.regimeMult).toBeGreaterThan(DEFAULT_CORRELATED_EXECUTION.stressSlippageMult);
    expect(s.stressShare()).toBeCloseTo(0.5, 9);
  });

  it("degenerates to independent, unstressed draws when coupling is switched off", () => {
    const cfg = { rho: 0, stressEnterProb: 0, volStressZ: Infinity, tailProb: 0 };
    const { rows, sampler } = runBars(cfg, 2000, 21);
    expect(sampler.stressShare()).toBe(0);
    expect(Math.abs(meanCrossCorr(rows))).toBeLessThan(0.06);
  });
});

describe("marketVolZScores", () => {
  const ramp = (n: number, vol: number, seed = 1) => {
    let p = 100;
    let a = seed;
    return Array.from({ length: n }, () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      p *= 1 + ((a / 2147483648) - 0.5) * vol;
      return p;
    });
  };

  it("scores a calm-then-violent tape as rising volatility", () => {
    const series = new Map([["A", [...ramp(200, 0.005), ...ramp(200, 0.08, 9)]]]);
    const z = marketVolZScores(series, 20);
    expect(z.length).toBe(400);
    const calmMean = z.slice(50, 190).reduce((a, b) => a + b, 0) / 140;
    const wildMean = z.slice(250, 400).reduce((a, b) => a + b, 0) / 150;
    expect(wildMean).toBeGreaterThan(calmMean);
    expect(wildMean).toBeGreaterThan(0.5);
  });

  it("handles empty and degenerate inputs without throwing", () => {
    expect(marketVolZScores(new Map())).toEqual([]);
    const flat = marketVolZScores(new Map([["A", new Array(50).fill(100)]]), 20);
    expect(flat.every((v) => v === 0)).toBe(true);
  });
});
