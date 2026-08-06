import { describe, expect, it } from "vitest";
import {
  annualisedPct,
  benchmarkIndex,
  buildRegimeReport,
  classifyRegimes,
  curveCagrPct,
  curveMaxDrawdownPct,
  dominantRegime,
  formatRegimeTable,
  formatWindowTable,
  median,
  segmentRegimes,
  stdev,
  summariseRegime,
  summariseReport,
  walkForwardWindows,
  type IndexPoint,
  type RegimeLabel,
  type WindowResult,
} from "../regime-walk-forward";

const day = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);

function ramp(n: number, from: number, to: number, offset = 0): IndexPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    date: day(offset + i),
    value: from + ((to - from) * i) / Math.max(1, n - 1),
  }));
}

describe("benchmarkIndex", () => {
  it("rebases an equal-weight basket to 100", () => {
    const idx = benchmarkIndex([
      { date: "2020-01-01", closes: { A: 50, B: 200 } },
      { date: "2020-01-02", closes: { A: 100, B: 200 } },
    ]);
    expect(idx[0]!.value).toBe(100);
    expect(idx[1]!.value).toBe(150); // A doubles, B flat
  });

  it("lets a late-listing symbol join without a jump", () => {
    const idx = benchmarkIndex([
      { date: "2020-01-01", closes: { A: 100 } },
      { date: "2020-01-02", closes: { A: 110, B: 500 } },
    ]);
    expect(idx[1]!.value).toBeCloseTo(105, 10); // B enters at ratio 1
  });

  it("ignores non-positive closes and handles an empty tape", () => {
    expect(benchmarkIndex([])).toEqual([]);
    const idx = benchmarkIndex([{ date: "2020-01-01", closes: { A: 0 } }]);
    expect(idx[0]!.value).toBe(100);
  });
});

describe("annualisedPct", () => {
  it("annualises a one-year doubling", () => {
    expect(annualisedPct(100, 200, 252)).toBeCloseTo(100, 6);
  });
  it("annualises a half-year move upward", () => {
    expect(annualisedPct(100, 120, 126)).toBeCloseTo(44, 0);
  });
  it("guards degenerate inputs", () => {
    expect(annualisedPct(0, 100, 252)).toBe(0);
    expect(annualisedPct(100, 100, 0)).toBe(0);
  });
});

describe("classifyRegimes", () => {
  it("labels a steady climb bull", () => {
    const labels = classifyRegimes(ramp(200, 100, 200));
    expect(labels.at(-1)).toBe("bull");
  });

  it("labels a steady slide bear", () => {
    const labels = classifyRegimes(ramp(200, 200, 120));
    expect(labels.at(-1)).toBe("bear");
  });

  it("labels a flat tape sideways", () => {
    const labels = classifyRegimes(ramp(200, 100, 101));
    expect(labels.at(-1)).toBe("sideways");
  });

  it("forces bear inside a deep drawdown even after a bounce", () => {
    const idx = [...ramp(80, 100, 100), ...ramp(40, 100, 70, 80), ...ramp(20, 70, 78, 120)];
    const labels = classifyRegimes(idx);
    expect(labels.at(-1)).toBe("bear"); // still ~22% below the peak
  });

  it("honours custom thresholds", () => {
    const idx = ramp(200, 100, 103); // ~+4%/yr on the trailing quarter
    expect(classifyRegimes(idx).at(-1)).toBe("sideways");
    expect(classifyRegimes(idx, { bullAnnualPct: 2 }).at(-1)).toBe("bull");
  });

  it("rejects invalid thresholds", () => {
    expect(() => classifyRegimes(ramp(10, 100, 100), { lookback: 0 })).toThrow();
    expect(() => classifyRegimes(ramp(10, 100, 100), { bullAnnualPct: -20 })).toThrow();
  });

  it("returns one label per bar", () => {
    expect(classifyRegimes(ramp(37, 100, 130))).toHaveLength(37);
  });
});

