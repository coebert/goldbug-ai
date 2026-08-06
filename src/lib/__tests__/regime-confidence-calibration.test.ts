import { describe, it, expect } from "vitest";
import { classifyRegimeBars, type IndexPoint, type RegimeBar } from "../regime-walk-forward";
import {
  applyCalibration,
  buildRegimeSamples,
  calibrateRegimeConfidence,
  fitConfidenceCalibrator,
  identityCalibrator,
  MIN_CALIBRATION_SAMPLES,
  realizedRegime,
  reliabilityReport,
  type CalibrationSample,
} from "../regime-confidence-calibration";

const day = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: readonly number[]): IndexPoint[] =>
  values.map((value, i) => ({ date: day(i), value }));

const ramp = (n: number, from: number, to: number) =>
  series(Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1)));

const sample = (stated: number, correct: boolean, index = 0): CalibrationSample => ({
  index,
  date: day(index),
  stated,
  label: "bull",
  realized: correct ? "bull" : "bear",
  correct,
  forwardPct: correct ? 10 : -10,
});

describe("realizedRegime", () => {
  const idx = series([100, 101, 102, 110, 90]);

  it("labels the forward move with the classifier vocabulary", () => {
    expect(realizedRegime(idx, 0, { horizonBars: 3, bandPct: 3 })).toEqual({
      label: "bull",
      forwardPct: 10,
    });
    expect(realizedRegime(idx, 1, { horizonBars: 3, bandPct: 3 })?.label).toBe("bear");
    expect(realizedRegime(idx, 0, { horizonBars: 1, bandPct: 3 })?.label).toBe("sideways");
  });

  it("returns null when the horizon runs past the tape", () => {
    expect(realizedRegime(idx, 4, { horizonBars: 1 })).toBeNull();
    expect(realizedRegime(idx, 0, { horizonBars: 99 })).toBeNull();
  });

  it("rejects nonsense options", () => {
    expect(() => realizedRegime(idx, 0, { horizonBars: 0 })).toThrow(/horizonBars/);
    expect(() => realizedRegime(idx, 0, { bandPct: -1 })).toThrow(/bandPct/);
  });
});

describe("buildRegimeSamples", () => {
  it("scores only bars with a full forward horizon", () => {
    const idx = ramp(40, 100, 160);
    const bars = classifyRegimeBars(idx);
    const samples = buildRegimeSamples(bars, idx, { horizonBars: 10, bandPct: 3 });
    expect(samples.length).toBe(30);
    expect(samples.every((s) => s.stated >= 0 && s.stated <= 1)).toBe(true);
    expect(samples.every((s) => s.correct === (s.label === s.realized))).toBe(true);
  });

  it("marks a rising tape's bull calls correct", () => {
    const idx = ramp(80, 100, 220);
    const bars = classifyRegimeBars(idx);
    const samples = buildRegimeSamples(bars, idx, { horizonBars: 10, bandPct: 2 });
    const bull = samples.filter((s) => s.label === "bull");
    expect(bull.length).toBeGreaterThan(0);
    expect(bull.filter((s) => s.correct).length / bull.length).toBeGreaterThan(0.9);
  });
});

describe("reliabilityReport", () => {
  it("reports empty stats with no samples", () => {
    const r = reliabilityReport([]);
    expect(r.n).toBe(0);
    expect(r.ece).toBeNull();
    expect(r.brier).toBeNull();
    expect(r.verdict).toBe("unknown");
    expect(r.bins.every((b) => b.n === 0)).toBe(true);
  });

  it("scores a perfectly calibrated set near zero error", () => {
    // Stated 0.5 with a 50% hit-rate, stated 0.9 with a 90% hit-rate.
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample(0.5, i < 5, i)),
      ...Array.from({ length: 10 }, (_, i) => sample(0.9, i < 9, 10 + i)),
    ];
    const r = reliabilityReport(samples);
    expect(r.n).toBe(20);
    expect(r.ece!).toBeLessThan(0.02);
    expect(r.mce!).toBeLessThan(0.02);
    expect(r.verdict).toBe("well-calibrated");
  });

  it("flags overconfidence and underconfidence", () => {
    const over = reliabilityReport(Array.from({ length: 20 }, (_, i) => sample(0.9, i < 4, i)));
    expect(over.verdict).toBe("overconfident");
    expect(over.ece!).toBeGreaterThan(0.5);

    const under = reliabilityReport(Array.from({ length: 20 }, (_, i) => sample(0.2, i < 18, i)));
    expect(under.verdict).toBe("underconfident");
  });

  it("computes the Brier score against the 0/1 outcome", () => {
    const r = reliabilityReport([sample(1, true, 0), sample(0, false, 1), sample(0.5, true, 2)]);
    expect(r.brier).toBeCloseTo((0 + 0 + 0.25) / 3, 10);
  });

  it("needs at least two edges", () => {
    expect(() => reliabilityReport([], [0.5])).toThrow(/edges/);
  });
});

