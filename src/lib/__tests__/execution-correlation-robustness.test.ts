import { describe, it, expect } from "vitest";
import {
  stressTestCalibration,
  transformForEstimator,
  closesFromReturns,
  blockResampleIndices,
  formatCalibrationRobustness,
  ALL_ESTIMATORS,
} from "../execution-correlation-robustness";
import { returnSeries } from "../execution-correlation-calibration";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two clusters with strong within-cluster coupling and a stressed tail half. */
function syntheticTape(bars = 400) {
  const rand = mulberry32(7);
  const gauss = () => {
    const u = Math.max(1e-9, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const symbols = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "KO"];
  const cluster = (s: string) => (["AAPL", "MSFT", "NVDA"].includes(s) ? 0 : 1);
  const closes = new Map<string, number[]>(symbols.map((s) => [s, [100]]));
  const volZ: number[] = [0];
  for (let t = 1; t < bars; t++) {
    const stressed = t > bars * 0.7;
    const scale = stressed ? 3 : 1;
    const market = gauss() * 0.004 * scale;
    const f = [gauss() * 0.006 * scale, gauss() * 0.006 * scale];
    volZ.push(stressed ? 2.2 : 0.2);
    for (const s of symbols) {
      const r = market * (stressed ? 1.2 : 0.4) + f[cluster(s)]! + gauss() * 0.004;
      const prev = closes.get(s)!;
      prev.push(prev[prev.length - 1]! * Math.exp(r));
    }
  }
  const groups = new Map(symbols.map((s) => [s, cluster(s) === 0 ? "tech" : "value"]));
  return { closes, volZ, groups };
}

describe("estimator transforms", () => {
  it("leaves pearson untouched and clips winsorised outliers", () => {
    const xs = [0.01, -0.02, 0.015, 0.9, -0.01];
    expect(transformForEstimator(xs, "pearson")).toEqual(xs);
    const w = transformForEstimator(xs, "winsorized", 1.5);
    expect(Math.max(...w)).toBeLessThan(0.9);
    expect(w[0]).toBeCloseTo(0.01, 10);
  });

  it("spearman scores are monotone in the input and roughly symmetric", () => {
    const xs = [5, 1, 3, 2, 4];
    const s = transformForEstimator(xs, "spearman");
    const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
    for (let i = 1; i < order.length; i++) {
      expect(s[order[i]!]!).toBeGreaterThan(s[order[i - 1]!]!);
    }
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
  });

  it("winsorising pulls a Pearson correlation inflated by one bar back down", () => {
    const n = 120;
    const a: number[] = [];
    const b: number[] = [];
    const rand = mulberry32(3);
    for (let i = 0; i < n; i++) {
      a.push(rand() - 0.5);
      b.push(rand() - 0.5);
    }
    a[0] = 12;
    b[0] = 12; // a single shared spike that fakes a correlation
    const corr = (x: number[], y: number[]) => {
      const mx = x.reduce((p, q) => p + q, 0) / x.length;
      const my = y.reduce((p, q) => p + q, 0) / y.length;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < x.length; i++) {
        num += (x[i]! - mx) * (y[i]! - my);
        dx += (x[i]! - mx) ** 2;
        dy += (y[i]! - my) ** 2;
      }
      return num / Math.sqrt(dx * dy);
    };
    const raw = corr(a, b);
    const clipped = corr(
      transformForEstimator(a, "winsorized", 2),
      transformForEstimator(b, "winsorized", 2),
    );
    expect(raw).toBeGreaterThan(0.9);
    expect(clipped).toBeLessThan(raw - 0.3);
  });
});

describe("returns → synthetic closes round trip", () => {
  it("reproduces the return series the calibration will difference back out", () => {
    const rets = new Map([["A", [0.01, -0.02, 0.003, 0.011]]]);
    const closes = closesFromReturns(rets);
    const back = returnSeries(closes, "returns").get("A")!;
    expect(back.length).toBe(4);
    for (let i = 0; i < back.length; i++) {
      expect(back[i]!).toBeCloseTo(rets.get("A")![i]!, 10);
    }
  });

  it("keeps synthetic prices strictly positive for absolute-return input", () => {
    const closes = closesFromReturns(new Map([["A", [0.02, 0.02, 0.05]]]));
    expect(closes.get("A")!.every((v) => v > 0)).toBe(true);
  });
});

