import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  DEFAULT_GAP_WEIGHTS,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Concurrency safety: a replay must not care what else is running.
 *
 * In the app these replays are not issued one at a time from a quiet test file.
 * The analytics page fires a grid build while the driver-compare panel asks for
 * its own cells and an hourly run replays a third cohort on the server — all
 * interleaved on one event loop. If any of that code kept a module-level
 * accumulator, a memoised ranking, a shared sort buffer or a cursor, the
 * numbers would depend on who else happened to be mid-flight. That class of bug
 * does not show up in a sequential suite: it shows up as a dashboard figure
 * that changes when you open a second tab.
 *
 * The test is a straight A/B. Compute a sequential baseline for a set of seeded
 * cohorts, then compute the same replays again with every call in flight at
 * once — shuffled, interleaved at await points, and mixed across seeds — and
 * demand byte-identical trades, allocations and P&L deltas.
 *
 * Note on "parallel": JS has one thread, so this proves freedom from shared
 * mutable state across *interleaved* execution, which is exactly the exposure
 * these engines have. The final case shards a grid across concurrent
 * callers and reassembles it, which is how the analytics page actually loads.
 */

const FILE = "src/lib/__tests__/breakout-replay-parallel.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

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

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

type Job = { seed: number; size: number; risk: RiskLevel; gapWeight: number };

/** A deterministic spread of jobs across risks and gap weights. */
function jobs(count: number): Job[] {
  const r = rng(caseSeed(BASE_SEED, "jobs", 0));
  return Array.from({ length: count }, (_, i) => ({
    seed: caseSeed(BASE_SEED, "cohort", i),
    size: 60 + Math.floor(r() * 120),
    risk: RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)],
    gapWeight: DEFAULT_GAP_WEIGHTS[Math.floor(r() * DEFAULT_GAP_WEIGHTS.length)],
  }));
}

/**
 * The full observable output of one replay: the executed tape (which signal was
 * funded and for how much), the per-symbol allocation plan, and the P&L deltas
 * against the flat-1x control.
 */
