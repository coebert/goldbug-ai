// Sideways coverage + confidence scoring for the walk-forward regime tagger.
import { describe, it, expect } from "vitest";
import {
  classifyRegimeBars,
  dominantRegimeWeighted,
  rangeWidthPct,
  regimeCoverage,
  trendR2,
  type IndexPoint,
} from "../regime-walk-forward";

const day = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: readonly number[]): IndexPoint[] =>
  values.map((value, i) => ({ date: day(i), value }));

const ramp = (n: number, from: number, to: number) =>
  series(Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1)));

/** Flat level with a deterministic saw-tooth wobble of ±`amp`%. */
const chop = (n: number, level: number, ampPct: number) =>
  series(Array.from({ length: n }, (_, i) => level * (1 + (ampPct / 100) * (i % 4 < 2 ? 1 : -1))));

describe("trendR2 / rangeWidthPct", () => {
  it("scores a clean ramp near 1 and a saw-tooth near 0", () => {
    expect(trendR2(ramp(120, 100, 200).map((p) => p.value))).toBeGreaterThan(0.98);
    expect(trendR2(chop(120, 100, 3).map((p) => p.value))).toBeLessThan(0.2);
  });
  it("measures peak-to-trough range as a share of the mean", () => {
    expect(rangeWidthPct([100, 104, 96])).toBeCloseTo(8, 6);
    expect(rangeWidthPct([100])).toBe(0);
  });
});

describe("classifyRegimeBars — sideways coverage", () => {
  it("calls a tight range sideways with high confidence", () => {
    const bars = classifyRegimeBars(chop(150, 100, 2));
    const last = bars.at(-1)!;
    expect(last.label).toBe("sideways");
    expect(last.confidence).toBeGreaterThan(0.6);
  });

  it("calls a slow drift inside the band sideways, not bull", () => {
    // ~4%/yr over a year — positive, but inside the ±6% chop band.
    const bars = classifyRegimeBars(ramp(252, 100, 104));
    expect(bars.at(-1)!.label).toBe("sideways");
    expect(bars.at(-1)!.reason).toContain("band");
  });

  it("refuses a directional label when the path has no trend structure", () => {
    // Big swings that end well above the window start: return says bull,
    // path says chop. R² gate must demote it.
    const values: number[] = [];
    for (let i = 0; i < 150; i++) values.push(100 + (i % 6 < 3 ? 22 : -18) + i * 0.02);
    const bars = classifyRegimeBars(series(values));
    const last = bars.at(-1)!;
    expect(last.r2).toBeLessThan(0.35);
    expect(last.label).toBe("sideways");
    expect(last.confidence).toBeLessThan(0.85);
  });

  it("still labels strong trends, with confidence rising in the strength", () => {
    const bull = classifyRegimeBars(ramp(252, 100, 200)).at(-1)!;
    const mild = classifyRegimeBars(ramp(252, 100, 118)).at(-1)!;
    expect(bull.label).toBe("bull");
    expect(mild.label).toBe("bull");
    expect(bull.confidence).toBeGreaterThan(mild.confidence);

    const bear = classifyRegimeBars(ramp(252, 200, 120)).at(-1)!;
    expect(bear.label).toBe("bear");
    expect(bear.confidence).toBeGreaterThan(0.5);
  });

  it("keeps the deep-drawdown override ahead of every other test", () => {
    const idx = series([...Array.from({ length: 80 }, () => 200), ...Array.from({ length: 40 }, () => 150)]);
    const last = classifyRegimeBars(idx).at(-1)!;
    expect(last.label).toBe("bear");
    expect(last.reason).toContain("drawdown");
    expect(last.confidence).toBeGreaterThan(0.6);
  });

  it("produces all three regimes over a bull → chop → bear tape", () => {
    const idx = series([
      ...ramp(200, 100, 190).map((p) => p.value),
      ...chop(150, 190, 2).map((p) => p.value),
      ...ramp(200, 190, 120).map((p) => p.value),
    ]);
    const cov = regimeCoverage(classifyRegimeBars(idx));
    expect(cov.bull.bars).toBeGreaterThan(0);
    expect(cov.bear.bars).toBeGreaterThan(0);
    expect(cov.sideways.share).toBeGreaterThan(0.1);
    expect(cov.bull.share + cov.bear.share + cov.sideways.share).toBeCloseTo(1, 9);
  });

  it("validates thresholds", () => {
    expect(() => classifyRegimeBars(ramp(10, 100, 100), { sidewaysBandPct: -1 })).toThrow();
    expect(() => classifyRegimeBars(ramp(10, 100, 100), { minTrendR2: 2 })).toThrow();
  });
});

describe("dominantRegimeWeighted", () => {
  const bar = (label: "bull" | "bear" | "sideways", confidence: number, i = 0) => ({
    index: i,
    date: day(i),
    label,
    confidence,
    trendPct: 0,
    r2: 0,
    drawdownPct: 0,
    rangePct: 0,
    reason: "",
  });

  it("returns sideways for an empty range", () => {
    const d = dominantRegimeWeighted([], 0, 0);
    expect(d).toMatchObject({ label: "sideways", purity: 0, confidence: 0, demoted: false });
  });

  it("lets high-confidence chop beat a marginal bull plurality", () => {
    const bars = [
      bar("bull", 0.46),
      bar("bull", 0.46),
      bar("sideways", 0.95),
      bar("sideways", 0.95),
    ];
    expect(dominantRegimeWeighted(bars, 0, 4).label).toBe("sideways");
  });

  it("demotes a weak directional win to sideways and flags it", () => {
    const bars = [bar("bull", 0.3), bar("bull", 0.3), bar("sideways", 0.4), bar("bear", 0.4)];
    const d = dominantRegimeWeighted(bars, 0, 4);
    expect(d.label).toBe("sideways");
    expect(d.demoted).toBe(true);
  });

  it("keeps a confident directional win", () => {
    const bars = [bar("bull", 0.9), bar("bull", 0.9), bar("bull", 0.8), bar("sideways", 0.5)];
    const d = dominantRegimeWeighted(bars, 0, 4);
    expect(d.label).toBe("bull");
    expect(d.demoted).toBe(false);
    expect(d.confidence).toBeCloseTo((0.9 + 0.9 + 0.8) / 3, 9);
    expect(d.purity).toBeCloseTo(0.75, 9);
    expect(d.shares.bull + d.shares.bear + d.shares.sideways).toBeCloseTo(1, 9);
  });

  it("can fall back to an unweighted majority", () => {
    const bars = [bar("bull", 0.6), bar("bull", 0.6), bar("sideways", 0.99)];
    expect(dominantRegimeWeighted(bars, 0, 3, { weightByConfidence: false }).label).toBe("bull");
  });
});