describe("fitConfidenceCalibrator", () => {
  it("falls back to identity below the sample floor", () => {
    const c = fitConfidenceCalibrator([sample(0.9, false, 0)]);
    expect(c.identity).toBe(true);
    expect(c.calibrate(0.9)).toBe(0.9);
    expect(identityCalibrator().calibrate(0.42)).toBe(0.42);
  });

  it("pulls a chronically overconfident score down to observed accuracy", () => {
    // 40 bars all stated at 0.9, only a quarter of them right.
    const samples = Array.from({ length: 40 }, (_, i) => sample(0.9, i % 4 === 0, i));
    const c = fitConfidenceCalibrator(samples);
    expect(c.identity).toBe(false);
    expect(c.calibrate(0.9)).toBeCloseTo(0.25, 6);
  });

  it("stays monotone non-decreasing", () => {
    const samples = Array.from({ length: 60 }, (_, i) => {
      const stated = (i % 10) / 10;
      // Noisy but broadly increasing accuracy.
      return sample(stated, i % 10 >= 4 ? i % 3 !== 0 : i % 5 === 0, i);
    });
    const c = fitConfidenceCalibrator(samples);
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = c.calibrate(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    for (let i = 1; i < c.knots.length; i++) {
      expect(c.knots[i]!.y).toBeGreaterThanOrEqual(c.knots[i - 1]!.y - 1e-12);
    }
  });

  it("separates a low-confidence cohort from a high-confidence one", () => {
    const samples = [
      ...Array.from({ length: 30 }, (_, i) => sample(0.3, i % 10 === 0, i)), // 10% right
      ...Array.from({ length: 30 }, (_, i) => sample(0.8, i % 10 !== 0, 30 + i)), // 90% right
    ];
    const c = fitConfidenceCalibrator(samples);
    expect(c.calibrate(0.3)).toBeCloseTo(0.1, 6);
    expect(c.calibrate(0.8)).toBeCloseTo(0.9, 6);
    // Between the cohorts the map interpolates, never jumps outside the range.
    const mid = c.calibrate(0.55);
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
    // Outside the observed range it clamps to the end blocks.
    expect(c.calibrate(0)).toBeCloseTo(0.1, 6);
    expect(c.calibrate(1)).toBeCloseTo(0.9, 6);
  });

  it("is deterministic for the same samples", () => {
    const samples = Array.from({ length: 50 }, (_, i) => sample((i % 5) / 5, i % 3 === 0, i));
    const a = fitConfidenceCalibrator(samples);
    const b = fitConfidenceCalibrator([...samples].reverse());
    expect(a.knots).toEqual(b.knots);
  });
});

describe("applyCalibration", () => {
  it("keeps the stated score alongside the calibrated one", () => {
    const bars: RegimeBar[] = [
      {
        index: 0,
        date: day(0),
        label: "bull",
        confidence: 0.9,
        trendPct: 30,
        r2: 0.9,
        drawdownPct: 0,
        rangePct: 5,
        reason: "test",
      },
    ];
    const samples = Array.from({ length: 40 }, (_, i) => sample(0.9, i % 4 === 0, i));
    const out = applyCalibration(bars, fitConfidenceCalibrator(samples));
    expect(out[0]!.statedConfidence).toBe(0.9);
    expect(out[0]!.calibratedConfidence).toBeCloseTo(0.25, 6);
    expect(out[0]!.confidence).toBe(out[0]!.calibratedConfidence);
    expect(out[0]!.label).toBe("bull");
  });
});

describe("calibrateRegimeConfidence", () => {
  it("never makes reliability worse on the fitted tape", () => {
    // A tape that trends up, then rolls over — the heuristic is confident on
    // both legs, but only right on some of them.
    const idx = series([
      ...Array.from({ length: 60 }, (_, i) => 100 + i * 1.5),
      ...Array.from({ length: 60 }, (_, i) => 190 - i * 1.2),
    ]);
    const bars = classifyRegimeBars(idx);
    const res = calibrateRegimeConfidence(bars, idx, { horizonBars: 10, bandPct: 3 });

    expect(res.samples.length).toBe(idx.length - 10);
    expect(res.calibrator.identity).toBe(false);
    expect(res.after.ece!).toBeLessThanOrEqual(res.before.ece! + 1e-9);
    expect(res.after.brier!).toBeLessThanOrEqual(res.before.brier! + 1e-9);
    expect(res.bars.length).toBe(bars.length);
    expect(res.horizonBars).toBe(10);
  });

  it("maps calibrated confidence onto the observed accuracy of its cohort", () => {
    const idx = series([
      ...Array.from({ length: 70 }, (_, i) => 100 + i * 1.5),
      ...Array.from({ length: 70 }, (_, i) => 205 - i * 1.4),
    ]);
    const bars = classifyRegimeBars(idx);
    const res = calibrateRegimeConfidence(bars, idx, { horizonBars: 15, bandPct: 3 });

    // Per stated cohort, the calibrated value IS that cohort's hit-rate.
    const cohorts = new Map<number, { hits: number; n: number }>();
    for (const s of res.samples) {
      const g = cohorts.get(s.stated) ?? { hits: 0, n: 0 };
      g.hits += s.correct ? 1 : 0;
      g.n += 1;
      cohorts.set(s.stated, g);
    }
    let matched = 0;
    for (const [stated, g] of cohorts) {
      if (g.n < 5) continue;
      matched++;
      // Isotonic only departs from the raw rate where monotonicity forces it.
      expect(Math.abs(res.calibrator.calibrate(stated) - g.hits / g.n)).toBeLessThan(0.35);
    }
    expect(matched).toBeGreaterThan(0);
    // Aggregate reliability improves.
    expect(res.after.ece!).toBeLessThan(res.before.ece!);
    expect(Math.abs(res.after.meanStated! - res.after.accuracy!)).toBeLessThan(0.06);
  });

  it("leaves confidence untouched when the tape is too short to fit", () => {
    const idx = ramp(12, 100, 110);
    const bars = classifyRegimeBars(idx);
    const res = calibrateRegimeConfidence(bars, idx, { horizonBars: 5, bandPct: 3 });
    expect(res.samples.length).toBeLessThan(MIN_CALIBRATION_SAMPLES);
    expect(res.calibrator.identity).toBe(true);
    expect(res.bars.map((b) => b.confidence)).toEqual(bars.map((b) => b.confidence));
  });
});
