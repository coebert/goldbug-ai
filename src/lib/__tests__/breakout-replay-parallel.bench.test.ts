/**
 * Benchmark guardrail: the parallel replay path must stay fast *and* exact.
 *
 * The concurrency suite next door proves the numbers don't change when replays
 * interleave. It says nothing about cost, and the two regress together: the
 * usual "fix" for a state-leak bug is to stop sharing work — deep-copy the
 * cohort per call, rebuild the ranking on every step, recompute the plan inside
 * the loop. Each of those keeps the output byte-identical while quietly turning
 * the analytics grid into a multi-second page load.
 *
 * So this test pins both sides at once, on a fixed seed (not the ambient fuzz
 * seed) so run-to-run timings are comparable:
 *
 *   • runtime — warm up, then take the *median* of several measured passes, and
 *     hold sequential, concurrent and sharded-grid batches under a budget,
 *   • output  — every measured pass is hashed and must equal the baseline hash,
 *     so nothing here can buy speed by changing a single figure.
 *
 * Budgets are set well above observed local runs (see BUDGETS) because CI
 * machines are noisy and shared; they are sized to catch an order-of-magnitude
 * regression, not a 20% drift. Set REPLAY_BENCH_SCALE=2 to relax them all on a
 * slow box.
 */
import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  chronological,
  DEFAULT_GAP_WEIGHTS,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { rng } from "./fuzz-seed";

/**
 * Pinned on purpose. A benchmark whose workload changes every run cannot have a
 * budget: the seed fixes the cohorts, the job mix and therefore the work done.
 */
const BENCH_SEED = 987_654_321;
const REPRO = "bunx vitest run src/lib/__tests__/breakout-replay-parallel.bench.test.ts";

/** Slow/shared CI escape hatch: REPLAY_BENCH_SCALE=2 doubles every budget. */
const SCALE = (() => {
  const raw = Number(process.env["REPLAY_BENCH_SCALE"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

const WARMUP_PASSES = 2;
const MEASURED_PASSES = 5;
const JOB_COUNT = 12;
const COHORT_SIZE = 140;

/**
 * Budgets in ms, before REPLAY_BENCH_SCALE. Observed locally at roughly an
 * order of magnitude below each figure; they exist to catch "the replay got
 * 10x slower", not normal machine-to-machine variation.
 */
const BUDGETS = {
  sequentialBatch: 900,
  concurrentBatch: 900,
  perReplay: 90,
  shardedGrid: 1_200,
};

/** Concurrency must not cost more than this multiple of the sequential batch. */
const MAX_CONCURRENCY_OVERHEAD = 2.5;

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

function cohort(seed: number, size: number): SignalTrade[] {
  const r = rng(seed);
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 4 + Math.floor(r() * 6);
  return Array.from({ length: size }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.78 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.006 + r() * 0.03,
    atrPct: 0.01 + r() * 0.03,
    quality: 0.05 + r() * 0.9,
    penetrationAtr: 0.1 + r() * 2,
    volumeRatio: 0.8 + r() * 1.4,
    falseBreakoutRate: r() * 0.5,
    ageBars: 1 + Math.floor(r() * 6),
    pendingLatencyBars: Math.floor(r() * 3),
    entry: 100,
    exit: 100 + (r() - 0.42) * 10,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 2 + Math.floor(r() * 8),
    returnPct: (r() - 0.42) * 10,
    maxAdversePct: -r() * 5,
    maxFavourablePct: r() * 5,
  })) as SignalTrade[];
}

type Job = { seed: number; risk: RiskLevel; gapWeight: number };

const JOBS: Job[] = (() => {
  const r = rng(BENCH_SEED);
  return Array.from({ length: JOB_COUNT }, (_, i) => ({
    seed: BENCH_SEED + i * 7919,
    risk: RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)]!,
    gapWeight: DEFAULT_GAP_WEIGHTS[Math.floor(r() * DEFAULT_GAP_WEIGHTS.length)]!,
  }));
})();

/** Cohorts are built once: the benchmark measures the replay, not the fixture. */
const COHORTS = new Map(JOBS.map((j) => [j.seed, cohort(j.seed, COHORT_SIZE)]));

