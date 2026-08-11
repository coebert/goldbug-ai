import { describe, expect, it } from "vitest";
import {
  classifyRegimes,
  fitRegimeClassifier,
  formatRegimeBacktest,
  quantileOf,
  regimeBacktestReport,
  regimeSegments,
  regimeSeparation,
  type RegimeArmMetrics,
} from "../execution-regime-classifier";

/** Calm run, loud burst, calm run. */
const tape = (): number[] => [
  ...Array(60).fill(0).map((_, i) => (i % 2 ? 0.1 : -0.1)),
  ...Array(20).fill(3),
  ...Array(40).fill(0).map((_, i) => (i % 2 ? 0.2 : -0.2)),
];

describe("quantileOf", () => {
  it("interpolates between order statistics and clamps q", () => {
    expect(quantileOf([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 9);
    expect(quantileOf([1, 2, 3, 4], 0)).toBe(1);
    expect(quantileOf([1, 2, 3, 4], 2)).toBe(4);
    expect(Number.isNaN(quantileOf([], 0.5))).toBe(true);
  });
});

describe("fitRegimeClassifier", () => {
  it("puts the entry threshold at the train quantile and exits lower", () => {
    const clf = fitRegimeClassifier(tape(), { stressQuantile: 0.9, hysteresis: 0.4 });
    expect(clf.enterZ).toBeCloseTo(quantileOf(tape(), 0.9), 9);
    expect(clf.exitZ).toBeCloseTo(clf.enterZ - 0.4, 9);
    expect(clf.trainStressShare).toBeGreaterThan(0);
    expect(clf.trainStressShare).toBeLessThan(30);
  });

  it("labels almost nothing rather than everything on a degenerate train window", () => {
    const clf = fitRegimeClassifier(Array(50).fill(0.5), { hysteresis: 0 });
    const labels = classifyRegimes(clf, Array(50).fill(0.4));
    expect(labels.some(Boolean)).toBe(false);
  });

  it("never looks at bars outside the sample it was given", () => {
    const train = tape().slice(0, 60); // calm only
    const clf = fitRegimeClassifier(train, { stressQuantile: 0.85 });
    // A future burst is far above a threshold learned on calm bars.
    expect(clf.enterZ).toBeLessThan(1);
    const future = classifyRegimes(clf, Array(20).fill(3));
    expect(future.every(Boolean)).toBe(true);
  });
});

describe("classifyRegimes", () => {
  it("uses hysteresis so a dip below entry does not immediately exit", () => {
    const clf = fitRegimeClassifier([0, 1], { stressQuantile: 1, hysteresis: 1, minRunBars: 1 });
    // enter at 1, exit below 0
    const labels = classifyRegimes(clf, [0, 1, 0.5, 0.2, -0.5, 0.9]);
    expect(labels).toEqual([false, true, true, true, false, false]);
  });

  it("absorbs runs shorter than minRunBars", () => {
    const clf = fitRegimeClassifier([0, 1], { stressQuantile: 1, hysteresis: 1, minRunBars: 4 });
    const labels = classifyRegimes(clf, [0, 0, 0, 0, 1, -2, 0, 0, 0, 0]);
    expect(labels.every((v) => v === false)).toBe(true);
  });

  it("finds the burst in a calm-loud-calm tape", () => {
    const z = tape();
    const clf = fitRegimeClassifier(z, { stressQuantile: 0.85, hysteresis: 0.5, minRunBars: 3 });
    const labels = classifyRegimes(clf, z);
    expect(labels.slice(0, 60).some(Boolean)).toBe(false);
    expect(labels.slice(60, 80).every(Boolean)).toBe(true);
  });
});

describe("regimeSegments", () => {
  it("returns contiguous absolute windows and drops short ones", () => {
    const labels = [false, false, false, true, true, false, false, false];
    expect(regimeSegments(labels, 100, 3)).toEqual([
      { regime: "calm", start: 100, end: 102, bars: 3 },
      { regime: "calm", start: 105, end: 107, bars: 3 },
    ]);
    expect(regimeSegments(labels, 100, 1)).toHaveLength(3);
  });
});

describe("regimeSeparation", () => {
  it("reports a large standardised gap when the labels track the tape", () => {
    const z = tape();
    const clf = fitRegimeClassifier(z, { stressQuantile: 0.85 });
    const sep = regimeSeparation(classifyRegimes(clf, z), z);
    expect(sep.stressBars).toBe(20);
    expect(sep.separation).toBeGreaterThan(2);
    expect(sep.meanZStress).toBeGreaterThan(sep.meanZCalm);
    expect(sep.transitions).toBe(2);
    expect(sep.meanStressRunBars).toBe(20);
  });

  it("reports ~0 separation when labels are unrelated to vol", () => {
    const z = Array(100).fill(0).map((_, i) => Math.sin(i));
    const labels = z.map((_, i) => i < 50);
    expect(Math.abs(regimeSeparation(labels, z).separation)).toBeLessThan(0.5);
  });
});

describe("regimeBacktestReport", () => {
  const row = (
    arm: string,
    regime: "calm" | "stress",
    cvar: number,
    ret = 1,
  ): RegimeArmMetrics => ({
    arm,
    regime,
    bars: regime === "calm" ? 800 : 120,
    segments: 4,
    returnPer100Bars: ret,
    cvar5Per100Bars: cvar,
    worstDrawdownPct: -10,
    breachProb: 0.1,
    costPer100Bars: 50,
  });

  const clf = fitRegimeClassifier(tape());
  const sep = regimeSeparation(classifyRegimes(clf, tape()), tape());

  it("differences every arm against the baseline within each regime", () => {
    const report = regimeBacktestReport(
      clf,
      sep,
      [
        row("fixed-global", "calm", -2),
        row("fixed-global", "stress", -8),
        row("calib-contagion", "calm", -2.05),
        row("calib-contagion", "stress", -11),
      ],
      "fixed-global",
    );
    expect(report.edges).toHaveLength(2);
    const stress = report.edges.find((e) => e.regime === "stress")!;
    expect(stress.cvar5Edge).toBeCloseTo(-3, 9);
    expect(report.edges.find((e) => e.regime === "calm")!.cvar5Edge).toBeCloseTo(-0.05, 9);
  });

  it("scores an arm as stress-only when its edge concentrates there", () => {
    const report = regimeBacktestReport(
      clf,
      sep,
      [
        row("fixed-global", "calm", -2),
        row("fixed-global", "stress", -8),
        row("calib-contagion", "calm", -2.05),
        row("calib-contagion", "stress", -11),
      ],
      "fixed-global",
    );
    const edge = report.stressOnlyEdge.find((e) => e.arm === "calib-contagion")!;
    expect(edge.value).toBeCloseTo(2.95, 9);
    expect(formatRegimeBacktest(report)).toContain("matters when the tape is loud");
  });

  it("calls a sub-threshold edge immaterial instead of claiming concentration", () => {
    const report = regimeBacktestReport(
      clf,
      sep,
      [
        row("fixed-global", "calm", -2),
        row("fixed-global", "stress", -8),
        row("calib-contagion", "calm", -2.001),
        row("calib-contagion", "stress", -8.02),
      ],
      "fixed-global",
    );
    const text = formatRegimeBacktest(report);
    expect(text).toContain("immaterial in both regimes");
    expect(text).not.toContain("matters when the tape is loud");
  });

  it("skips arms missing a regime instead of emitting NaN edges", () => {
    const report = regimeBacktestReport(
      clf,
      sep,
      [row("fixed-global", "calm", -2), row("calib-contagion", "stress", -11)],
      "fixed-global",
    );
    expect(report.edges).toHaveLength(0);
  });

  it("warns in the printout when the split is not separable", () => {
    const flat = Array(100).fill(0).map((_, i) => Math.sin(i));
    const weak = regimeSeparation(flat.map((_, i) => i < 50), flat);
    const text = formatRegimeBacktest(
      regimeBacktestReport(clf, weak, [row("fixed-global", "calm", -2)], "fixed-global"),
    );
    expect(text).toContain("too weak to read the tables below");
  });
});