function replay(job: Job) {
  const trades = cohort(job.seed, job.size);
  const opts = { risk: job.risk, gapWeight: job.gapWeight, limits: LIMITS };
  const summary = applyDriverSizing(trades, opts);
  const base = baselineExecution(trades, LIMITS);
  const plan = driverSizingPlan(trades, opts);

  const confirmed = [...trades]
    .filter((t) => t.cohort === "confirmed")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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

/** Deterministic shuffle so a failing ordering is reproducible from the seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const byKey = (rows: readonly Replay[]) => new Map(rows.map((row) => [row.key, row]));

function expectMatchesBaseline(actual: readonly Replay[], baseline: Map<string, Replay>, ctx: string) {
  expect(actual.length, `job count changed: ${ctx}`).toBe(baseline.size);
  for (const row of actual) {
    const want = baseline.get(row.key);
    expect(want, `unknown replay key ${row.key}: ${ctx}`).toBeDefined();
    expect(row.tape, `tape diverged for ${row.key}: ${ctx}`).toEqual(want!.tape);
    expect(row.allocations, `allocations diverged for ${row.key}: ${ctx}`).toEqual(want!.allocations);
    expect(row.pnl, `P&L deltas diverged for ${row.key}: ${ctx}`).toEqual(want!.pnl);
  }
}

const JOBS = jobs(12);
const BASELINE = byKey(JOBS.map(replay));

describe("parallel seeded replays match the single-threaded baseline", () => {
  it("the sequential baseline is itself stable when re-run", () => {
    // Guards the comparison: if this drifts, everything below is meaningless.
    expectMatchesBaseline(JOBS.map(replay), BASELINE, `sequential re-run — ${REPRO}`);
  });

  it("all replays in flight at once produce identical output", async () => {
    const results = await Promise.all(
      shuffled(JOBS, caseSeed(BASE_SEED, "shuffle", 0)).map(async (job) => {
        // Yield first so every job is queued before any of them computes.
        await Promise.resolve();
        return replay(job);
      }),
    );
    expectMatchesBaseline(results, BASELINE, `concurrent burst — ${REPRO}`);
  });

  it("replays interleaved at await points do not contaminate each other", async () => {
    // Each job is split so its plan, its summary and its tape are computed in
    // separate ticks, guaranteeing other jobs run in between.
    const results = await Promise.all(
      shuffled(JOBS, caseSeed(BASE_SEED, "shuffle", 1)).map(async (job) => {
        const trades = cohort(job.seed, job.size);
        await Promise.resolve();
        driverSizingPlan(trades, { risk: job.risk, gapWeight: job.gapWeight, limits: LIMITS });
        await new Promise((r) => setTimeout(r, 0));
        baselineExecution(trades, LIMITS);
        await Promise.resolve();
        return replay(job);
      }),
    );
    expectMatchesBaseline(results, BASELINE, `interleaved — ${REPRO}`);
  });

  it("running every job repeatedly and concurrently stays identical", async () => {
    // Three concurrent passes over the same jobs: a per-call cache keyed on
    // anything mutable would show up as a second-pass divergence.
    const passes = await Promise.all(
      [0, 1, 2].map((pass) =>
        Promise.all(
          shuffled(JOBS, caseSeed(BASE_SEED, "repeat", pass)).map(async (job) => {
            await Promise.resolve();
            return replay(job);
          }),
        ),
      ),
    );
    passes.forEach((pass, i) => expectMatchesBaseline(pass, BASELINE, `pass ${i} — ${REPRO}`));
  });

  it("interleaving different seeds does not leak cohort state", async () => {
    // Same risk/gap cell for every job, only the cohort differs — so any
    // cross-talk between cohorts shows up as one seed inheriting another's tape.
    const cell = { risk: "balanced" as RiskLevel, gapWeight: 2 };
    const cellJobs = JOBS.map((j) => ({ ...j, ...cell }));
    const expected = byKey(cellJobs.map(replay));

    const results = await Promise.all(
      shuffled(cellJobs, caseSeed(BASE_SEED, "shuffle", 2)).map(async (job, i) => {
        await new Promise((r) => setTimeout(r, i % 3));
        return replay(job);
      }),
    );
    expectMatchesBaseline(results, expected, `mixed seeds, one cell — ${REPRO}`);

    // Sanity: the cohorts really are different, so the check above has teeth.
    const distinct = new Set(results.map((r) => JSON.stringify(r.pnl)));
    expect(distinct.size, `all cohorts produced the same P&L — ${REPRO}`).toBeGreaterThan(1);
  });

  it("a grid sharded across concurrent callers equals the single-pass grid", async () => {
    const trades = cohort(caseSeed(BASE_SEED, "grid", 0), 140);
    const whole = buildExecutionGrid(trades, { limits: LIMITS });

    // Shard by risk level, each shard built concurrently, then reassembled.
    const shards = await Promise.all(
      shuffled(RISK_LEVELS, caseSeed(BASE_SEED, "shuffle", 3)).map(async (risk) => {
        await Promise.resolve();
        return buildExecutionGrid(trades, { limits: LIMITS, risks: [risk] });
      }),
    );

    const merged = new Map(shards.flatMap((g) => g.cells).map((c) => [`${c.risk}@${c.gapWeight}`, c]));
    expect(merged.size, `shards lost cells — ${REPRO}`).toBe(whole.cells.length);
    for (const cell of whole.cells) {
      const got = merged.get(`${cell.risk}@${cell.gapWeight}`);
      expect(got, `missing cell ${cell.risk}@${cell.gapWeight} — ${REPRO}`).toBeDefined();
      expect(got, `sharded cell differs at ${cell.risk}@${cell.gapWeight} — ${REPRO}`).toEqual(cell);
    }
    for (const shard of shards) {
      expect(shard.baseline, `shard baseline drifted — ${REPRO}`).toEqual(whole.baseline);
    }
  });

});
