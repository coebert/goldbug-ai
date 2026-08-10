import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZING_LIMITS,
  applySizingLimits,
  resolveSizingLimits,
} from "@/lib/breakout-sizing-limits";

const sig = (symbol: string, date: string, size: number, barsHeld = 1) => ({
  symbol,
  date,
  size,
  barsHeld,
});

describe("resolveSizingLimits", () => {
  it("fills defaults and floors negatives", () => {
    expect(resolveSizingLimits()).toEqual(DEFAULT_SIZING_LIMITS);
    const l = resolveSizingLimits({ maxPositionSize: -2, maxConcurrentSignals: 2.7 });
    expect(l.maxPositionSize).toBe(0);
    expect(l.maxConcurrentSignals).toBe(2);
  });
});

describe("applySizingLimits", () => {
  it("caps any single position at maxPositionSize", () => {
    const { signals, report } = applySizingLimits([sig("A", "2026-01-01", 3)], {
      maxPositionSize: 1.2,
      maxTotalDeployedPct: 1000,
    });
    expect(signals[0].size).toBe(1.2);
    expect(signals[0].clamped).toContain("position");
    expect(report.breaches.position).toBe(1);
    expect(report.peakPositionSize).toBe(1.2);
  });

  it("skips signals that would exceed maxConcurrentSignals", () => {
    const overlapping = ["A", "B", "C"].map((s, i) =>
      sig(s, `2026-01-0${i + 1}`, 1, 10),
    );
    const { signals, report } = applySizingLimits(overlapping, {
      maxConcurrentSignals: 2,
      maxTotalDeployedPct: 1000,
    });
    expect(signals.map((s) => s.size)).toEqual([1, 1, 0]);
    expect(signals[2].clamped).toContain("concurrency");
    expect(report.peakConcurrent).toBe(2);
  });

  it("frees a slot once an earlier position's hold window closes", () => {
    const { signals } = applySizingLimits(
      [sig("A", "2026-01-01", 1, 1), sig("B", "2026-01-02", 1, 1)],
      { maxConcurrentSignals: 1, maxTotalDeployedPct: 1000 },
    );
    expect(signals.map((s) => s.size)).toEqual([1, 1]);
  });

  it("trims the aggregate budget, partially filling the boundary signal", () => {
    const trades = ["A", "B", "C", "D"].map((s, i) => sig(s, `2026-02-0${i + 1}`, 1));
    const { signals, report } = applySizingLimits(trades, {
      maxTotalDeployedPct: 50, // 4 signals × 0.5 = budget of 2 units
      maxConcurrentSignals: 10,
    });
    expect(signals.map((s) => s.size)).toEqual([1, 1, 0, 0]);
    expect(report.deployedPct).toBe(50);
    expect(report.requestedDeployedPct).toBe(100);
    expect(report.breaches.budget).toBeGreaterThan(0);
  });

  it("allows a partial fill when only part of the budget remains", () => {
    const { signals } = applySizingLimits(
      [sig("A", "2026-03-01", 1), sig("B", "2026-03-02", 1)],
      { maxTotalDeployedPct: 75, maxConcurrentSignals: 10 },
    );
    expect(signals[0].size).toBe(1);
    expect(signals[1].size).toBeCloseTo(0.5, 10);
  });

  it("never lets total deployment exceed the ceiling under any request", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      sig(`S${i}`, `2026-04-${String(i + 1).padStart(2, "0")}`, 5, 3),
    );
    const { report } = applySizingLimits(trades, DEFAULT_SIZING_LIMITS);
    expect(report.deployedPct).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxTotalDeployedPct);
    expect(report.peakPositionSize).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxPositionSize);
    expect(report.peakConcurrent).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxConcurrentSignals);
  });

  it("reports a clean pass when nothing breaches", () => {
    const { report } = applySizingLimits([sig("A", "2026-05-01", 1)], DEFAULT_SIZING_LIMITS);
    expect(report.breaches).toEqual({ position: 0, concurrency: 0, budget: 0 });
    expect(report.summary).toContain("Within safety limits");
  });

  it("handles an empty signal list", () => {
    const { signals, report } = applySizingLimits([]);
    expect(signals).toHaveLength(0);
    expect(report.deployedPct).toBe(0);
    expect(report.summary).toContain("No signals");
  });
});

