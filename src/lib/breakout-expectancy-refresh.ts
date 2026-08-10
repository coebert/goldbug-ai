// Pure half of the automatic expectancy refresh.
//
// The live breakout gate (`breakoutRegimeAction`) reads a cohort x regime
// expectancy table. That table was hand-recorded from the Aug-2026 study, so
// it goes stale the moment the tape changes. This module turns a set of
// freshly-backtested windows into a candidate table, and — critically —
// decides whether that candidate is trustworthy enough to go live.
//
// No I/O, no clock, no Supabase: windows in, verdict out. The server half
// (`breakout-expectancy-refresh.server.ts`) does the loading and persisting.

import {
  breakoutRegimeBucket,
  DEFAULT_BREAKOUT_EXPECTANCY,
  type BreakoutCohortKey,
  type BreakoutExpectancyTable,
  type BreakoutRegimeBucket,
  type ExpectancyCell,
} from "./alpha/breakout-regime-policy";

export type WindowStatRow = {
  cohort: string;
  regime: string;
  trades: number;
  expectancyPct: number;
  winRatePct: number;
};

export type ExpectancyWindow = {
  /** Human label, e.g. "12m" — surfaced in the table source string. */
  label: string;
  /** Recency weight; a 12m window should outweigh a 36m one. */
  weight: number;
  from: string | null;
  to: string | null;
  stats: readonly WindowStatRow[];
};

const COHORTS: BreakoutCohortKey[] = ["confirmed", "pending", "failed"];
const BUCKETS: BreakoutRegimeBucket[] = ["bull", "bear", "sideways"];

function isCohort(v: string): v is BreakoutCohortKey {
  return v === "confirmed" || v === "pending" || v === "failed";
}

/**
 * Pool several backtest windows into one expectancy table.
 *
 * Each cell is a trade-count-weighted mean of the windows that observed it,
 * with each window's contribution scaled by its recency weight. `trades` stays
 * the raw observation count (never weighted) because the live gate uses it as
 * a sample-size gate — inflating it would let a thin cell masquerade as proven.
 */
