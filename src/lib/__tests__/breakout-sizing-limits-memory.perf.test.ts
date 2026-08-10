import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { applySizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Memory regression guard for the sizing-limits pipeline.
 *
 * The perf guard catches time; this one catches space. The failure modes it
 * exists for are real and easy to introduce:
 *  - retaining the whole input cohort inside every `LimitedSignal` (a spread
 *    of the source row instead of the four fields the plan needs),
 *  - keeping closed positions in the `open` book instead of splicing them,
 *  - caching per-cohort state in a module-level Map that never evicts, so the
 *    3,000-cohort fuzz workload grows the heap without bound.
 *
 * Budgets are expressed per signal (retained bytes) and as total growth across
 * the fuzz workload, both with generous headroom: they are shaped to fail on a
 * structural regression (an order of magnitude), not on allocator noise.
 *
 * Workload seeding shares the fuzz contract, so a failure replays verbatim.
 */

const FILE = "src/lib/__tests__/breakout-sizing-limits-memory.perf.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Heap measurement
// ---------------------------------------------------------------------------

/**
 * Node does not expose `gc()` unless started with --expose-gc, and vitest
 * does not. Enable it for the duration of this file so heap readings are
 * about retention rather than uncollected garbage.
 */
const forceGc: () => void = (() => {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");
    return gc;
  } catch {
    return () => {};
  }
})();

const GC_AVAILABLE = forceGc.toString() !== "() => {}";

/** Settle the heap: several collections, since one pass can leave floaters. */
function settle(): number {
  for (let i = 0; i < 4; i++) forceGc();
  return process.memoryUsage().heapUsed;
}

/** Heap retained by whatever `fn` returns, in bytes. */
function retainedBytes<T>(fn: () => T): { bytes: number; value: T } {
  fn(); // warm module-level lazies so they don't count as retention
  const before = settle();
  const value = fn();
  const after = settle();
  // `value` must stay reachable across the measurement.
  if (value === undefined) throw new Error("workload returned nothing");
  return { bytes: after - before, value };
}

/** Heap growth left behind by `fn` once its results are discarded. */
function leakedBytes(fn: () => void): number {
  fn();
  const before = settle();
  fn();
  const after = settle();
  return after - before;
}

// ---------------------------------------------------------------------------
// Workloads (mirroring the integration and fuzz suites)
// ---------------------------------------------------------------------------

const day = (i: number) => {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

function cohort(n: number, index = 0, poison = false): Row[] {
  const r = rng(caseSeed(BASE_SEED, poison ? "mem-poisoned" : "mem-clean", index));
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
    out.push({ symbol: `S${i % 40}`, date: day(Math.floor(i / 2)), barsHeld: 1 + Math.floor(r() * 12), size });
  }
  return out;
}

const LIMITS: SizingLimits = {
  maxPositionSize: 1.5,
  maxConcurrentSignals: 5,
  maxTotalDeployedPct: 100,
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * KB;

/**
 * A `LimitedSignal` is 4 fields plus a small array: a few hundred bytes with
 * strings and object headers. 1 KB per signal leaves ~3x headroom while still
 * failing hard if the plan starts retaining whole input rows or cohorts.
 */
const BUDGET_BYTES_PER_SIGNAL = 1 * KB;

/** The 2,000-signal integration replay, retained. */
const BUDGET_INTEGRATION_BYTES = 2_000 * BUDGET_BYTES_PER_SIGNAL;

/**
 * The fuzz shape: 3,000 cohorts run and thrown away. Nothing should survive,
 * so any persistent growth beyond allocator noise means the pipeline is
 * caching. 8 MB is noise-tolerant and an order of magnitude below what
 * retaining all 3,000 plans would cost.
 */
const BUDGET_FUZZ_LEAK_BYTES = 8 * MB;

describe("sizing-limits memory regression", () => {
  it("can force garbage collection (measurements are meaningful)", () => {
    // If this ever fails the other assertions are measuring noise, so surface
    // it as its own failure rather than letting budgets silently soften.
    expect(GC_AVAILABLE, `no gc() available — ${REPRO}`).toBe(true);
  });

  it("keeps a retained integration-sized plan inside its memory budget", () => {
    const rows = cohort(2_000);
    const { bytes, value } = retainedBytes(() => applySizingLimits(rows, LIMITS));
    expect(value.signals.length).toBe(rows.length);
    expect(bytes, `retained ${(bytes / KB).toFixed(0)} KB for 2,000 signals — ${REPRO}`).toBeLessThan(
      BUDGET_INTEGRATION_BYTES,
    );
  });

  it("scales retention linearly with cohort size", () => {
    // Retaining the input cohort per signal (or the open book per row) turns
    // this ratio quadratic long before the absolute budget above trips.
    const small = retainedBytes(() => applySizingLimits(cohort(1_000, 11), LIMITS)).bytes;
    const large = retainedBytes(() => applySizingLimits(cohort(8_000, 11), LIMITS)).bytes;
    const ratio = Math.max(large, 1) / Math.max(small, 1);
    expect(ratio, `8x input grew retention ${ratio.toFixed(1)}x — ${REPRO}`).toBeLessThan(16);
  });

  it("leaves nothing behind after the 3,000-cohort fuzz workload", () => {
    const cohorts = Array.from({ length: 3_000 }, (_, i) => cohort(24, i, true));
    const leaked = leakedBytes(() => {
      for (const c of cohorts) applySizingLimits(c, LIMITS);
    });
    expect(leaked, `fuzz workload leaked ${(leaked / MB).toFixed(1)} MB — ${REPRO}`).toBeLessThan(
      BUDGET_FUZZ_LEAK_BYTES,
    );
  });

  it("does not grow the heap across repeated identical runs", () => {
    // A module-level cache keyed by cohort content would pass the single-pass
    // leak check and fail here, where the same work repeats ten times.
    const rows = cohort(1_500, 3, true);
    const baseline = settle();
    for (let i = 0; i < 10; i++) applySizingLimits(rows, LIMITS);
    const growth = settle() - baseline;
    expect(growth, `10 repeats grew the heap ${(growth / MB).toFixed(1)} MB — ${REPRO}`).toBeLessThan(
      4 * MB,
    );
  });

  it("poisoned inputs cost no more memory than clean ones", () => {
    const clean = retainedBytes(() => applySizingLimits(cohort(4_000, 23, false), LIMITS)).bytes;
    const poisoned = retainedBytes(() => applySizingLimits(cohort(4_000, 23, true), LIMITS)).bytes;
    expect(
      poisoned,
      `poisoned ${(poisoned / KB).toFixed(0)} KB vs clean ${(clean / KB).toFixed(0)} KB — ${REPRO}`,
    ).toBeLessThan(Math.max(clean * 2.5, 1 * MB));
  });
});