describe("segmentRegimes", () => {
  const idx = ramp(10, 100, 110);

  it("collapses runs into contiguous segments", () => {
    const labels: RegimeLabel[] = [
      "bull", "bull", "bull", "bull", "bull",
      "bear", "bear", "bear", "bear", "bear",
    ];
    const segs = segmentRegimes(idx, labels, 1);
    expect(segs.map((s) => [s.label, s.bars])).toEqual([["bull", 5], ["bear", 5]]);
    expect(segs[1]!.from).toBe(idx[5]!.date);
    expect(segs[1]!.to).toBe(idx[9]!.date);
  });

  it("absorbs flickers shorter than the minimum", () => {
    const labels: RegimeLabel[] = [
      "bull", "bull", "bull", "bull", "sideways",
      "bull", "bull", "bull", "bull", "bull",
    ];
    const segs = segmentRegimes(idx, labels, 3);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.bars).toBe(10);
  });

  it("rejects a length mismatch", () => {
    expect(() => segmentRegimes(idx, ["bull"], 1)).toThrow();
  });
});

describe("walkForwardWindows", () => {
  it("produces non-overlapping out-of-sample slices by default", () => {
    const w = walkForwardWindows(1000, { trainBars: 252, testBars: 126 });
    expect(w[0]).toMatchObject({ trainStart: 0, testStart: 252, testEnd: 378 });
    expect(w[1]!.testStart).toBe(378);
    expect(w.at(-1)!.testEnd).toBeLessThanOrEqual(1000);
  });

  it("honours a custom step for overlapping windows", () => {
    const w = walkForwardWindows(1000, { trainBars: 252, testBars: 126, step: 63 });
    expect(w[1]!.testStart - w[0]!.testStart).toBe(63);
  });

  it("returns nothing when the history is too short", () => {
    expect(walkForwardWindows(100, { trainBars: 252, testBars: 126 })).toEqual([]);
  });

  it("validates its inputs", () => {
    expect(() => walkForwardWindows(100, { trainBars: -1, testBars: 10 })).toThrow();
    expect(() => walkForwardWindows(100, { trainBars: 10, testBars: 0 })).toThrow();
    expect(() => walkForwardWindows(100, { trainBars: 10, testBars: 10, step: 0 })).toThrow();
  });
});

describe("dominantRegime", () => {
  const labels: RegimeLabel[] = ["bull", "bull", "bull", "sideways", "bear"];

  it("takes the majority label and reports purity", () => {
    const d = dominantRegime(labels, 0, 5);
    expect(d.label).toBe("bull");
    expect(d.purity).toBeCloseTo(0.6, 10);
  });

  it("breaks ties towards bear", () => {
    expect(dominantRegime(["bull", "bear"], 0, 2).label).toBe("bear");
  });

  it("handles an empty range", () => {
    expect(dominantRegime(labels, 2, 2)).toEqual({ label: "sideways", purity: 0 });
  });
});

describe("curve metrics", () => {
  const curve = [
    { snapshot_date: "2020-01-01", total_value: 100 },
    { snapshot_date: "2020-01-02", total_value: 80 },
    { snapshot_date: "2020-01-03", total_value: 120 },
  ];

  it("computes net CAGR from the curve endpoints", () => {
    expect(curveCagrPct(curve, 2)).toBeCloseTo(annualisedPct(100, 120, 2, 2), 10);
  });

  it("computes max drawdown as a negative percentage", () => {
    expect(curveMaxDrawdownPct(curve)).toBeCloseTo(-20, 10);
  });

  it("guards a one-point curve", () => {
    expect(curveCagrPct([curve[0]!])).toBe(0);
  });
});

describe("statistics", () => {
  it("medians even and odd samples", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("computes a sample standard deviation", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([5])).toBe(0);
  });
});

function win(
  index: number,
  regime: RegimeLabel,
  netCagrPct: number,
  maxDrawdownPct: number,
  benchmarkCagrPct = 5,
): WindowResult {
  return {
    window: { index, trainStart: 0, trainEnd: 252, testStart: 252, testEnd: 378 },
    regime,
    purity: 0.9,
    from: day(index),
    to: day(index + 126),
    netCagrPct,
    maxDrawdownPct,
    benchmarkCagrPct,
    trades: 40,
    tradesPerYear: 32,
    feeDragPct: 1.5,
    sharpe: 0.7,
  };
}