describe("applySizingLimits — non-finite and degenerate inputs", () => {
  it("treats NaN and -Infinity requested sizes as zero without poisoning the budget", () => {
    const { signals, report } = applySizingLimits(
      [
        sig("A", "2026-01-01", Number.NaN),
        sig("B", "2026-01-02", Number.NEGATIVE_INFINITY),
        sig("C", "2026-01-03", 1),
      ],
      { maxPositionSize: 2, maxConcurrentSignals: 10, maxTotalDeployedPct: 100 },
    );
    expect(signals.map((s) => s.requestedSize)).toEqual([0, 0, 1]);
    expect(signals.map((s) => s.size)).toEqual([0, 0, 1]);
    // The budget cap must still be arithmetically alive after the bad rows.
    expect(Number.isFinite(report.deployedPct)).toBe(true);
    expect(report.deployedPct).toBeCloseTo(100 / 3, 6);
    expect(report.requestedDeployedPct).toBeCloseTo(100 / 3, 6);
    expect(report.breaches).toEqual({ position: 0, concurrency: 0, budget: 0 });
  });

  it("clamps an Infinity multiplier to the position ceiling", () => {
    const { signals, report } = applySizingLimits(
      [sig("A", "2026-01-01", Number.POSITIVE_INFINITY)],
      { maxPositionSize: 1.5, maxTotalDeployedPct: 1000 },
    );
    expect(signals[0].requestedSize).toBe(Number.POSITIVE_INFINITY);
    expect(signals[0].size).toBe(1.5);
    expect(signals[0].clamped).toEqual(["position"]);
    expect(report.peakPositionSize).toBe(1.5);
  });

  it("ignores a NaN barsHeld when measuring overlap", () => {
    const { signals, report } = applySizingLimits(
      [
        sig("A", "2026-01-01", 1, Number.NaN),
        sig("B", "2026-01-02", 1, 1),
      ],
      { maxConcurrentSignals: 1, maxTotalDeployedPct: 1000 },
    );
    // NaN falls back to a 1-bar hold, so A has closed before B opens.
    expect(signals.map((s) => s.size)).toEqual([1, 1]);
    expect(report.peakConcurrent).toBe(1);
  });

  it("falls back to defaults for NaN limits and honours Infinity as uncapped", () => {
    expect(resolveSizingLimits({ maxPositionSize: Number.NaN })).toEqual(DEFAULT_SIZING_LIMITS);
    expect(
      resolveSizingLimits({ maxConcurrentSignals: Number.NaN, maxTotalDeployedPct: Number.NaN }),
    ).toEqual(DEFAULT_SIZING_LIMITS);
    const uncapped = resolveSizingLimits({
      maxPositionSize: Number.POSITIVE_INFINITY,
      maxTotalDeployedPct: Number.POSITIVE_INFINITY,
    });
    expect(uncapped.maxPositionSize).toBe(Number.POSITIVE_INFINITY);
    const { signals } = applySizingLimits([sig("A", "2026-01-01", 9)], uncapped);
    expect(signals[0].size).toBe(9);
    expect(signals[0].clamped).toEqual([]);
  });

  it("passes zero and negative baseline sizes through as flat zero, never opening a slot", () => {
    const { signals, report } = applySizingLimits(
      [sig("A", "2026-01-01", 0, 10), sig("B", "2026-01-01", -3, 10), sig("C", "2026-01-01", 1, 10)],
      { maxConcurrentSignals: 1, maxTotalDeployedPct: 1000 },
    );
    expect(signals.map((s) => s.size)).toEqual([0, 0, 1]);
    // Zero-size rows must not consume a concurrency slot, or C would be skipped.
    expect(signals[2].clamped).toEqual([]);
    expect(report.peakConcurrent).toBe(1);
    expect(report.breaches.concurrency).toBe(0);
  });

  it("reports zero deployment, not NaN, for an empty cohort", () => {
    const { signals, report } = applySizingLimits([]);
    expect(signals).toEqual([]);
    expect(report.deployedPct).toBe(0);
    expect(report.requestedDeployedPct).toBe(0);
    expect(report.peakConcurrent).toBe(0);
    expect(report.summary).toBe("No signals to limit.");
  });

  it("zeroes everything when maxPositionSize is zero", () => {
    const { signals, report } = applySizingLimits(
      [sig("A", "2026-01-01", 1), sig("B", "2026-01-02", 2)],
      { maxPositionSize: 0 },
    );
    expect(signals.every((s) => s.size === 0)).toBe(true);
    expect(signals.every((s) => s.clamped.includes("position"))).toBe(true);
    expect(report.deployedPct).toBe(0);
    expect(report.peakPositionSize).toBe(0);
  });
});

