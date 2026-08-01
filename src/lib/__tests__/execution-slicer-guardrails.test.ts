// Guardrail tests for execution-slicer edge cases that previously hung a tick.
//
// Two failure families are covered:
//  1. Schedule math fed pathological values (non-finite, absurd slice counts,
//     lots bigger than the order) — must stay bounded and finite.
//  2. Database work that never settles — must hit a deadline instead of
//     stalling the cron, and a stalled tick must degrade to an empty result.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  buildSliceSchedule,
  chooseSliceCount,
  normalizeSliceCount,
  sanitizeSchedule,
  twapWeights,
  vwapWeights,
  MAX_SLICES,
  MAX_WINDOW_MINUTES,
} from "../execution-vwap";
import {
  createTickBudget,
  withSlicerDeadline,
  SlicerTimeoutError,
  SLICER_DB_TIMEOUT_MS,
} from "../execution-slicer-deadline";

const FC_SEED = 20260801;

describe("buildSliceSchedule guardrails", () => {
  it("caps an absurd slice count instead of allocating a huge array", () => {
    const started = Date.now();
    const schedule = buildSliceSchedule({
      strategy: "vwap",
      totalQty: 1_000,
      nSlices: 1e9,
      windowMinutes: 90,
    });
    expect(schedule.length).toBeLessThanOrEqual(MAX_SLICES);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it.each([
    ["NaN slices", Number.NaN],
    ["Infinity slices", Number.POSITIVE_INFINITY],
    ["negative slices", -12],
    ["fractional slices", 3.7],
  ])("%s yields a bounded schedule", (_label, nSlices) => {
    const schedule = buildSliceSchedule({
      strategy: "vwap",
      totalQty: 500,
      nSlices: nSlices as number,
      windowMinutes: 90,
    });
    expect(schedule.length).toBeGreaterThanOrEqual(1);
    expect(schedule.length).toBeLessThanOrEqual(MAX_SLICES);
    for (const b of schedule) {
      expect(Number.isFinite(b.qty)).toBe(true);
      expect(b.qty).toBeGreaterThan(0);
      expect(Number.isFinite(b.offset_min)).toBe(true);
    }
  });

  it("never returns NaN quantities for non-finite totals", () => {
    for (const totalQty of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      const schedule = buildSliceSchedule({
        strategy: "vwap",
        totalQty,
        nSlices: 4,
        windowMinutes: 60,
      });
      expect(schedule.every((b) => Number.isFinite(b.qty) && b.qty > 0)).toBe(true);
    }
  });

  it("keeps a lot size larger than the order from zeroing every bucket", () => {
    const schedule = buildSliceSchedule({
      strategy: "twap",
      totalQty: 3,
      nSlices: 4,
      windowMinutes: 60,
      minLotSize: 1_000,
    });
    expect(schedule).toHaveLength(4);
    expect(schedule.every((b) => b.qty > 0)).toBe(true);
    const sum = schedule.reduce((a, b) => a + b.qty, 0);
    expect(sum).toBeGreaterThan(0);
    expect(Number.isFinite(sum)).toBe(true);
  });

  it("clamps the window and keeps offsets non-decreasing", () => {
    const schedule = buildSliceSchedule({
      strategy: "twap",
      totalQty: 100,
      nSlices: 8,
      windowMinutes: 1e9,
    });
    let prev = -1;
    for (const b of schedule) {
      expect(b.offset_min).toBeGreaterThanOrEqual(prev);
      expect(b.offset_min).toBeLessThanOrEqual(MAX_WINDOW_MINUTES);
      prev = b.offset_min;
    }
  });

  it("treats an unknown strategy as vwap rather than crashing", () => {
    const schedule = buildSliceSchedule({
      strategy: "sniper" as never,
      totalQty: 100,
      nSlices: 4,
      windowMinutes: 60,
    });
    expect(schedule).toHaveLength(4);
  });

  it("stays total under fuzzed inputs", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e12, noNaN: false }),
        fc.double({ min: -100, max: 1e6, noNaN: false }),
        fc.double({ min: -100, max: 1e9, noNaN: false }),
        fc.constantFrom("vwap", "twap", "immediate"),
        (totalQty, nSlices, windowMinutes, strategy) => {
          const schedule = buildSliceSchedule({
            strategy: strategy as "vwap",
            totalQty,
            nSlices,
            windowMinutes,
          });
          expect(schedule.length).toBeGreaterThanOrEqual(1);
          expect(schedule.length).toBeLessThanOrEqual(MAX_SLICES);
          for (const b of schedule) {
            expect(Number.isFinite(b.qty)).toBe(true);
            expect(b.qty).toBeGreaterThan(0);
            expect(Number.isFinite(b.offset_min)).toBe(true);
            expect(b.offset_min).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { seed: FC_SEED, numRuns: 400 },
    );
  });
});

