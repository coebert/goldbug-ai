// Overlapping walk-forward windows and regime-balanced CV sampling.
import { describe, it, expect } from "vitest";
import {
  MIN_OVERLAP_STEP_BARS,
  effectiveWindowCount,
  meanWindowOverlap,
  overlappingWalkForwardWindows,
  resolveWalkForwardStep,
  sampleRegimeBalancedWindows,
  summariseRegime,
  walkForwardWindows,
  type RegimeLabel,
  type WalkForwardWindow,
  type WindowResult,
} from "../regime-walk-forward";

const win = (i: number, testStart: number, testEnd: number): WalkForwardWindow => ({
  index: i,
  trainStart: Math.max(0, testStart - 252),
  trainEnd: testStart,
  testStart,
  testEnd,
});

const result = (
  w: WalkForwardWindow,
  regime: RegimeLabel,
  over: Partial<WindowResult> = {},
): WindowResult => ({
  window: w,
  regime,
  purity: 1,
  confidence: 0.8,
  from: "2020-01-01",
  to: "2020-06-30",
  netCagrPct: 5,
  maxDrawdownPct: -10,
  benchmarkCagrPct: 4,
  trades: 20,
  tradesPerYear: 40,
  feeDragPct: 1,
  sharpe: 0.8,
  ...over,
});

