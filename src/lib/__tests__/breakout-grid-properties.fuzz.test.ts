/**
 * Property-based sweep over the whole execution surface.
 *
 * The determinism and budget suites next door each pin one axis: a fixed
 * cohort, the default caps, one grid shape. Real usage is not that tidy — the
 * analytics page builds a grid over whatever risk levels and gap weights the
 * user has toggled, against whatever cohort the last backtest produced, under
 * caps the risk-controls panel can move. The interesting failures live in the
 * combinations: a cap that only leaks when concurrency is tight and the budget
 * is loose, or a ranking that only becomes order-sensitive once two symbols tie
 * at a particular gap weight.
 *
 * So this suite generates the inputs instead of fixing them. For each case it
 * draws a random cohort, a random subset of risk levels, a random set of gap
 * weights and random (finite) safety caps, then asserts two families of
 * property:
 *
 *   determinism — the grid is identical when rebuilt, when its cells are built
 *     concurrently in a shuffled order, and when it is sharded across
 *     concurrent callers and reassembled. Nothing about the answer may depend
 *     on who else is in flight or on which order the cells were visited.
 *
 *   invariants  — no cell, under any setting, may exceed the caps: no single
 *     position above `maxPositionSize`, never more than `maxConcurrentSignals`
 *     open at once, and aggregate deployment never above `maxTotalDeployedPct`
 *     of the flat-1x baseline (the no-leverage rule). Every reported figure
 *     must be finite, and sizes must be non-negative.
 *
 * Randomness is drawn from the shared fuzz seed, so a red CI run replays
 * exactly with the command printed in the failure message.
 */
import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  buildExecutionGrid,
  DEFAULT_GAP_WEIGHTS,
  type ExecutionCell,
  type ExecutionGrid,
} from "@/lib/breakout-driver-execution";
import { resolveSizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

const FILE = "src/lib/__tests__/breakout-grid-properties.fuzz.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const CASES = 40;
/** Floating-point slack for comparisons of accumulated sizes. */
const EPS = 1e-9;

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Case = {
  index: number;
  seed: number;
  trades: SignalTrade[];
  risks: RiskLevel[];
  gapWeights: number[];
  limits: SizingLimits;
  unrankedSize: number;
  minConfirmed: number;
  label: string;
};

function cohort(r: () => number, size: number): SignalTrade[] {
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 3 + Math.floor(r() * 8);
  // Signals-per-day varies so cohorts range from "one at a time" to heavy
  // same-day clusters, which is where the concurrency cap actually bites.
  const perDay = 1 + Math.floor(r() * 4);
  return Array.from({ length: size }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / perDay)),
    cohort: r() < 0.8 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.004 + r() * 0.04,
    atrPct: 0.005 + r() * 0.04,
    quality: r(),
    penetrationAtr: r() * 3,
    volumeRatio: 0.5 + r() * 2,
    falseBreakoutRate: r() * 0.8,
    ageBars: 1 + Math.floor(r() * 8),
    pendingLatencyBars: Math.floor(r() * 4),
    entry: 100,
    exit: 100 + (r() - 0.45) * 14,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 1 + Math.floor(r() * 12),
    returnPct: (r() - 0.45) * 14,
    maxAdversePct: -r() * 8,
    maxFavourablePct: r() * 8,
  })) as SignalTrade[];
}

/** Draw a non-empty random subset, preserving the canonical order. */
function subset<T>(items: readonly T[], r: () => number): T[] {
  const picked = items.filter(() => r() < 0.6);
  return picked.length ? picked : [items[Math.floor(r() * items.length)]!];
}

function makeCase(index: number): Case {
  const seed = caseSeed(BASE_SEED, "grid-case", index);
  const r = rng(seed);
  // Occasionally an empty cohort: the caps must survive "nothing to size" too.
  const size = r() < 0.08 ? 0 : 10 + Math.floor(r() * 180);
  const trades = cohort(r, size);
  const risks = subset(RISK_LEVELS, r);
  const gapWeights = subset(DEFAULT_GAP_WEIGHTS, r).concat(r() < 0.3 ? [Math.round(r() * 8)] : []);
  // Finite caps only — Infinity is a legitimate "uncapped" request but makes
  // the no-leverage property vacuous, and it has its own dedicated tests.
  const limits = resolveSizingLimits({
    maxPositionSize: Number((0.2 + r() * 2.3).toFixed(3)),
    maxConcurrentSignals: Math.floor(r() * 8),
    maxTotalDeployedPct: Number((10 + r() * 190).toFixed(2)),
  });
  return {
    index,
    seed,
    trades,
    risks,
    gapWeights: [...new Set(gapWeights)],
    limits,
    unrankedSize: Number((r() * 1.6).toFixed(3)),
    minConfirmed: Math.floor(r() * 6),
    label:
      `case ${index} (seed ${seed}, ${trades.length} trades, risks [${risks.join(",")}], ` +
      `gaps [${gapWeights.join(",")}], caps ${limits.maxPositionSize}x / ` +
      `${limits.maxConcurrentSignals} open / ${limits.maxTotalDeployedPct}%)`,
  };
}

