import { describe, expect, it } from "vitest";
import { applySizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { caseSeed, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Performance regression guard for the sizing-limits pipeline.
 *
 * The integration and fuzz suites replay thousands of cohorts through
 * `applySizingLimits`; if that function ever picks up an accidental O(n^2)
 * (a rescan of the open book, a re-sort per signal, a Map rebuilt inside the
 * loop) CI gets slower and nobody notices until the suite times out. This
 * test fails first, with a number.
 *
 * CI runners vary wildly in absolute speed, so nothing here asserts raw
 * milliseconds. Every budget is expressed in "calibration units": we time a
 * fixed arithmetic loop on the same machine in the same process and measure
 * the pipeline relative to it. That keeps the thresholds meaningful on a
 * fast laptop and a throttled CI container alike, while still catching a real
 * complexity regression (which shows up as a multiple, not a few percent).
 */

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** A deliberately dumb, allocation-free loop used as the machine's yardstick. */
function calibrationUnitMs(): number {
  const spin = (iters: number) => {
    let acc = 0;
    for (let i = 0; i < iters; i++) acc += Math.sqrt(i % 1024) * 1.0000001;
    return acc;
  };
  spin(2_000_000); // warm the JIT, result discarded
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    const out = spin(2_000_000);
    runs.push(performance.now() - t0);
    expect(Number.isFinite(out)).toBe(true);
  }
  runs.sort((a, b) => a - b);
  return Math.max(runs[Math.floor(runs.length / 2)]!, 0.05);
}

const UNIT_MS = calibrationUnitMs();

/** Median of `runs` timings of `fn`, in calibration units. */
function measureUnits(fn: () => void, runs = 5): number {
  fn(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]! / UNIT_MS;
}

// ---------------------------------------------------------------------------
// Workloads mirroring what the integration and fuzz suites actually run
// ---------------------------------------------------------------------------

const day = (i: number) => {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

/**
 * Workload seeding shares the fuzz suite's contract, so a slow or failing
 * perf run replays exactly with `FUZZ_SEED=<base> bunx vitest run <file>`.
 */
const BASE_SEED = resolveFuzzSeed();

function cohort(n: number, index = 0, poison = false): Row[] {
  const r = rng(caseSeed(BASE_SEED, poison ? "perf-poisoned" : "perf-clean", index));
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    let size = r() * 2;
    if (poison) {
      const p = r();
      if (p < 0.05) size = NaN;
      else if (p < 0.08) size = Infinity;
      else if (p < 0.1) size = -Infinity;
      else if (p < 0.12) size = 1e12;
    }
    out.push({
      symbol: `S${i % 40}`,
      date: day(Math.floor(i / 2)),
      barsHeld: 1 + Math.floor(r() * 12),
      size,
    });
  }
  return out;
}


const LIMITS: SizingLimits = {
  maxPositionSize: 1.5,
  maxConcurrentSignals: 5,
  maxTotalDeployedPct: 100,
};

// ---------------------------------------------------------------------------
// Budgets (calibration units — see the header note)
// ---------------------------------------------------------------------------

/** One 2k-signal integration-sized replay. */
const BUDGET_INTEGRATION = 1.5;
/** The fuzz suite's shape: 3,000 small cohorts back to back. */
const BUDGET_FUZZ = 8;
/** Ceiling on the observed scaling exponent — 1 is linear, 2 is quadratic. */
const MAX_SCALING_EXPONENT = 1.45;

describe("sizing-limits performance regression", () => {
  it("reports a usable calibration baseline", () => {
    expect(UNIT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(UNIT_MS)).toBe(true);
  });

  it("keeps a full integration-sized replay inside budget", () => {
    const rows = cohort(2_000);
    const units = measureUnits(() => {
      const plan = applySizingLimits(rows, LIMITS);
      if (plan.signals.length !== rows.length) throw new Error("bad plan");
    });
    expect(units).toBeLessThan(BUDGET_INTEGRATION);
  });

  it("keeps the fuzz workload (3,000 poisoned cohorts) inside budget", () => {
    const cohorts = Array.from({ length: 3_000 }, (_, i) => cohort(24, i + 1, true));
    const units = measureUnits(() => {
      for (const c of cohorts) applySizingLimits(c, LIMITS);
    }, 3);
    expect(units).toBeLessThan(BUDGET_FUZZ);
  });

  it("scales close to linearly in cohort size", () => {
    // A quadratic regression (e.g. rescanning the open book per signal)
    // pushes the exponent towards 2 and fails here long before the absolute
    // budgets above start timing out.
    const small = measureUnits(() => void applySizingLimits(cohort(1_000, 11), LIMITS));
    const large = measureUnits(() => void applySizingLimits(cohort(8_000, 11), LIMITS));
    const exponent = Math.log2(Math.max(large, 1e-6) / Math.max(small, 1e-6)) / Math.log2(8);
    expect(exponent).toBeLessThan(MAX_SCALING_EXPONENT);
  });

  it("poisoned inputs cost no more than clean ones", () => {
    // Sanitisation must stay branch-cheap: NaN/Infinity handling should not
    // become a slow path the fuzz suite pays for on every signal.
    const clean = measureUnits(() => void applySizingLimits(cohort(4_000, 23, false), LIMITS));
    const poisoned = measureUnits(() => void applySizingLimits(cohort(4_000, 23, true), LIMITS));
    expect(poisoned).toBeLessThan(Math.max(clean * 2.5, 0.5));
  });
});
