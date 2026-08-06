import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_SPACE,
  SIDEWAYS_BEAR_SPACE,
  TUNABLE_KEYS,
  forwardReturnsPct,
  formatRegimeTuning,
  gridSearchRegimeThresholds,
  labelFlipRate,
  scoreRegimeThresholds,
  searchRegimeThresholds,
  tuneRegimeThresholds,
} from "@/lib/regime-threshold-search";
import {
  classifyRegimeBars,
  DEFAULT_REGIME_THRESHOLDS,
  type IndexPoint,
} from "@/lib/regime-walk-forward";

/** Deterministic PRNG so the synthetic tape is byte-stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const day = (i: number) => new Date(Date.UTC(2018, 0, 1 + i)).toISOString().slice(0, 10);

/**
 * A tape with three unmistakable acts: a smooth bull leg, a deep bear leg,
 * then a tight range. Any sane threshold set should separate these.
 */
function threeActTape(seed = 4242): IndexPoint[] {
  const rand = rng(seed);
  const out: IndexPoint[] = [];
  let v = 100;
  const push = (drift: number, vol: number, bars: number) => {
    for (let i = 0; i < bars; i++) {
      v *= 1 + drift + (rand() - 0.5) * vol;
      out.push({ date: day(out.length), value: v });
    }
  };
  push(0.0016, 0.004, 320); // bull
  push(-0.0022, 0.008, 260); // bear
  push(0.0, 0.003, 300); // chop
  push(0.0014, 0.004, 220); // bull again
  push(-0.0018, 0.007, 200); // bear again
  return out;
}

const TAPE = threeActTape();

describe("regime threshold scoring", () => {
  it("computes forward returns and stops at the end of the tape", () => {
    const fwd = forwardReturnsPct(TAPE, 21);
    expect(fwd).toHaveLength(TAPE.length);
    expect(fwd.at(-1)).toBeNull();
    expect(fwd[0]).toBeCloseTo((TAPE[21]!.value / TAPE[0]!.value - 1) * 100, 9);
  });

  it("measures label flicker", () => {
    const bars = classifyRegimeBars(TAPE, DEFAULT_REGIME_THRESHOLDS);
    const rate = labelFlipRate(bars);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThan(1);
    expect(labelFlipRate([])).toBe(0);
  });

  it("scores the default thresholds with usable per-regime statistics", () => {
    const s = scoreRegimeThresholds(TAPE, DEFAULT_REGIME_THRESHOLDS);
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.scoredBars).toBeGreaterThan(500);
    const shares = s.stats.bull.share + s.stats.bear.share + s.stats.sideways.share;
    expect(shares).toBeCloseTo(1, 9);
    expect(s.stats.bear.meanForwardPct).toBeLessThan(s.stats.bull.meanForwardPct);
  });

  it("punishes a threshold set that labels the whole tape sideways", () => {
    const degenerate = {
      ...DEFAULT_REGIME_THRESHOLDS,
      bullAnnualPct: 500,
      bearAnnualPct: -500,
      bearDrawdownPct: 99,
      sidewaysRangePct: 1_000,
    };
    const s = scoreRegimeThresholds(TAPE, degenerate);
    expect(s.stats.sideways.share).toBe(1);
    expect(s.coverageShortfall).toBeGreaterThan(0.1);
    expect(s.score).toBeLessThan(scoreRegimeThresholds(TAPE, DEFAULT_REGIME_THRESHOLDS).score);
  });

  it("returns an infeasible score for invalid or empty inputs", () => {
    expect(scoreRegimeThresholds([], DEFAULT_REGIME_THRESHOLDS).score).toBe(-Infinity);
    const invalid = { ...DEFAULT_REGIME_THRESHOLDS, bearAnnualPct: 20, bullAnnualPct: 10 };
    expect(scoreRegimeThresholds(TAPE, invalid).score).toBe(-Infinity);
  });
});