describe("weights and slice-count guardrails", () => {
  it("normalizeSliceCount clamps to [1, MAX_SLICES]", () => {
    expect(normalizeSliceCount(Number.NaN)).toBe(1);
    expect(normalizeSliceCount(-4)).toBe(1);
    expect(normalizeSliceCount(1e9)).toBe(MAX_SLICES);
    expect(normalizeSliceCount(5.9)).toBe(5);
  });

  it("weights always sum to 1 and stay finite", () => {
    for (const n of [Number.NaN, -3, 0, 2, 8, 1e9]) {
      for (const w of [vwapWeights(n as number), twapWeights(n as number)]) {
        expect(w.length).toBeLessThanOrEqual(MAX_SLICES);
        expect(w.every(Number.isFinite)).toBe(true);
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      }
    }
  });

  it("chooseSliceCount never returns non-finite or out-of-range counts", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: 1e15, noNaN: false }),
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.double({ min: -1e9, max: 1e15, noNaN: false })),
        (notional, adv) => {
          const n = chooseSliceCount(notional, adv as number | null | undefined);
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(MAX_SLICES);
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it("ignores a zero or inverted participation target", () => {
    expect(chooseSliceCount(1e6, 1e6, { targetParticipation: 0 })).toBeLessThanOrEqual(MAX_SLICES);
    expect(chooseSliceCount(1e6, 1e6, { minSlices: 9, maxSlices: 2 })).toBeGreaterThanOrEqual(1);
  });
});

describe("sanitizeSchedule", () => {
  it("accepts a well-formed schedule", () => {
    expect(sanitizeSchedule([{ qty: 5, offset_min: 0 }, { qty: 5, offset_min: 30 }])).toEqual([
      { qty: 5, offset_min: 0 },
      { qty: 5, offset_min: 30 },
    ]);
  });

  it.each([
    ["not an array", { qty: 1 }],
    ["empty", []],
    ["null entry", [null]],
    ["NaN qty", [{ qty: Number.NaN, offset_min: 0 }]],
    ["zero qty", [{ qty: 0, offset_min: 0 }]],
    ["negative offset", [{ qty: 1, offset_min: -5 }]],
    ["absurd offset", [{ qty: 1, offset_min: 1e9 }]],
    ["oversized", Array.from({ length: MAX_SLICES + 1 }, () => ({ qty: 1, offset_min: 0 }))],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeSchedule(value)).toBeNull();
  });
});

describe("withSlicerDeadline", () => {
  it("returns the value when work settles in time", async () => {
    await expect(withSlicerDeadline("op", Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("throws a tagged timeout when work never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<string>(() => {});
      const raced = withSlicerDeadline("tickSlicer.fetch", pending, { timeoutMs: 50 });
      const assertion = expect(raced).rejects.toBeInstanceOf(SlicerTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves to the fallback and notifies when one is supplied", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const raced = withSlicerDeadline<string>("tickSlicer.expire", new Promise<string>(() => {}), {
        timeoutMs: 20,
        fallback: "degraded",
        onTimeout,
      });
      await vi.advanceTimersByTimeAsync(30);
      await expect(raced).resolves.toBe("degraded");
      expect(onTimeout).toHaveBeenCalledWith("tickSlicer.expire", 20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a genuine rejection untouched", async () => {
    await expect(
      withSlicerDeadline("op", Promise.reject(new Error("db down")), { fallback: "x" }),
    ).rejects.toThrow("db down");
  });

  it("falls back to the default budget for a bogus timeout", async () => {
    await expect(
      withSlicerDeadline("op", Promise.resolve(1), { timeoutMs: Number.NaN }),
    ).resolves.toBe(1);
    expect(SLICER_DB_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("createTickBudget", () => {
  it("reports remaining time and expiry against an injected clock", () => {
    let now = 1_000;
    const budget = createTickBudget(1_000, () => now);
    expect(budget.remaining()).toBe(1_000);
    expect(budget.expired()).toBe(false);
    now += 400;
    expect(budget.remaining()).toBe(600);
    expect(budget.slice(5_000)).toBe(600);
    now += 900;
    expect(budget.remaining()).toBe(0);
    expect(budget.expired()).toBe(true);
    expect(budget.slice()).toBe(1);
  });

  it("ignores a non-positive total budget", () => {
    const budget = createTickBudget(-5, () => 0);
    expect(budget.remaining()).toBeGreaterThan(0);
  });
});
