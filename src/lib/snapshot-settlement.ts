// Settled closes vs provisional rows.
//
// `equity_snapshots` mixes three very different kinds of row and, until now,
// they all rendered identically on the equity curve and in the ledger
// reconciliation views:
//
//   settled      — a past UK trading day valued on that day's official close.
//                  Immutable; safe to quote in performance metrics.
//   intraday     — today's row. It is a mark-to-market of live/last prices and
//                  will keep moving until the close, so quoting it as a
//                  "daily change" overstates certainty (4 Aug is this case).
//   reconstructed — a row written by backfill/revalue/gap-fill rather than by
//                  a run that observed the day. Plausible, but derived.
//
// Everything that needs the distinction (chart tail, day-change stats, ledger
// reconciliation copy) classifies through this module so the rules can't
// diverge between surfaces.

import { ukDayKey } from "@/lib/uk-time";

export type SettlementState = "settled" | "intraday" | "reconstructed";

export type SnapshotRowLite = {
  snapshot_date: string;
  /** `equity_snapshots.source`, when the caller selected it. */
  source?: string | null;
};

/** Sources that never observed the day directly — the value is derived. */
const RECONSTRUCTED_SOURCES = new Set([
  "backfill",
  "revalue",
  "revalue_gap_fill",
  "manual",
]);

export const SETTLEMENT_LABEL: Record<SettlementState, string> = {
  settled: "Settled close",
  intraday: "Intraday (provisional)",
  reconstructed: "Reconstructed",
};

export const SETTLEMENT_HINT: Record<SettlementState, string> = {
  settled: "Valued on the official close for that day.",
  intraday: "Today's live mark — it keeps moving until the market closes.",
  reconstructed: "Rebuilt from the ledger or carried forward, not observed live.",
};

/**
 * Classify one snapshot row.
 *
 * Today (Europe/London) always wins: a row dated today is provisional no
 * matter which writer produced it, because the close hasn't happened yet.
 */
export function classifySnapshot(
  row: SnapshotRowLite,
  now: string | number | Date = new Date(),
): SettlementState {
  const day = ukDayKey(`${String(row.snapshot_date).slice(0, 10)}T12:00:00Z`);
  const today = ukDayKey(now);
  if (day >= today) return "intraday";
  const src = String(row.source ?? "").toLowerCase();
  return RECONSTRUCTED_SOURCES.has(src) ? "reconstructed" : "settled";
}

export function isSettled(
  row: SnapshotRowLite,
  now: string | number | Date = new Date(),
): boolean {
  return classifySnapshot(row, now) === "settled";
}

/** Rows safe to quote in settled performance metrics. */
export function settledRows<T extends SnapshotRowLite>(
  rows: T[],
  now: string | number | Date = new Date(),
): T[] {
  return rows.filter((r) => classifySnapshot(r, now) === "settled");
}

export type SettlementSummary = {
  total: number;
  settled: number;
  intraday: number;
  reconstructed: number;
  /** Last settled close date, or null when the series has none. */
  lastSettledDate: string | null;
  /** Date of the provisional (today's) row, when present. */
  provisionalDate: string | null;
  /** True when the newest row in the series is not a settled close. */
  latestIsProvisional: boolean;
};

export function summariseSettlement(
  rows: SnapshotRowLite[],
  now: string | number | Date = new Date(),
): SettlementSummary {
  const sorted = [...rows]
    .filter((r) => r && r.snapshot_date)
    .sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));

  let settled = 0;
  let intraday = 0;
  let reconstructed = 0;
  let lastSettledDate: string | null = null;
  let provisionalDate: string | null = null;

  for (const r of sorted) {
    const state = classifySnapshot(r, now);
    const date = String(r.snapshot_date).slice(0, 10);
    if (state === "settled") {
      settled++;
      lastSettledDate = date;
    } else if (state === "intraday") {
      intraday++;
      provisionalDate = date;
    } else {
      reconstructed++;
    }
  }

  const latest = sorted[sorted.length - 1];
  return {
    total: sorted.length,
    settled,
    intraday,
    reconstructed,
    lastSettledDate,
    provisionalDate,
    latestIsProvisional: latest ? classifySnapshot(latest, now) !== "settled" : false,
  };
}