export function mergeExpectancyWindows(
  windows: readonly ExpectancyWindow[],
  meta: { source: string; asOf?: string | null },
): BreakoutExpectancyTable {
  type Acc = { trades: number; wExp: number; wWin: number; w: number };
  const acc = new Map<string, Acc>();

  for (const win of windows) {
    const weight = Number.isFinite(win.weight) && win.weight > 0 ? win.weight : 0;
    if (!weight) continue;
    for (const row of win.stats) {
      if (row.regime === "all" || row.cohort === "all") continue;
      if (!isCohort(row.cohort)) continue;
      const trades = Number.isFinite(row.trades) ? Math.max(0, Math.round(row.trades)) : 0;
      if (trades <= 0) continue;
      const key = `${row.cohort}|${breakoutRegimeBucket(row.regime)}`;
      const cur = acc.get(key) ?? { trades: 0, wExp: 0, wWin: 0, w: 0 };
      const w = weight * trades;
      cur.trades += trades;
      cur.wExp += w * (Number.isFinite(row.expectancyPct) ? row.expectancyPct : 0);
      cur.wWin += w * (Number.isFinite(row.winRatePct) ? row.winRatePct : 0);
      cur.w += w;
      acc.set(key, cur);
    }
  }

  const cells: BreakoutExpectancyTable["cells"] = {};
  for (const [key, a] of acc) {
    const [cohort, bucket] = key.split("|") as [BreakoutCohortKey, BreakoutRegimeBucket];
    if (!a.w) continue;
    const byCohort = (cells[cohort] ??= {});
    byCohort[bucket] = {
      trades: a.trades,
      expectancyPct: round2(a.wExp / a.w),
      winRatePct: round2(a.wWin / a.w),
    };
  }

  return { source: meta.source, asOf: meta.asOf ?? null, cells };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function totalTrades(table: BreakoutExpectancyTable): number {
  let n = 0;
  for (const cohort of COHORTS) {
    for (const bucket of BUCKETS) n += table.cells[cohort]?.[bucket]?.trades ?? 0;
  }
  return n;
}

export type ExpectancyGuardrails = {
  /** Reject the whole candidate below this many pooled observations. */
  minTotalTrades: number;
  /** A cell needs at least this many trades to be published at all. */
  minCellTrades: number;
  /** Reject cells whose |expectancy| exceeds this — almost certainly a bug. */
  maxAbsExpectancyPct: number;
  /** Confirmed x bull/sideways must exist, or the gate has nothing to read. */
  requiredCells: ReadonlyArray<[BreakoutCohortKey, BreakoutRegimeBucket]>;
};

export const DEFAULT_EXPECTANCY_GUARDRAILS: ExpectancyGuardrails = {
  minTotalTrades: 200,
  minCellTrades: 8,
  maxAbsExpectancyPct: 25,
  requiredCells: [
    ["confirmed", "bull"],
    ["confirmed", "sideways"],
  ],
};

export type ExpectancyValidation = {
  ok: boolean;
  /** Candidate with implausible / too-thin cells stripped out. */
  table: BreakoutExpectancyTable;
  totalTrades: number;
  droppedCells: string[];
  reasons: string[];
};

/**
 * Sanity-gate a candidate table before it can steer live sizing.
 *
 * A refresh that silently publishes garbage is worse than a stale table: the
 * gate would veto real trades (or un-veto bad ones) on the strength of a
 * price-feed glitch. So thin/implausible cells are dropped, and a candidate
 * that fails the floor checks is rejected wholesale.
 */
export function validateExpectancyTable(
  candidate: BreakoutExpectancyTable,
  overrides: Partial<ExpectancyGuardrails> = {},
): ExpectancyValidation {
  const g = { ...DEFAULT_EXPECTANCY_GUARDRAILS, ...overrides };
  const cells: BreakoutExpectancyTable["cells"] = {};
  const dropped: string[] = [];
  const reasons: string[] = [];

  for (const cohort of COHORTS) {
    for (const bucket of BUCKETS) {
      const cell = candidate.cells[cohort]?.[bucket];
      if (!cell) continue;
      if (!Number.isFinite(cell.expectancyPct) || !Number.isFinite(cell.winRatePct)) {
        dropped.push(`${cohort}/${bucket}: non-finite stats`);
        continue;
      }
      if (cell.trades < g.minCellTrades) {
        dropped.push(`${cohort}/${bucket}: only ${cell.trades} trades`);
        continue;
      }
      if (Math.abs(cell.expectancyPct) > g.maxAbsExpectancyPct) {
        dropped.push(`${cohort}/${bucket}: implausible expectancy ${cell.expectancyPct}%`);
        continue;
      }
      ((cells[cohort] ??= {}) as Record<string, ExpectancyCell>)[bucket] = cell;
    }
  }

  const table: BreakoutExpectancyTable = {
    source: candidate.source,
    asOf: candidate.asOf ?? null,
    cells,
  };
  const n = totalTrades(table);
  if (n < g.minTotalTrades) reasons.push(`only ${n} pooled trades (need ${g.minTotalTrades})`);
  for (const [cohort, bucket] of g.requiredCells) {
    if (!table.cells[cohort]?.[bucket]) reasons.push(`missing required cell ${cohort}/${bucket}`);
  }

  return { ok: reasons.length === 0, table, totalTrades: n, droppedCells: dropped, reasons };
}

export type CellDiff = {
  cohort: BreakoutCohortKey;
  bucket: BreakoutRegimeBucket;
  before: ExpectancyCell | null;
  after: ExpectancyCell | null;
  deltaExpectancyPct: number | null;
  /** True when the sign of the edge flipped — i.e. the gate's verdict changes. */
  signFlip: boolean;
};

export type ExpectancyDiff = {
  changed: CellDiff[];
  signFlips: CellDiff[];
  added: string[];
  removed: string[];
  summary: string;
};

/** Compare the live table with a candidate so a refresh is auditable. */
export function diffExpectancyTables(
  before: BreakoutExpectancyTable,
  after: BreakoutExpectancyTable,
): ExpectancyDiff {
  const changed: CellDiff[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const cohort of COHORTS) {
    for (const bucket of BUCKETS) {
      const a = before.cells[cohort]?.[bucket] ?? null;
      const b = after.cells[cohort]?.[bucket] ?? null;
      if (!a && !b) continue;
      if (!a && b) added.push(`${cohort}/${bucket}`);
      if (a && !b) removed.push(`${cohort}/${bucket}`);
      const delta = a && b ? round2(b.expectancyPct - a.expectancyPct) : null;
      const signFlip = !!a && !!b && Math.sign(a.expectancyPct) !== Math.sign(b.expectancyPct);
      if (!a || !b || Math.abs(delta ?? 0) > 1e-9 || a.trades !== b.trades) {
        changed.push({ cohort, bucket, before: a, after: b, deltaExpectancyPct: delta, signFlip });
      }
    }
  }

  const signFlips = changed.filter((c) => c.signFlip);
  const summary = changed.length
    ? `${changed.length} cell(s) changed, ${signFlips.length} edge sign flip(s)` +
      (added.length ? `, ${added.length} new` : "") +
      (removed.length ? `, ${removed.length} dropped` : "")
    : "no change";

  return { changed, signFlips, added, removed, summary };
}

/** Serialize for storage / restore from storage, tolerating unknown shapes. */
export function parseExpectancyTable(raw: unknown): BreakoutExpectancyTable | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const cellsRaw = obj["cells"];
  if (!cellsRaw || typeof cellsRaw !== "object") return null;
  const cells: BreakoutExpectancyTable["cells"] = {};
  for (const cohort of COHORTS) {
    const byCohortRaw = (cellsRaw as Record<string, unknown>)[cohort];
    if (!byCohortRaw || typeof byCohortRaw !== "object") continue;
    for (const bucket of BUCKETS) {
      const cellRaw = (byCohortRaw as Record<string, unknown>)[bucket];
      if (!cellRaw || typeof cellRaw !== "object") continue;
      const c = cellRaw as Record<string, unknown>;
      const trades = Number(c["trades"]);
      const expectancyPct = Number(c["expectancyPct"]);
      const winRatePct = Number(c["winRatePct"]);
      if (![trades, expectancyPct, winRatePct].every((n) => Number.isFinite(n))) continue;
      ((cells[cohort] ??= {}) as Record<string, ExpectancyCell>)[bucket] = {
        trades,
        expectancyPct,
        winRatePct,
      };
    }
  }
  if (!Object.keys(cells).length) return null;
  return {
    source: typeof obj["source"] === "string" ? (obj["source"] as string) : "stored table",
    asOf: typeof obj["asOf"] === "string" ? (obj["asOf"] as string) : null,
    cells,
  };
}

/** The table the gate falls back to when nothing has been published yet. */
export const FALLBACK_EXPECTANCY_TABLE = DEFAULT_BREAKOUT_EXPECTANCY;