describe("parameterized search", () => {
  it("coordinate descent never returns worse than the baseline", () => {
    const res = searchRegimeThresholds(TAPE, { space: SIDEWAYS_BEAR_SPACE });
    expect(res.improvement).toBeGreaterThanOrEqual(0);
    expect(res.best.score.score).toBeGreaterThanOrEqual(res.baseline.score.score);
    expect(res.trials[0]!.score.score).toBeGreaterThanOrEqual(res.best.score.score - 1e-9);
    expect(res.evaluations).toBeGreaterThan(1);
  });

  it("only moves axes that are present in the space", () => {
    const res = searchRegimeThresholds(TAPE, {
      space: { sidewaysRangePct: [4, 6, 8, 12, 16] },
    });
    for (const k of TUNABLE_KEYS) {
      if (k === "sidewaysRangePct") continue;
      expect(res.best.thresholds[k]).toBe(DEFAULT_REGIME_THRESHOLDS[k]);
    }
    expect(DEFAULT_SEARCH_SPACE.sidewaysRangePct).toContain(res.best.thresholds.sidewaysRangePct);
  });

  it("is deterministic across repeated runs", () => {
    const a = searchRegimeThresholds(TAPE, { space: SIDEWAYS_BEAR_SPACE });
    const b = searchRegimeThresholds(TAPE, { space: SIDEWAYS_BEAR_SPACE });
    expect(b.best.thresholds).toEqual(a.best.thresholds);
    expect(b.best.score.score).toBe(a.best.score.score);
    expect(b.evaluations).toBe(a.evaluations);
  });

  it("respects the evaluation budget", () => {
    const res = searchRegimeThresholds(TAPE, { space: DEFAULT_SEARCH_SPACE, maxEvaluations: 12 });
    expect(res.evaluations).toBeLessThanOrEqual(12);
  });

  it("exhaustive grid finds a set at least as good as coordinate descent", () => {
    const space = { bearDrawdownPct: [8, 12, 15, 20, 25], sidewaysRangePct: [4, 8, 12] };
    const grid = gridSearchRegimeThresholds(TAPE, { space });
    const cd = searchRegimeThresholds(TAPE, { space });
    expect(grid.evaluations).toBe(5 * 3);
    expect(grid.best.score.score).toBeGreaterThanOrEqual(cd.best.score.score - 1e-9);
  });

  it("caps the grid rather than exploding on a large space", () => {
    const grid = gridSearchRegimeThresholds(TAPE, {
      space: DEFAULT_SEARCH_SPACE,
      maxEvaluations: 40,
    });
    expect(grid.evaluations).toBeLessThanOrEqual(40);
    expect(Number.isFinite(grid.best.score.score)).toBe(true);
  });

  it("adapts the bear trigger when the tape's drawdowns are shallower", () => {
    // A tape whose worst drawdown is ~9% should prefer a trigger below the
    // default 15%, otherwise no bar is ever labelled bear by drawdown.
    const rand = rng(7);
    const shallow: IndexPoint[] = [];
    let v = 100;
    for (let i = 0; i < 900; i++) {
      const phase = Math.sin((i / 900) * Math.PI * 6);
      v *= 1 + phase * 0.0012 + (rand() - 0.5) * 0.002;
      shallow.push({ date: day(i), value: v });
    }
    const res = searchRegimeThresholds(shallow, {
      space: { bearDrawdownPct: [4, 6, 8, 10, 15, 20, 25] },
    });
    expect(res.best.thresholds.bearDrawdownPct).toBeLessThanOrEqual(
      DEFAULT_REGIME_THRESHOLDS.bearDrawdownPct,
    );
  });
});

describe("holdout-validated tuning", () => {
  it("splits the tape, validates out of sample and explains the verdict", () => {
    const res = tuneRegimeThresholds(TAPE, { space: SIDEWAYS_BEAR_SPACE, trainFraction: 0.7 });
    expect(res.train.evaluations).toBeGreaterThan(1);
    expect(typeof res.reason).toBe("string");
    expect(res.reason.length).toBeGreaterThan(10);
    if (res.adopted) {
      expect(res.holdout.improvement).toBeGreaterThan(0);
      expect(Object.keys(res.changed).length).toBeGreaterThan(0);
      expect(res.recommended).toEqual(res.train.best.thresholds);
    } else {
      expect(res.recommended).toEqual(DEFAULT_REGIME_THRESHOLDS);
      expect(res.changed).toEqual({});
    }
  });

  it("refuses to adopt when the held-out bar is set impossibly high", () => {
    const res = tuneRegimeThresholds(TAPE, {
      space: SIDEWAYS_BEAR_SPACE,
      minHoldoutImprovement: 1e6,
    });
    expect(res.adopted).toBe(false);
    expect(res.recommended).toEqual(DEFAULT_REGIME_THRESHOLDS);
    expect(res.reason).toContain("failed out of sample");
  });

  it("keeps the defaults when the tape is too short to validate", () => {
    const res = tuneRegimeThresholds(TAPE.slice(0, 8), { space: SIDEWAYS_BEAR_SPACE });
    expect(res.adopted).toBe(false);
    expect(res.recommended).toEqual(DEFAULT_REGIME_THRESHOLDS);
  });

  it("formats a readable summary covering every regime", () => {
    const text = formatRegimeTuning(
      tuneRegimeThresholds(TAPE, { space: SIDEWAYS_BEAR_SPACE }),
    );
    expect(text).toContain("regime tuning");
    expect(text).toContain("in-sample");
    expect(text).toContain("held-out");
    for (const r of ["bull", "bear", "sideways"]) expect(text).toContain(r);
  });
});
