// Detects timing mismatches between the last successful broker cash sync and
// the stored equity_snapshots that the dashboard's real-money totals are
// derived from. If a live portfolio's most recent broker sync recorded a cash
// value that is materially different from — or newer than — the latest
// persisted snapshot, the dashboard's "Real-money equity" tile is showing a
// stale number. Surface it as a warning instead of silently drifting.

export type SnapshotMismatchReason =
  | "no-snapshot-for-broker-sync-day"
  | "snapshot-older-than-broker-sync"
  | "snapshot-cash-diverges-from-broker";

export type SnapshotMismatchInput = {
  portfolioId: string;
  portfolioName: string;
  mode: string | null;
  // ISO date (YYYY-MM-DD) — today, as computed by the server function.
  today: string;
  // Most recent successful CASH_SYNC entry from live_broker_log.
  lastBrokerSync: {
    at: string; // ISO timestamp
    cash: number;
  } | null;
  // Most recent equity_snapshots row for this portfolio.
  latestSnapshot: {
    date: string; // YYYY-MM-DD
    cash: number | null;
    totalValue: number;
  } | null;
};

export type SnapshotMismatch = {
  portfolioId: string;
  portfolioName: string;
  reason: SnapshotMismatchReason;
  detail: string;
  brokerSyncAt: string;
  brokerSyncCash: number;
  snapshotDate: string | null;
  snapshotCash: number | null;
  snapshotTotalValue: number | null;
  divergence: number | null;
};

// Broker cash and snapshot cash can legitimately differ by tiny amounts due
// to FX rounding, fee accrual, or in-flight fills. Match the drift epsilon
// used by live-cash-sync so we don't cry wolf on rounding.
export const SNAPSHOT_CASH_DIVERGENCE_EPSILON = 0.5;

function toYmd(iso: string): string {
  return iso.slice(0, 10);
}

export function detectSnapshotTimingMismatches(
  inputs: SnapshotMismatchInput[],
): SnapshotMismatch[] {
  const out: SnapshotMismatch[] = [];
  for (const input of inputs) {
    // Only real-money portfolios have a broker to sync against; live_sim and
    // paper portfolios don't route to Saxo for cash.
    if (input.mode !== "live_prod") continue;
    if (!input.lastBrokerSync) continue;

    const syncDate = toYmd(input.lastBrokerSync.at);
    const snap = input.latestSnapshot;

    if (!snap) {
      out.push({
        portfolioId: input.portfolioId,
        portfolioName: input.portfolioName,
        reason: "no-snapshot-for-broker-sync-day",
        detail: `Broker cash was synced on ${syncDate} but no equity snapshot has been persisted for this portfolio.`,
        brokerSyncAt: input.lastBrokerSync.at,
        brokerSyncCash: input.lastBrokerSync.cash,
        snapshotDate: null,
        snapshotCash: null,
        snapshotTotalValue: null,
        divergence: null,
      });
      continue;
    }

    if (snap.date < syncDate) {
      out.push({
        portfolioId: input.portfolioId,
        portfolioName: input.portfolioName,
        reason: "snapshot-older-than-broker-sync",
        detail: `Latest snapshot is dated ${snap.date} but the broker cash was synced on ${syncDate}.`,
        brokerSyncAt: input.lastBrokerSync.at,
        brokerSyncCash: input.lastBrokerSync.cash,
        snapshotDate: snap.date,
        snapshotCash: snap.cash,
        snapshotTotalValue: snap.totalValue,
        divergence: null,
      });
      continue;
    }

    // Same-day snapshot exists — verify the broker cash actually landed in
    // it. If snapshot cash is null we can't compare (older snapshot format);
    // skip the divergence check rather than warn on missing data.
    if (snap.cash != null && Number.isFinite(snap.cash)) {
      const divergence = input.lastBrokerSync.cash - snap.cash;
      if (Math.abs(divergence) >= SNAPSHOT_CASH_DIVERGENCE_EPSILON) {
        out.push({
          portfolioId: input.portfolioId,
          portfolioName: input.portfolioName,
          reason: "snapshot-cash-diverges-from-broker",
          detail: `Broker reported ${input.lastBrokerSync.cash.toFixed(2)} cash on ${syncDate} but the ${snap.date} snapshot stored ${snap.cash.toFixed(2)}.`,
          brokerSyncAt: input.lastBrokerSync.at,
          brokerSyncCash: input.lastBrokerSync.cash,
          snapshotDate: snap.date,
          snapshotCash: snap.cash,
          snapshotTotalValue: snap.totalValue,
          divergence,
        });
      }
    }
  }
  return out;
}

// Structured console logger. Kept side-effect-free w.r.t. business logic so
// callers can log opportunistically (e.g. once per server-function call) and
// tests can assert the shape.
export function logSnapshotTimingMismatches(
  mismatches: SnapshotMismatch[],
  logger: Pick<Console, "error"> = console,
): void {
  if (mismatches.length === 0) return;
  logger.error("[real-money-equity] snapshot timing mismatch detected", {
    count: mismatches.length,
    mismatches: mismatches.map((m) => ({
      portfolioId: m.portfolioId,
      reason: m.reason,
      brokerSyncAt: m.brokerSyncAt,
      snapshotDate: m.snapshotDate,
      divergence: m.divergence,
    })),
  });
}
