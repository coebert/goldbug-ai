// Pure decision function for the "learned InsufficientCash" lockout.
//
// Saxo's `SpendingPower` / `CashAvailableForTrading` reads are optimistic:
// per-sub-account ring-fencing, unbooked in-flight fills, and margin
// haircuts can all reduce what the broker actually lets us spend. When Saxo
// has rejected any buy on a portfolio with `InsufficientCash` in the recent
// past, we should stop trying to re-place buys of similar size until a
// subsequent CASH_SYNC observation shows the broker cash figure has grown
// meaningfully — otherwise every hourly tick spams the rejection log with
// the same failing orders.
//
// Extracted from `live-executor.server.ts` so the heuristic can be unit- and
// integration-tested without a live database, broker, or clock.

export interface InsufficientCashReject {
  /** ISO timestamp of when the reject was recorded. */
  at: string;
  symbol?: string;
  quantity?: number;
}

export interface CashSyncObservation {
  /** ISO timestamp the CASH_SYNC row was written. */
  at: string;
  /** brokerCash value written to `live_broker_log.response.brokerCash`. */
  brokerCash: number;
}

export interface LockoutInput {
  /** All InsufficientCash buy rejects within the lookback window,
   *  newest first. Empty means no lockout. */
  rejects: InsufficientCashReject[];
  /** CASH_SYNC observations from `live_broker_log`, any order. Only rows
   *  strictly after the newest reject count towards "grew since reject". */
  cashSyncs: CashSyncObservation[];
  /** Minimum absolute growth (in broker currency) to clear the lockout. */
  minAbsoluteGrowth?: number;
  /** Minimum relative growth (0.05 = 5%) to clear the lockout. */
  minRelativeGrowth?: number;
}

export interface LockoutDecision {
  /** True = block all new buys this tick. */
  lockout: boolean;
  /** Human-readable reason (present when `lockout` is true). */
  reason?: string;
  stats: {
    rejectCount: number;
    newestRejectAt: string | null;
    samplesSinceReject: number;
    minCashSinceReject: number | null;
    maxCashSinceReject: number | null;
    growth: number | null;
    growthThreshold: number | null;
  };
}

const DEFAULT_MIN_ABS = 5;
const DEFAULT_MIN_REL = 0.05;
const LOCKOUT_HOURS = 24;

export function decideInsufficientCashLockout(input: LockoutInput): LockoutDecision {
  const minAbs = input.minAbsoluteGrowth ?? DEFAULT_MIN_ABS;
  const minRel = input.minRelativeGrowth ?? DEFAULT_MIN_REL;

  const rejects = input.rejects
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  if (rejects.length === 0) {
    return {
      lockout: false,
      stats: {
        rejectCount: 0,
        newestRejectAt: null,
        samplesSinceReject: 0,
        minCashSinceReject: null,
        maxCashSinceReject: null,
        growth: null,
        growthThreshold: null,
      },
    };
  }

  const newestRejectAt = rejects[0].at;
  const observations = input.cashSyncs
    .filter((s) => s.at > newestRejectAt && Number.isFinite(s.brokerCash))
    .map((s) => s.brokerCash);

  const hasObservations = observations.length > 0;
  const minSince = hasObservations ? Math.min(...observations) : null;
  const maxSince = hasObservations ? Math.max(...observations) : null;
  const growth = hasObservations && minSince != null && maxSince != null ? maxSince - minSince : null;
  const threshold = minSince != null ? Math.max(minAbs, minSince * minRel) : null;

  const materiallyGrew =
    hasObservations &&
    maxSince != null &&
    minSince != null &&
    maxSince > 0 &&
    growth != null &&
    threshold != null &&
    growth >= threshold;

  const stats = {
    rejectCount: rejects.length,
    newestRejectAt,
    samplesSinceReject: observations.length,
    minCashSinceReject: minSince,
    maxCashSinceReject: maxSince,
    growth,
    growthThreshold: threshold,
  };

  if (materiallyGrew) return { lockout: false, stats };

  return {
    lockout: true,
    reason: `broker rejected buys with InsufficientCash within last ${LOCKOUT_HOURS}h; buys locked out until broker cash grows`,
    stats,
  };
}