describe("applySizingLimits — multiple caps on one run", () => {
  it("records position and budget on the same signal, in application order", () => {
    const { signals, report } = applySizingLimits(
      [sig("A", "2026-01-01", 3, 1), sig("B", "2026-01-02", 3, 1)],
      { maxPositionSize: 1.5, maxConcurrentSignals: 10, maxTotalDeployedPct: 100 },
    );
    // Budget = 2 signals × 100% = 2.0. A takes 1.5, B is trimmed to 0.5.
    expect(signals[0].size).toBe(1.5);
    expect(signals[0].clamped).toEqual(["position"]);
    expect(signals[1].size).toBeCloseTo(0.5, 6);
    expect(signals[1].clamped).toEqual(["position", "budget"]);
    expect(report.breaches).toEqual({ position: 2, concurrency: 0, budget: 1 });
    expect(report.deployedPct).toBeCloseTo(100, 6);
    expect(report.summary).toContain("Caps bit on 3 signals");
  });

  it("records position and concurrency together, and skips budget once size is zero", () => {
    const overlapping = ["A", "B", "C"].map((s, i) => sig(s, `2026-01-0${i + 1}`, 5, 20));
    const { signals, report } = applySizingLimits(overlapping, {
      maxPositionSize: 1.5,
      maxConcurrentSignals: 2,
      maxTotalDeployedPct: 1000,
    });
    expect(signals.map((s) => s.size)).toEqual([1.5, 1.5, 0]);
    expect(signals[2].clamped).toEqual(["position", "concurrency"]);
    // A concurrency-skipped signal is not double-counted against the budget.
    expect(report.breaches).toEqual({ position: 3, concurrency: 1, budget: 0 });
    expect(report.peakConcurrent).toBe(2);
  });

  it("keeps deployment at or under the budget when every cap fires across a long run", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      sig(`S${i}`, `2026-02-${String(i + 1).padStart(2, "0")}`, i % 2 === 0 ? 4 : Number.NaN, 3),
    );
    const { signals, report } = applySizingLimits(many, {
      maxPositionSize: 1.25,
      maxConcurrentSignals: 2,
      maxTotalDeployedPct: 40,
    });
    const totalSize = signals.reduce((a, s) => a + s.size, 0);
    expect(totalSize).toBeLessThanOrEqual((12 * 40) / 100 + 1e-9);
    expect(report.deployedPct).toBeLessThanOrEqual(40 + 1e-9);
    expect(report.peakPositionSize).toBeLessThanOrEqual(1.25);
    expect(report.peakConcurrent).toBeLessThanOrEqual(2);
    expect(signals.every((s) => Number.isFinite(s.size) && s.size >= 0)).toBe(true);
    expect(report.breaches.position).toBeGreaterThan(0);
    expect(report.breaches.budget).toBeGreaterThan(0);
  });
});

/**
 * Regression: a single NaN size used to be added to the running `spent`
 * total, making `budget - spent` NaN forever after. Every later comparison
 * (`remaining <= 0`, `size > remaining`) then evaluated false, so the budget
 * cap silently stopped firing for the rest of the cohort.
 */