const CASE_LIST = Array.from({ length: CASES }, (_, i) => makeCase(i));

function buildGrid(c: Case, risks: readonly RiskLevel[] = c.risks): ExecutionGrid {
  return buildExecutionGrid(c.trades, {
    risks: [...risks],
    gapWeights: c.gapWeights,
    limits: c.limits,
    unrankedSize: c.unrankedSize,
    minConfirmed: c.minConfirmed,
  });
}

const cellKey = (cell: ExecutionCell) => `${cell.risk}@${cell.gapWeight}`;

/** Canonical, order-independent serialisation of a grid's cells. */
function fingerprint(cells: readonly ExecutionCell[]): string {
  return JSON.stringify([...cells].sort((a, b) => cellKey(a).localeCompare(cellKey(b))));
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

describe("execution grid properties over random grids, seeds and risk settings", () => {
  it("rebuilding the same grid is byte-identical (pure function)", () => {
    for (const c of CASE_LIST) {
      const a = fingerprint(buildGrid(c).cells);
      const b = fingerprint(buildGrid(c).cells);
      expect(b, `grid drifted on rebuild — ${c.label} — ${REPRO}`).toBe(a);
    }
  });

  it("cells built concurrently in shuffled order match the single-pass grid", async () => {
    for (const c of CASE_LIST) {
      const whole = buildGrid(c);
      const pairs = whole.cells.map((cell) => ({ risk: cell.risk, gapWeight: cell.gapWeight }));

      const rebuilt = await Promise.all(
        shuffled(pairs, caseSeed(c.seed, "cell-shuffle", 0)).map(async (p) => {
          // Yield first so every cell is queued before any of them computes:
          // shared mutable state shows up as one cell inheriting another's run.
          await Promise.resolve();
          const g = buildExecutionGrid(c.trades, {
            risks: [p.risk],
            gapWeights: [p.gapWeight],
            limits: c.limits,
            unrankedSize: c.unrankedSize,
            minConfirmed: c.minConfirmed,
          });
          return g.cells[0]!;
        }),
      );

      expect(rebuilt.length, `cell count changed — ${c.label} — ${REPRO}`).toBe(whole.cells.length);
      expect(fingerprint(rebuilt), `concurrent cells diverged — ${c.label} — ${REPRO}`).toBe(
        fingerprint(whole.cells),
      );
    }
  });

  it("a grid sharded by risk across concurrent callers reassembles exactly", async () => {
    for (const c of CASE_LIST) {
      const whole = buildGrid(c);
      const shards = await Promise.all(
        shuffled(c.risks, caseSeed(c.seed, "shard", 0)).map(async (risk, i) => {
          await new Promise((res) => setTimeout(res, i % 2));
          return buildGrid(c, [risk]);
        }),
      );
      const merged = shards.flatMap((g) => g.cells);
      expect(merged.length, `shards lost cells — ${c.label} — ${REPRO}`).toBe(whole.cells.length);
      expect(fingerprint(merged), `sharded grid diverged — ${c.label} — ${REPRO}`).toBe(
        fingerprint(whole.cells),
      );
      // The baseline is cohort-only, so every shard must agree on it too.
      for (const shard of shards) {
        expect(shard.baseline, `baseline differed per shard — ${c.label} — ${REPRO}`).toEqual(
          whole.baseline,
        );
      }
    }
  });

  it("many random grids in flight at once stay independent", async () => {
    const expected = new Map(CASE_LIST.map((c) => [c.index, fingerprint(buildGrid(c).cells)]));
    const results = await Promise.all(
      shuffled(CASE_LIST, caseSeed(BASE_SEED, "case-shuffle", 0)).map(async (c) => {
        await Promise.resolve();
        const first = buildGrid(c);
        await new Promise((res) => setTimeout(res, 0));
        const second = buildGrid(c);
        // Interleaved with every other case, both passes must still agree.
        expect(fingerprint(second.cells), `self-inconsistent under load — ${c.label} — ${REPRO}`).toBe(
          fingerprint(first.cells),
        );
        return [c.index, fingerprint(first.cells)] as const;
      }),
    );
    for (const [index, fp] of results) {
      expect(fp, `concurrent case ${index} diverged — ${REPRO}`).toBe(expected.get(index));
    }
  });

  it("no cell ever breaches the position, concurrency or budget caps", () => {
    for (const c of CASE_LIST) {
      const grid = buildGrid(c);
      for (const cell of [...grid.cells, grid.baseline]) {
        const where = `${cellKey(cell as ExecutionCell)} — ${c.label} — ${REPRO}`;
        const report = cell.limits;

        expect(report.peakPositionSize, `position cap breached at ${where}`).toBeLessThanOrEqual(
          c.limits.maxPositionSize + EPS,
        );
        expect(report.peakConcurrent, `concurrency cap breached at ${where}`).toBeLessThanOrEqual(
          c.limits.maxConcurrentSignals,
        );
        // No leverage: aggregate deployment can never exceed the budget, which
        // is expressed as a % of a flat-1x book.
        expect(report.deployedPct, `deployment cap breached at ${where}`).toBeLessThanOrEqual(
          c.limits.maxTotalDeployedPct + EPS,
        );
        expect(cell.deployedPct, `summary deployment disagrees with report at ${where}`).toBeCloseTo(
          report.deployedPct,
          9,
        );
        expect(report.deployedPct, `negative deployment at ${where}`).toBeGreaterThanOrEqual(0);
        expect(report.peakPositionSize, `negative position size at ${where}`).toBeGreaterThanOrEqual(0);
        // Caps only ever remove size; they can never ask for more than the drivers did.
        expect(report.deployedPct, `caps increased deployment at ${where}`).toBeLessThanOrEqual(
          report.requestedDeployedPct + EPS,
        );
      }
    }
  });

  it("every reported figure is finite and internally consistent", () => {
    for (const c of CASE_LIST) {
      const grid = buildGrid(c);
      for (const cell of grid.cells) {
        const where = `${cellKey(cell)} — ${c.label} — ${REPRO}`;
        for (const [field, value] of Object.entries({
          avgSize: cell.avgSize,
          deployedPct: cell.deployedPct,
          winRatePct: cell.winRatePct,
          avgReturnPct: cell.avgReturnPct,
          expectancyPct: cell.expectancyPct,
          cumulativeReturnPct: cell.cumulativeReturnPct,
          maxDrawdownPct: cell.maxDrawdownPct,
          returnPerUnitPct: cell.returnPerUnitPct,
        })) {
          expect(Number.isFinite(value), `${field} was ${value} at ${where}`).toBe(true);
        }
        expect(cell.taken + cell.skipped, `taken+skipped != signals at ${where}`).toBe(cell.signals);
        expect(cell.taken, `negative taken at ${where}`).toBeGreaterThanOrEqual(0);
        expect(cell.avgSize, `negative avg size at ${where}`).toBeGreaterThanOrEqual(0);
        expect(cell.winRatePct, `win rate out of range at ${where}`).toBeGreaterThanOrEqual(0);
        expect(cell.winRatePct, `win rate out of range at ${where}`).toBeLessThanOrEqual(100);
        expect(cell.maxDrawdownPct, `drawdown out of range at ${where}`).toBeGreaterThanOrEqual(0);
        // A cap of zero on any axis must mean nothing gets funded.
        if (c.limits.maxPositionSize === 0 || c.limits.maxConcurrentSignals === 0) {
          expect(cell.taken, `funded a signal under a zero cap at ${where}`).toBe(0);
          expect(cell.deployedPct, `deployed under a zero cap at ${where}`).toBe(0);
        }
      }
    }
  });

  it("tightening any single cap never increases deployment (monotonicity)", () => {
    for (const c of CASE_LIST) {
      if (!c.trades.length) continue;
      const loose = buildGrid(c);
      const tightened = buildExecutionGrid(c.trades, {
        risks: c.risks,
        gapWeights: c.gapWeights,
        unrankedSize: c.unrankedSize,
        minConfirmed: c.minConfirmed,
        limits: {
          maxPositionSize: c.limits.maxPositionSize / 2,
          maxConcurrentSignals: Math.floor(c.limits.maxConcurrentSignals / 2),
          maxTotalDeployedPct: c.limits.maxTotalDeployedPct / 2,
        },
      });
      const before = new Map(loose.cells.map((cell) => [cellKey(cell), cell]));
      for (const cell of tightened.cells) {
        const prior = before.get(cellKey(cell))!;
        expect(
          cell.deployedPct,
          `halving the caps raised deployment at ${cellKey(cell)} — ${c.label} — ${REPRO}`,
        ).toBeLessThanOrEqual(prior.deployedPct + EPS);
        expect(
          cell.limits.peakConcurrent,
          `halving the caps raised concurrency at ${cellKey(cell)} — ${c.label} — ${REPRO}`,
        ).toBeLessThanOrEqual(prior.limits.peakConcurrent);
      }
    }
  });

  it("the generated cases actually exercise the caps", () => {
    // Guards the whole suite: properties over a workload that never touches a
    // limit would pass forever. Require real breaches across the corpus.
    let cells = 0;
    let breached = 0;
    let funded = 0;
    for (const c of CASE_LIST) {
      for (const cell of buildGrid(c).cells) {
        cells++;
        const b = cell.limits.breaches;
        if (b.position + b.concurrency + b.budget > 0) breached++;
        if (cell.taken > 0) funded++;
      }
    }
    expect(cells, `no cells generated — ${REPRO}`).toBeGreaterThan(50);
    expect(funded / cells, `almost nothing was funded — ${REPRO}`).toBeGreaterThan(0.3);
    expect(breached / cells, `caps never bit — ${REPRO}`).toBeGreaterThan(0.2);
  });
});