describe("summariseRegime", () => {
  const bulls = [win(0, "bull", 18, -8), win(1, "bull", 12, -11), win(2, "bull", 22, -6)];

  it("aggregates CAGR, drawdown and stability", () => {
    const s = summariseRegime("bull", bulls);
    expect(s.windows).toBe(3);
    expect(s.medianNetCagrPct).toBe(18);
    expect(s.worstNetCagrPct).toBe(12);
    expect(s.worstMaxDrawdownPct).toBe(-11);
    expect(s.cagrStdPct).toBeGreaterThan(0);
    expect(s.positiveRate).toBe(1);
    expect(s.beatBenchmarkRate).toBe(1);
    expect(s.pass).toBe(true);
  });

  it("fails a regime that breaches the drawdown ceiling", () => {
    const s = summariseRegime("bear", [win(0, "bear", 4, -31)], { maxDrawdownPct: 25 });
    expect(s.drawdownStable).toBe(false);
    expect(s.pass).toBe(false);
  });

  it("fails a regime whose median CAGR is negative", () => {
    const s = summariseRegime("sideways", [win(0, "sideways", -3, -9), win(1, "sideways", -5, -7)]);
    expect(s.drawdownStable).toBe(true);
    expect(s.pass).toBe(false);
    expect(s.positiveRate).toBe(0);
  });

  it("fails a regime that is profitable too rarely", () => {
    const rows = [win(0, "bear", 30, -10), win(1, "bear", -2, -10), win(2, "bear", -3, -10)];
    expect(summariseRegime("bear", rows).pass).toBe(false);
  });

  it("returns an empty, non-passing summary when the regime never occurred", () => {
    const s = summariseRegime("bear", bulls);
    expect(s.windows).toBe(0);
    expect(s.pass).toBe(false);
  });

  it("is sign-insensitive about the stored drawdown", () => {
    expect(summariseRegime("bull", [win(0, "bull", 10, 31)], { maxDrawdownPct: 25 }).pass).toBe(false);
  });
});

describe("buildRegimeReport", () => {
  it("calls a strategy stable when every covered regime passes", () => {
    const r = buildRegimeReport([win(0, "bull", 15, -9), win(1, "bear", 6, -12), win(2, "sideways", 3, -7)]);
    expect(r.verdict).toBe("stable");
    expect(r.failed).toEqual([]);
    expect(r.covered).toEqual(["bull", "bear", "sideways"]);
    expect(r.worstDrawdownPct).toBe(-12);
  });

  it("calls it regime-dependent when only some regimes pass", () => {
    const r = buildRegimeReport([win(0, "bull", 25, -9), win(1, "bear", -14, -30)]);
    expect(r.verdict).toBe("regime-dependent");
    expect(r.failed).toEqual(["bear"]);
    expect(r.cagrDispersionPct).toBeCloseTo(39, 10);
  });

  it("calls it unstable when every covered regime fails", () => {
    const r = buildRegimeReport([win(0, "bull", -5, -30), win(1, "bear", -12, -40)]);
    expect(r.verdict).toBe("unstable");
  });

  it("handles no windows at all", () => {
    const r = buildRegimeReport([]);
    expect(r.covered).toEqual([]);
    expect(r.verdict).toBe("stable");
    expect(r.worstDrawdownPct).toBe(0);
  });
});

describe("formatting", () => {
  const results = [win(0, "bull", 15, -9), win(1, "bear", -14, -30)];
  const report = buildRegimeReport(results);

  it("renders one row per regime with a verdict cell", () => {
    const lines = formatRegimeTable(report.summaries).split("\n");
    expect(lines).toHaveLength(4); // header + 3 regimes
    expect(lines[2]).toMatch(/drawdown breach/);
    expect(lines[3]).toMatch(/no data/);
  });

  it("renders one row per walk-forward window", () => {
    expect(formatWindowTable(results).split("\n")).toHaveLength(3);
  });

  it("summarises the report in one line", () => {
    const s = summariseReport(report);
    expect(s).toContain("regime-dependent");
    expect(s).toContain("failed in bear");
    expect(s).toContain("-25% ceiling");
  });
});