describe("NaN size does not disable the budget cap for later signals", () => {
  const budgetLimits = {
    maxPositionSize: 5,
    maxConcurrentSignals: 100,
    maxTotalDeployedPct: 100,
  } as const;

  it("keeps clamping later signals after a NaN size", () => {
    const withNaN = applySizingLimits(
      [
        sig("NAN", "2026-03-01", Number.NaN),
        sig("A", "2026-03-02", 2),
        sig("B", "2026-03-03", 2),
        sig("C", "2026-03-04", 2),
      ],
      budgetLimits,
    );

    // Budget = 4 signals × 100% = 4.0 units.
    expect(withNaN.signals[0].size).toBe(0);
    expect(withNaN.signals[1].size).toBe(2);
    expect(withNaN.signals[2].size).toBe(2);
    // The fourth ask must be refused: the budget is already fully spent.
    expect(withNaN.signals[3].size).toBe(0);
    expect(withNaN.signals[3].clamped).toContain("budget");
    expect(withNaN.report.breaches.budget).toBeGreaterThan(0);
    expect(withNaN.report.deployedPct).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("produces the same capped sizes as an equivalent cohort with a 0 size", () => {
    const nan = applySizingLimits(
      [
        sig("X", "2026-03-01", 2),
        sig("NAN", "2026-03-02", Number.NaN),
        sig("Y", "2026-03-03", 2),
        sig("Z", "2026-03-04", 2),
      ],
      budgetLimits,
    );
    const zero = applySizingLimits(
      [
        sig("X", "2026-03-01", 2),
        sig("NAN", "2026-03-02", 0),
        sig("Y", "2026-03-03", 2),
        sig("Z", "2026-03-04", 2),
      ],
      budgetLimits,
    );
    expect(nan.signals.map((s) => s.size)).toEqual(zero.signals.map((s) => s.size));
    expect(nan.report.deployedPct).toBe(zero.report.deployedPct);
    expect(nan.report.breaches).toEqual(zero.report.breaches);
  });

  it("still allows a partial fill of the residual budget after a NaN", () => {
    const { signals, report } = applySizingLimits(
      [
        sig("NAN", "2026-04-01", Number.NaN),
        sig("A", "2026-04-02", 1.5),
        // Only 0.5 of the 2.0 budget is left; this must be trimmed, not passed.
        sig("B", "2026-04-03", 1.5),
      ],
      { maxPositionSize: 5, maxConcurrentSignals: 100, maxTotalDeployedPct: 66.6667 },
    );
    expect(signals[1].size).toBeCloseTo(1.5, 6);
    expect(signals[2].size).toBeCloseTo(0.5, 4);
    expect(signals[2].clamped).toContain("budget");
    expect(report.deployedPct).toBeLessThanOrEqual(66.6667 + 1e-6);
  });

  it("stays finite and capped when several NaN sizes are interleaved", () => {
    const mixed = [
      sig("N1", "2026-05-01", Number.NaN),
      sig("A", "2026-05-02", 3),
      sig("N2", "2026-05-03", Number.NaN),
      sig("B", "2026-05-04", 3),
      sig("N3", "2026-05-05", Number.NaN),
      sig("C", "2026-05-06", 3),
    ];
    const { signals, report } = applySizingLimits(mixed, {
      maxPositionSize: 1.5,
      maxConcurrentSignals: 100,
      maxTotalDeployedPct: 50,
    });
    const spent = signals.reduce((a, s) => a + s.size, 0);
    // Budget = 6 × 50% = 3.0 units, regardless of how many NaNs came through.
    expect(Number.isFinite(spent)).toBe(true);
    expect(spent).toBeLessThanOrEqual(3 + 1e-9);
    expect(report.deployedPct).toBeLessThanOrEqual(50 + 1e-9);
    expect(signals.every((s) => Number.isFinite(s.size))).toBe(true);
    expect(Number.isFinite(report.requestedDeployedPct)).toBe(true);
    expect(Number.isFinite(report.peakPositionSize)).toBe(true);
  });

  it("does not let a NaN barsHeld leak into the concurrency book or budget", () => {
    const { signals, report } = applySizingLimits(
      [
        { symbol: "N", date: "2026-06-01", size: Number.NaN, barsHeld: Number.NaN },
        { symbol: "A", date: "2026-06-02", size: 1, barsHeld: Number.NaN },
        { symbol: "B", date: "2026-06-03", size: 1, barsHeld: 2 },
        { symbol: "C", date: "2026-06-04", size: 1, barsHeld: 2 },
      ],
      { maxPositionSize: 2, maxConcurrentSignals: 2, maxTotalDeployedPct: 50 },
    );
    const spent = signals.reduce((a, s) => a + s.size, 0);
    expect(spent).toBeLessThanOrEqual((4 * 50) / 100 + 1e-9);
    expect(Number.isFinite(report.deployedPct)).toBe(true);
    expect(report.peakConcurrent).toBeLessThanOrEqual(2);
    expect(report.breaches.budget).toBeGreaterThan(0);
  });
});