/** The full observable output of one replay — tape, allocations and P&L. */
function replay(job: Job) {
  const trades = COHORTS.get(job.seed)!;
  const opts = { risk: job.risk, gapWeight: job.gapWeight, limits: LIMITS };
  const summary = applyDriverSizing(trades, opts);
  const base = baselineExecution(trades, LIMITS);
  const plan = driverSizingPlan(trades, opts);

  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  const limited = applySizingLimits(
    confirmed.map((t) => ({
      symbol: t.symbol,
      date: t.date,
      barsHeld: t.barsHeld,
      size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
    })),
    LIMITS,
  );

  return {
    key: `${job.seed}/${job.risk}@${job.gapWeight}`,
    tape: limited.signals.map((s) => ({
      key: `${s.date} ${s.symbol}`,
      size: s.size,
      clamped: [...s.clamped].sort().join("|"),
    })),
    allocations: [...plan.entries()]
      .map(([symbol, rec]) => ({ symbol, action: rec.action, size: rec.sizeMultiplier }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    pnl: {
      cumulativeReturnPct: summary.cumulativeReturnPct,
      maxDrawdownPct: summary.maxDrawdownPct,
      avgReturnPct: summary.avgReturnPct,
      expectancyPct: summary.expectancyPct,
      returnPerUnitPct: summary.returnPerUnitPct,
      deployedPct: summary.deployedPct,
      taken: summary.taken,
      vsBaselinePp: summary.cumulativeReturnPct - base.cumulativeReturnPct,
      peakConcurrent: summary.limits.peakConcurrent,
    },
  };
}

type Replay = ReturnType<typeof replay>;

/**
 * Byte-identity is checked on a canonical string, not a deep-equal: it is what
 * "identical output" means here, and it is cheap enough to run on every pass
 * without polluting the timings (hashing happens outside the measured window).
 */
function fingerprint(rows: readonly Replay[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.key.localeCompare(b.key)));
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Warms up, then times `MEASURED_PASSES` passes, checking the fingerprint of
 * every single pass — warmup included. Returns the median duration, which is
 * far more stable than a mean when a GC pause lands in one pass.
 */
async function benchmark(
  label: string,
  run: () => Promise<readonly Replay[]> | readonly Replay[],
  expected: string,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < WARMUP_PASSES + MEASURED_PASSES; i++) {
    const t0 = performance.now();
    const rows = await run();
    const elapsed = performance.now() - t0;
    expect(fingerprint(rows), `${label}: output changed on pass ${i} — ${REPRO}`).toBe(expected);
    if (i >= WARMUP_PASSES) samples.push(elapsed);
  }
  const ms = median(samples);
  console.log(
    `[bench] ${label}: median ${ms.toFixed(1)}ms over ${MEASURED_PASSES} passes ` +
      `(min ${Math.min(...samples).toFixed(1)}, max ${Math.max(...samples).toFixed(1)})`,
  );
  return ms;
}

const withinBudget = (ms: number, budget: number, label: string) => {
  const limit = budget * SCALE;
  expect(ms, `${label} took ${ms.toFixed(1)}ms, budget ${limit}ms — ${REPRO}`).toBeLessThan(limit);
};

const sequentialPass = () => JOBS.map(replay);

const concurrentPass = async (seed: number) =>
  Promise.all(
    shuffled(JOBS, seed).map(async (job) => {
      // Yield first so every job is queued before any of them computes.
      await Promise.resolve();
      return replay(job);
    }),
  );

const BASELINE = fingerprint(sequentialPass());

describe("parallel replay benchmark (fixed seed)", () => {
  it("the sequential batch stays inside its runtime budget", async () => {
    const ms = await benchmark("sequential batch", sequentialPass, BASELINE);
    withinBudget(ms, BUDGETS.sequentialBatch, "sequential batch");
    withinBudget(ms / JOB_COUNT, BUDGETS.perReplay, "per replay");
  }, 120_000);

  it("the concurrent batch stays inside its budget and matches byte for byte", async () => {
    const ms = await benchmark("concurrent batch", () => concurrentPass(BENCH_SEED + 1), BASELINE);
    withinBudget(ms, BUDGETS.concurrentBatch, "concurrent batch");
  }, 120_000);

  it("concurrency does not cost materially more than running in sequence", async () => {
    const seq = await benchmark("sequential (overhead ref)", sequentialPass, BASELINE);
    const par = await benchmark("concurrent (overhead ref)", () => concurrentPass(BENCH_SEED + 2), BASELINE);
    // A floor keeps the ratio meaningful when both batches are sub-millisecond.
    const ratio = par / Math.max(seq, 1);
    expect(
      ratio,
      `concurrent batch was ${ratio.toFixed(2)}x the sequential batch (${par.toFixed(1)}ms vs ` +
        `${seq.toFixed(1)}ms) — ${REPRO}`,
    ).toBeLessThan(MAX_CONCURRENCY_OVERHEAD * SCALE);
  }, 120_000);

  it("a grid sharded across concurrent callers is budgeted and stable", async () => {
    const trades = COHORTS.get(JOBS[0]!.seed)!;
    const whole = buildExecutionGrid(trades, { limits: LIMITS });
    const canonical = (cells: ReturnType<typeof buildExecutionGrid>["cells"]) =>
      JSON.stringify(
        [...cells].sort((a, b) => `${a.risk}@${a.gapWeight}`.localeCompare(`${b.risk}@${b.gapWeight}`)),
      );
    const expected = canonical(whole.cells);

    const samples: number[] = [];
    for (let i = 0; i < WARMUP_PASSES + MEASURED_PASSES; i++) {
      const t0 = performance.now();
      const shards = await Promise.all(
        shuffled(RISK_LEVELS, BENCH_SEED + 3 + i).map(async (risk) => {
          await Promise.resolve();
          return buildExecutionGrid(trades, { limits: LIMITS, risks: [risk] });
        }),
      );
      const elapsed = performance.now() - t0;
      expect(canonical(shards.flatMap((g) => g.cells)), `sharded grid changed on pass ${i} — ${REPRO}`).toBe(
        expected,
      );
      if (i >= WARMUP_PASSES) samples.push(elapsed);
    }
    const ms = median(samples);
    console.log(`[bench] sharded grid: median ${ms.toFixed(1)}ms over ${MEASURED_PASSES} passes`);
    withinBudget(ms, BUDGETS.shardedGrid, "sharded grid");
  }, 120_000);

  it("the benchmark workload is real — the fixed seed produces varied, non-trivial replays", () => {
    // A budget passes trivially if the seed happens to generate empty cohorts,
    // so pin the shape of the work the timings above are measuring.
    const rows = sequentialPass();
    expect(rows.length).toBe(JOB_COUNT);
    expect(new Set(rows.map((r) => JSON.stringify(r.pnl))).size, `all jobs identical — ${REPRO}`)
      .toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.tape.length, `empty tape for ${row.key} — ${REPRO}`).toBeGreaterThan(10);
      expect(row.allocations.length, `no allocations for ${row.key} — ${REPRO}`).toBeGreaterThan(0);
    }
  });
});
