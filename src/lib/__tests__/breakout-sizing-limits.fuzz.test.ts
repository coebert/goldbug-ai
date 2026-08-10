import { describe, expect, it } from "vitest";
import {
  applySizingLimits,
  resolveSizingLimits,
  type LimitReason,
  type SizingLimits,
} from "@/lib/breakout-sizing-limits";

/**
 * Property-based fuzzing for the sizing-limit caps.
 *
 * The caps are the last line of defence between a driver recommendation and
 * real money, so "it works on the cases I thought of" is not enough. These
 * tests generate thousands of random cohorts — poisoned with NaN, Infinity,
 * negative and zero sizes, and with caps that fight each other — and assert
 * invariants that must hold for EVERY input rather than specific outputs.
 *
 * The generator is seeded so a failure is reproducible: the seed is printed
 * in the assertion context of any failing case.
 */

/** Deterministic PRNG (mulberry32) — same seed, same cohort, every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sizes that a buggy pipeline could plausibly hand the caps. */
function randomSize(r: () => number): number {
  const roll = r();
  if (roll < 0.12) return Number.NaN;
  if (roll < 0.18) return Number.POSITIVE_INFINITY;
  if (roll < 0.21) return Number.NEGATIVE_INFINITY;
  if (roll < 0.26) return 0;
  if (roll < 0.32) return -r() * 3;
  if (roll < 0.38) return r() * 1e9;
  return r() * 4;
}

function randomBarsHeld(r: () => number): number {
  const roll = r();
  if (roll < 0.08) return Number.NaN;
  if (roll < 0.12) return Number.POSITIVE_INFINITY;
  if (roll < 0.16) return -Math.floor(r() * 5);
  if (roll < 0.2) return 0;
  return 1 + Math.floor(r() * 8);
}

function randomLimits(r: () => number): Partial<SizingLimits> {
  const pick = (roll: number, normal: () => number): number => {
    if (roll < 0.08) return Number.NaN;
    if (roll < 0.13) return Number.POSITIVE_INFINITY;
    if (roll < 0.17) return -r() * 5;
    if (roll < 0.21) return 0;
    return normal();
  };
  return {
    maxPositionSize: pick(r(), () => r() * 3),
    maxConcurrentSignals: pick(r(), () => Math.floor(r() * 8)),
    maxTotalDeployedPct: pick(r(), () => r() * 200),
  };
}

/** Chronologically ordered dates, with deliberate same-day clusters. */
function randomCohort(r: () => number) {
  const n = 1 + Math.floor(r() * 24);
  const out: { symbol: string; date: string; size: number; barsHeld: number }[] = [];
  let day = 1;
  for (let i = 0; i < n; i++) {
    if (r() > 0.35) day += 1 + Math.floor(r() * 3);
    out.push({
      symbol: `S${i}`,
      date: `2026-01-${String(Math.min(28, day)).padStart(2, "0")}`,
      size: randomSize(r),
      barsHeld: randomBarsHeld(r),
    });
  }
  return out;
}

const REASONS: LimitReason[] = ["position", "concurrency", "budget"];
const EPS = 1e-9;