describe("block resampling", () => {
  it("returns exactly n indices inside range and preserves runs", () => {
    const rand = mulberry32(11);
    const idx = blockResampleIndices(50, 10, rand);
    expect(idx).toHaveLength(50);
    expect(Math.min(...idx)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...idx)).toBeLessThan(50);
    // at least one consecutive pair survives — blocks, not iid draws
    expect(idx.some((v, i) => i > 0 && v === idx[i - 1]! + 1)).toBe(true);
  });

  it("degenerates safely when the block is longer than the series", () => {
    const idx = blockResampleIndices(5, 999, mulberry32(1));
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("stressTestCalibration", () => {
  const { closes, volZ, groups } = syntheticTape();

  it("fits every cell of the window × estimator grid", () => {
    const r = stressTestCalibration(closes, {
      groups, volZ, windows: [30, 60], estimators: ["pearson", "spearman"],
      resamples: 0, seed: 5,
    });
    expect(r.cells).toHaveLength(4);
    for (const c of r.cells) {
      expect(c.windowsFitted).toBeGreaterThan(0);
      expect(c.calmWithin).toBeGreaterThan(0);
      expect(c.calmWithin).toBeLessThanOrEqual(1);
      expect(c.separationWithin).toBeCloseTo(c.stressWithin - c.calmWithin, 12);
    }
  });

  it("recovers within > across coupling on a two-cluster tape", () => {
    const r = stressTestCalibration(closes, {
      groups, volZ, windows: [60], estimators: ["pearson"], resamples: 0, seed: 5,
    });
    const cell = r.cells[0]!;
    expect(cell.calmWithin).toBeGreaterThan(cell.calmAcross);
  });

  it("is deterministic for a given seed, including the bootstrap", () => {
    const opts = {
      groups, volZ, windows: [60], estimators: ["pearson" as const],
      resamples: 25, seed: 99,
    };
    const a = stressTestCalibration(closes, opts);
    const b = stressTestCalibration(closes, opts);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("bootstraps the baseline cell only by default", () => {
    const r = stressTestCalibration(closes, {
      groups, volZ, windows: [30, 60], estimators: ["pearson", "winsorized"],
      resamples: 20, baselineWindow: 60, baselineEstimator: "pearson", seed: 4,
    });
    const booted = r.cells.filter((c) => c.bootstrap);
    expect(booted).toHaveLength(1);
    expect(booted[0]!.window).toBe(60);
    expect(booted[0]!.estimator).toBe("pearson");
    const ci = booted[0]!.bootstrap!.calmWithin;
    expect(ci.lo).toBeLessThanOrEqual(ci.mean);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean);
    expect(booted[0]!.bootstrap!.separationPositiveShare).toBeGreaterThanOrEqual(0);
    expect(booted[0]!.bootstrap!.separationPositiveShare).toBeLessThanOrEqual(1);
  });

  it("bootstraps every cell when asked", () => {
    const r = stressTestCalibration(closes, {
      groups, volZ, windows: [60], estimators: ["pearson", "spearman"],
      resamples: 10, bootstrapBaselineOnly: false, seed: 4,
    });
    expect(r.cells.every((c) => c.bootstrap)).toBe(true);
  });

  it("reports axis spreads and a verdict, and formats without throwing", () => {
    const r = stressTestCalibration(closes, {
      groups, volZ, windows: [30, 60, 120], estimators: [...ALL_ESTIMATORS],
      resamples: 20, seed: 8,
    });
    expect(r.byWindow.map((a) => a.level)).toEqual(["30", "60", "120"]);
    expect(r.byEstimator.map((a) => a.level)).toEqual([...ALL_ESTIMATORS]);
    expect(r.gridRange.calmWithin).toBeGreaterThanOrEqual(0);
    expect(["stable", "window_sensitive", "estimator_sensitive", "fragile"])
      .toContain(r.verdict);
    expect(r.notes.length).toBeGreaterThan(0);
    const text = formatCalibrationRobustness(r);
    expect(text).toContain("Calibration stress test");
    expect(text).toContain("Verdict:");
  });

  it("flags outlier-driven coupling: Pearson sits above the robust estimators", () => {
    // Same tape plus a single synchronised crash bar in the middle.
    const spiked = new Map<string, number[]>();
    for (const [sym, series] of closes) {
      const copy = series.slice();
      const at = Math.floor(copy.length / 2);
      for (let i = at; i < copy.length; i++) copy[i] = copy[i]! * 0.7;
      spiked.set(sym, copy);
    }
    const r = stressTestCalibration(spiked, {
      groups, volZ, windows: [60], estimators: [...ALL_ESTIMATORS], resamples: 0, seed: 2,
    });
    const pearson = r.cells.find((c) => c.estimator === "pearson")!;
    const wins = r.cells.find((c) => c.estimator === "winsorized")!;
    expect(pearson.calmWithin).toBeGreaterThanOrEqual(wins.calmWithin - 0.05);
  });

  it("handles a tape with no stress bars without inventing a stress leg", () => {
    const calm = stressTestCalibration(closes, {
      groups, volZ: closes.get("AAPL")!.map(() => 0), windows: [60],
      estimators: ["pearson"], resamples: 0, seed: 1,
    });
    const cell = calm.cells[0]!;
    expect(cell.stressWindows).toBe(0);
    expect(Number.isNaN(cell.stressWithin)).toBe(true);
  });
});