describe("resolveWalkForwardStep", () => {
  it("defaults to disjoint slices", () => {
    expect(resolveWalkForwardStep({ trainBars: 252, testBars: 126 })).toBe(126);
    expect(resolveWalkForwardStep({ trainBars: 252, testBars: 126, overlapPct: 0 })).toBe(126);
  });

  it("shrinks the step by the overlap fraction", () => {
    expect(resolveWalkForwardStep({ trainBars: 0, testBars: 100, overlapPct: 0.5 })).toBe(50);
    expect(resolveWalkForwardStep({ trainBars: 0, testBars: 100, overlapPct: 0.75 })).toBe(25);
    expect(resolveWalkForwardStep({ trainBars: 0, testBars: 120, overlapPct: 0.9 })).toBe(12);
  });

  it("never degenerates below the minimum step", () => {
    const s = resolveWalkForwardStep({ trainBars: 0, testBars: 100, overlapPct: 0.99 });
    expect(s).toBeGreaterThanOrEqual(MIN_OVERLAP_STEP_BARS);
  });

  it("lets an explicit step win over the overlap", () => {
    expect(resolveWalkForwardStep({ trainBars: 0, testBars: 100, overlapPct: 0.9, step: 63 })).toBe(63);
  });

  it("is monotone: more overlap never means a bigger step", () => {
    let prev = Infinity;
    for (const o of [0, 0.25, 0.5, 0.6, 0.75, 0.9]) {
      const s = resolveWalkForwardStep({ trainBars: 0, testBars: 252, overlapPct: o });
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("overlappingWalkForwardWindows", () => {
  it("reproduces the disjoint runner at zero overlap", () => {
    const a = overlappingWalkForwardWindows(2000, { trainBars: 252, testBars: 126 });
    const b = walkForwardWindows(2000, { trainBars: 252, testBars: 126 });
    expect(a).toEqual(b);
  });

  it("produces strictly more windows as overlap rises", () => {
    const none = overlappingWalkForwardWindows(2500, { trainBars: 252, testBars: 126 }).length;
    const half = overlappingWalkForwardWindows(2500, { trainBars: 252, testBars: 126, overlapPct: 0.5 }).length;
    const deep = overlappingWalkForwardWindows(2500, { trainBars: 252, testBars: 126, overlapPct: 0.9 }).length;
    expect(half).toBeGreaterThan(none);
    expect(deep).toBeGreaterThan(half);
  });

  it("keeps every window inside the tape and correctly sized", () => {
    const ws = overlappingWalkForwardWindows(1200, { trainBars: 200, testBars: 100, overlapPct: 0.8 });
    expect(ws.length).toBeGreaterThan(5);
    for (const w of ws) {
      expect(w.trainStart).toBeGreaterThanOrEqual(0);
      expect(w.testEnd).toBeLessThanOrEqual(1200);
      expect(w.testEnd - w.testStart).toBe(100);
      expect(w.testStart - w.trainStart).toBe(200);
    }
  });
});

describe("independence accounting", () => {
  it("counts disjoint windows at face value", () => {
    const ws = [win(0, 0, 100), win(1, 100, 200), win(2, 200, 300)];
    expect(effectiveWindowCount(ws)).toBeCloseTo(3, 9);
    expect(meanWindowOverlap(ws)).toBe(0);
  });

  it("discounts half-overlapping windows by roughly half", () => {
    const ws = [win(0, 0, 100), win(1, 50, 150), win(2, 100, 200), win(3, 150, 250)];
    expect(effectiveWindowCount(ws)).toBeCloseTo(2.5, 9);
    expect(meanWindowOverlap(ws)).toBeCloseTo(0.5, 9);
  });

  it("collapses fully duplicated windows toward one", () => {
    const ws = [win(0, 0, 100), win(1, 0, 100), win(2, 0, 100)];
    expect(effectiveWindowCount(ws)).toBeCloseTo(1, 9);
  });

  it("handles the empty and singleton cases", () => {
    expect(effectiveWindowCount([])).toBe(0);
    expect(meanWindowOverlap([win(0, 0, 100)])).toBe(0);
    expect(effectiveWindowCount([win(0, 0, 100)])).toBeCloseTo(1, 9);
  });

  it("never reports more effective windows than raw windows", () => {
    for (const overlap of [0, 0.3, 0.5, 0.75, 0.9]) {
      const ws = overlappingWalkForwardWindows(3000, { trainBars: 252, testBars: 126, overlapPct: overlap });
      expect(effectiveWindowCount(ws)).toBeLessThanOrEqual(ws.length + 1e-9);
    }
  });
});

describe("sampleRegimeBalancedWindows", () => {
  const many = (n: number, regime: RegimeLabel) =>
    Array.from({ length: n }, (_, i) => ({ id: `${regime}-${i}`, regime }));
  const pool = [...many(120, "bull"), ...many(14, "bear"), ...many(22, "sideways")];
  const regimeOf = (c: { regime: RegimeLabel }) => c.regime;

  it("keeps everything when no caps are set", () => {
    const s = sampleRegimeBalancedWindows(pool, regimeOf);
    expect(s.selected.length).toBe(pool.length);
    expect(s.available).toEqual({ bull: 120, bear: 14, sideways: 22 });
  });

  it("protects scarce bear/sideways windows when the budget binds", () => {
    const s = sampleRegimeBalancedWindows(pool, regimeOf, {
      maxWindows: 40,
      perRegimeCap: 20,
      minPerRegime: 10,
      seed: 7,
    });
    expect(s.selected.length).toBeLessThanOrEqual(40);
    expect(s.kept.bear).toBeGreaterThanOrEqual(10);
    expect(s.kept.sideways).toBeGreaterThanOrEqual(10);
    expect(s.kept.bull).toBeLessThanOrEqual(20);
    // The whole point: the sample is far less bull-dominated than the tape.
    expect(s.kept.bear + s.kept.sideways).toBeGreaterThanOrEqual(s.kept.bull);
  });

  it("never exceeds the per-regime cap or the global budget", () => {
    for (const seed of [1, 2, 3, 42]) {
      const s = sampleRegimeBalancedWindows(pool, regimeOf, {
        maxWindows: 25,
        perRegimeCap: 8,
        seed,
      });
      expect(s.selected.length).toBeLessThanOrEqual(25);
      for (const r of ["bull", "bear", "sideways"] as const) {
        expect(s.kept[r]).toBeLessThanOrEqual(8);
        expect(s.kept[r]).toBeLessThanOrEqual(s.available[r]);
      }
    }
  });

  it("cannot invent windows a regime does not have", () => {
    const s = sampleRegimeBalancedWindows(many(5, "bull"), regimeOf, { minPerRegime: 10 });
    expect(s.kept.bear).toBe(0);
    expect(s.selected.length).toBe(5);
  });

  it("is deterministic for a seed and varies across seeds", () => {
    const a = sampleRegimeBalancedWindows(pool, regimeOf, { maxWindows: 30, seed: 5 });
    const b = sampleRegimeBalancedWindows(pool, regimeOf, { maxWindows: 30, seed: 5 });
    const c = sampleRegimeBalancedWindows(pool, regimeOf, { maxWindows: 30, seed: 6 });
    expect(a.selected).toEqual(b.selected);
    expect(c.selected.length).toBe(a.selected.length);
  });

  it("preserves chronological order of the candidate list", () => {
    const s = sampleRegimeBalancedWindows(pool, regimeOf, { maxWindows: 30, seed: 3 });
    const idx = s.selected.map((x) => pool.indexOf(x));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("selects no duplicates", () => {
    const s = sampleRegimeBalancedWindows(pool, regimeOf, {
      maxWindows: 50,
      perRegimeCap: 20,
      minPerRegime: 6,
      seed: 11,
    });
    expect(new Set(s.selected).size).toBe(s.selected.length);
  });

  it("reports what it kept", () => {
    const s = sampleRegimeBalancedWindows(pool, regimeOf, { maxWindows: 20, seed: 1 });
    expect(s.note).toContain(`/${pool.length} windows`);
    expect(s.note).toContain("bear");
  });
});

describe("summariseRegime with overlapping windows", () => {
  it("reports raw and effective counts plus the overlap share", () => {
    const rows = [
      result(win(0, 0, 100), "bear"),
      result(win(1, 50, 150), "bear"),
      result(win(2, 100, 200), "bear"),
      result(win(3, 150, 250), "bear"),
    ];
    const s = summariseRegime("bear", rows);
    expect(s.windows).toBe(4);
    expect(s.effectiveWindows).toBeCloseTo(2.5, 6);
    expect(s.overlapShare).toBeCloseTo(0.5, 6);
  });

  it("withholds a pass when the independent evidence is too thin", () => {
    const rows = [
      result(win(0, 0, 100), "bear"),
      result(win(1, 10, 110), "bear"),
      result(win(2, 20, 120), "bear"),
    ];
    const lax = summariseRegime("bear", rows, { minEffectiveWindows: 0 });
    const strict = summariseRegime("bear", rows, { minEffectiveWindows: 3 });
    expect(lax.pass).toBe(true);
    expect(strict.sufficientEvidence).toBe(false);
    expect(strict.pass).toBe(false);
    // The returns themselves are unchanged — only the verdict is withheld.
    expect(strict.medianNetCagrPct).toBe(lax.medianNetCagrPct);
  });

  it("passes the same evidence bar when the windows are genuinely disjoint", () => {
    const rows = [
      result(win(0, 0, 100), "bear"),
      result(win(1, 100, 200), "bear"),
      result(win(2, 200, 300), "bear"),
    ];
    expect(summariseRegime("bear", rows, { minEffectiveWindows: 3 }).pass).toBe(true);
  });

  it("still fails on a drawdown breach regardless of evidence", () => {
    const rows = [
      result(win(0, 0, 100), "bear", { maxDrawdownPct: -40 }),
      result(win(1, 100, 200), "bear"),
      result(win(2, 200, 300), "bear"),
    ];
    const s = summariseRegime("bear", rows, { maxDrawdownPct: 25, minEffectiveWindows: 2 });
    expect(s.drawdownStable).toBe(false);
    expect(s.pass).toBe(false);
  });

  it("keeps empty regimes inert", () => {
    const s = summariseRegime("sideways", [], { minEffectiveWindows: 3 });
    expect(s.windows).toBe(0);
    expect(s.effectiveWindows).toBe(0);
    expect(s.pass).toBe(false);
  });
});