describe("applySizingLimits — property-based fuzz", () => {
  it("upholds every safety invariant across 3000 random cohorts", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const cohort = randomCohort(r);
      const partial = randomLimits(r);
      const ctx = { seed, partial, cohort };

      const { signals, report } = applySizingLimits(cohort, partial);
      const limits = resolveSizingLimits(partial);

      // Resolved limits are always usable numbers, never NaN or negative.
      expect(Number.isNaN(limits.maxPositionSize), JSON.stringify(ctx)).toBe(false);
      expect(Number.isNaN(limits.maxConcurrentSignals), JSON.stringify(ctx)).toBe(false);
      expect(Number.isNaN(limits.maxTotalDeployedPct), JSON.stringify(ctx)).toBe(false);
      expect(limits.maxPositionSize >= 0, JSON.stringify(ctx)).toBe(true);
      expect(limits.maxConcurrentSignals >= 0, JSON.stringify(ctx)).toBe(true);
      expect(limits.maxTotalDeployedPct >= 0, JSON.stringify(ctx)).toBe(true);

      // One row out per row in, in the same order.
      expect(signals.length, JSON.stringify(ctx)).toBe(cohort.length);
      expect(
        signals.map((s) => s.symbol),
        JSON.stringify(ctx),
      ).toEqual(cohort.map((s) => s.symbol));

      const budgetIsFinite = Number.isFinite(limits.maxTotalDeployedPct);
      const budget = (cohort.length * limits.maxTotalDeployedPct) / 100;
      let spent = 0;

      for (const s of signals) {
        // No NaN ever escapes, and nothing is ever staked negative.
        expect(Number.isNaN(s.size), JSON.stringify({ ...ctx, s })).toBe(false);
        expect(Number.isNaN(s.requestedSize), JSON.stringify({ ...ctx, s })).toBe(false);
        expect(s.size >= 0, JSON.stringify({ ...ctx, s })).toBe(true);
        expect(s.requestedSize >= 0, JSON.stringify({ ...ctx, s })).toBe(true);

        // The per-position ceiling is absolute.
        expect(s.size <= limits.maxPositionSize + EPS, JSON.stringify({ ...ctx, s })).toBe(true);
        // An allowed size is never larger than what was asked for.
        expect(s.size <= s.requestedSize + EPS, JSON.stringify({ ...ctx, s })).toBe(true);
        // A finite budget can never allow an infinite stake.
        if (budgetIsFinite) {
          expect(Number.isFinite(s.size), JSON.stringify({ ...ctx, s })).toBe(true);
        }

        // Reasons are from the known set and never duplicated.
        for (const c of s.clamped) expect(REASONS, JSON.stringify({ ...ctx, s })).toContain(c);
        expect(new Set(s.clamped).size, JSON.stringify({ ...ctx, s })).toBe(s.clamped.length);
        // Any reduction must be explained by at least one cap.
        if (s.size < s.requestedSize - EPS) {
          expect(s.clamped.length, JSON.stringify({ ...ctx, s })).toBeGreaterThan(0);
        }

        spent += s.size;
      }

      // THE regression invariant: a NaN or Infinity anywhere in the cohort
      // must not disable the aggregate budget for the signals that follow.
      if (budgetIsFinite) {
        expect(Number.isFinite(spent), JSON.stringify(ctx)).toBe(true);
        expect(spent <= budget + EPS, JSON.stringify({ ...ctx, spent, budget })).toBe(true);
        expect(
          report.deployedPct <= limits.maxTotalDeployedPct + 1e-6,
          JSON.stringify({ ...ctx, report }),
        ).toBe(true);
      }

      // Report numbers agree with the rows they summarise.
      expect(Number.isNaN(report.deployedPct), JSON.stringify(ctx)).toBe(false);
      expect(Number.isNaN(report.requestedDeployedPct), JSON.stringify(ctx)).toBe(false);
      expect(Number.isNaN(report.peakPositionSize), JSON.stringify(ctx)).toBe(false);
      expect(report.deployedPct <= report.requestedDeployedPct + 1e-6, JSON.stringify(ctx)).toBe(
        true,
      );
      if (budgetIsFinite) {
        expect(report.deployedPct, JSON.stringify(ctx)).toBeCloseTo(
          (spent / cohort.length) * 100,
          6,
        );
      }
      expect(
        report.peakPositionSize <= limits.maxPositionSize + EPS,
        JSON.stringify(ctx),
      ).toBe(true);
      expect(
        report.peakConcurrent <= Math.max(0, limits.maxConcurrentSignals),
        JSON.stringify(ctx),
      ).toBe(true);
      for (const reason of REASONS) {
        expect(report.breaches[reason], JSON.stringify(ctx)).toBe(
          signals.filter((s) => s.clamped.includes(reason)).length,
        );
      }
      expect(typeof report.summary, JSON.stringify(ctx)).toBe("string");
      expect(report.summary.includes("NaN"), JSON.stringify(ctx)).toBe(false);
    }
  });

  it("is deterministic: the same poisoned cohort always yields the same plan", () => {
    for (let seed = 5000; seed < 5200; seed++) {
      const r = rng(seed);
      const cohort = randomCohort(r);
      const partial = randomLimits(r);
      const a = applySizingLimits(cohort, partial);
      const b = applySizingLimits(cohort, partial);
      expect(a, `seed ${seed}`).toEqual(b);
    }
  });

  it("treats every non-finite size exactly like the value it degrades to", () => {
    // NaN and -Infinity degrade to 0; +Infinity degrades to an uncapped ask,
    // which the position ceiling then clamps. Swapping them for their
    // equivalents must not change a single allowed size.
    for (let seed = 9000; seed < 9400; seed++) {
      const r = rng(seed);
      const cohort = randomCohort(r);
      const partial = { ...randomLimits(r), maxPositionSize: 1.5 };
      const substituted = cohort.map((s) => ({
        ...s,
        size: Number.isNaN(s.size) || s.size === Number.NEGATIVE_INFINITY || s.size < 0
          ? 0
          : s.size === Number.POSITIVE_INFINITY
            ? 1.5
            : s.size,
      }));
      const raw = applySizingLimits(cohort, partial);
      const clean = applySizingLimits(substituted, partial);
      expect(
        raw.signals.map((s) => s.size),
        `seed ${seed}`,
      ).toEqual(clean.signals.map((s) => s.size));
      expect(raw.report.deployedPct, `seed ${seed}`).toBe(clean.report.deployedPct);
    }
  });

  it("never deploys more than the tightest of the competing caps allows", () => {
    // Caps deliberately set to fight each other: a generous per-position
    // ceiling against a tiny budget, and vice versa.
    for (let seed = 12000; seed < 12600; seed++) {
      const r = rng(seed);
      const cohort = randomCohort(r);
      const tight = {
        maxPositionSize: r() < 0.5 ? 0.1 : 4,
        maxConcurrentSignals: r() < 0.5 ? 1 : 50,
        maxTotalDeployedPct: r() < 0.5 ? 5 : 400,
      };
      const { signals, report } = applySizingLimits(cohort, tight);
      const spent = signals.reduce((a, s) => a + s.size, 0);
      const ceiling = Math.min(
        cohort.length * tight.maxPositionSize,
        (cohort.length * tight.maxTotalDeployedPct) / 100,
      );
      expect(Number.isFinite(spent), `seed ${seed}`).toBe(true);
      expect(spent <= ceiling + EPS, `seed ${seed}: ${spent} > ${ceiling}`).toBe(true);
      expect(report.peakConcurrent, `seed ${seed}`).toBeLessThanOrEqual(
        tight.maxConcurrentSignals,
      );
    }
  });
});
