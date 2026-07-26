// Adaptive buy-order cap.
//
// The learned-InsufficientCash lockout is a hard on/off gate: it blocks every
// new buy for the tick until broker cash grows. That's the right response to
// a "recent reject + no growth" state, but it's too coarse for the common
// steady state where SOME buys succeed and some are rejected — e.g. Saxo is
// currently rejecting orders above ~£30 but accepting smaller ones. In that
// world we still want to trade, just at a size the broker will actually fill.
//
// This module computes:
//   * `rejectRate` — fraction of recent buys that came back as
//     InsufficientCash (bounded [0, 1]).
//   * `learnedCeiling` — the largest single buy notional we've seen Saxo
//     ACCEPT recently. Falls back to a fraction of the smallest recently-
//     rejected notional when we have no acceptances to learn from. This
//     encodes "what actually works" independently of the broker's optimistic
//     `SpendingPower` read.
//   * `aggregateMultiplier` — a haircut on `brokerCashAvailable` proportional
//     to the reject rate, floored at 25% so trading never fully stops here
//     (the lockout handles the "stop entirely" case).
//   * `perOrderCap` / `aggregateCap` — the two numbers the executor should
//     enforce before sending orders.
//
// Pure, no I/O. Extracted so it can be unit-tested and swapped out.

export type BuySampleStatus = "filled" | "submitted" | "partial" | "rejected" | "error";

export interface BuySample {
  status: BuySampleStatus;
  /** Notional in ACCOUNT (broker) currency, i.e. quantity × price × fxRate. */
  notionalAcctCcy: number;
  /** Present when status is "rejected"/"error". */
  rejectReason?: string | null;
}

export interface AdaptiveBuyCapInput {
  /** Latest reconciled broker spendable in account currency, or null when unknown. */
  brokerCashAvailable: number | null;
  /** Recent buys on this portfolio (typically last 24h), any order. */
  recentBuys: BuySample[];
  /** Reject rate cannot shrink the multiplier below this. Defaults to 0.25. */
  minMultiplier?: number;
  /** Safety factor applied to the largest recent successful notional. Defaults to 0.95. */
  successCeilingSafety?: number;
  /** Safety factor applied to the smallest recent rejected notional when we
   *  have no successes to learn from. Defaults to 0.5. */
  rejectFallbackSafety?: number;
}

export interface AdaptiveBuyCapResult {
  rejectRate: number;
  aggregateMultiplier: number;
  /** Per-order notional ceiling in account currency. Null = no evidence yet. */
  perOrderCap: number | null;
  /** Aggregate spend cap for the tick in account currency. Null = no broker cash figure known. */
  aggregateCap: number | null;
  /** Raw learned ceiling before safety factors, for logging/introspection. */
  learnedCeiling: number | null;
  /** Whether the ceiling came from a successful buy or a rejected buy. */
  learnedSource: "success" | "reject_floor" | "none";
  samples: { rejects: number; successes: number; total: number };
  /** Human-readable summary suitable for log entries. */
  notes: string;
}

const INSUFFICIENT_CASH_PATTERN = /InsufficientCash/i;

function isInsufficientCashReject(s: BuySample): boolean {
  if (s.status !== "rejected" && s.status !== "error") return false;
  const reason = s.rejectReason ?? "";
  return INSUFFICIENT_CASH_PATTERN.test(reason);
}

function isSuccess(s: BuySample): boolean {
  return s.status === "filled" || s.status === "submitted" || s.status === "partial";
}

export function computeAdaptiveBuyCap(input: AdaptiveBuyCapInput): AdaptiveBuyCapResult {
  const minMultiplier = input.minMultiplier ?? 0.25;
  const successSafety = input.successCeilingSafety ?? 0.95;
  const rejectSafety = input.rejectFallbackSafety ?? 0.5;

  const buys = input.recentBuys.filter(
    (s) => Number.isFinite(s.notionalAcctCcy) && s.notionalAcctCcy > 0,
  );

  const rejects = buys.filter(isInsufficientCashReject);
  const successes = buys.filter(isSuccess);
  const total = rejects.length + successes.length;

  const rejectRate = total > 0 ? rejects.length / total : 0;
  const aggregateMultiplier = Math.max(minMultiplier, 1 - rejectRate);

  let learnedCeiling: number | null = null;
  let learnedSource: "success" | "reject_floor" | "none" = "none";
  if (successes.length > 0) {
    learnedCeiling = Math.max(...successes.map((s) => s.notionalAcctCcy));
    learnedSource = "success";
  } else if (rejects.length > 0) {
    // No successes to learn from — assume the broker won't accept anything at
    // or above the smallest amount it's rejected. Take a conservative fraction.
    const smallestReject = Math.min(...rejects.map((s) => s.notionalAcctCcy));
    learnedCeiling = smallestReject;
    learnedSource = "reject_floor";
  }

  const perOrderCap =
    learnedCeiling == null
      ? null
      : learnedSource === "success"
        ? learnedCeiling * successSafety * aggregateMultiplier
        : learnedCeiling * rejectSafety * aggregateMultiplier;

  const aggregateCap =
    input.brokerCashAvailable != null && Number.isFinite(input.brokerCashAvailable)
      ? Math.max(0, input.brokerCashAvailable * aggregateMultiplier)
      : null;

  const parts: string[] = [];
  parts.push(`rejects=${rejects.length}/${total}`);
  parts.push(`rejectRate=${rejectRate.toFixed(2)}`);
  parts.push(`mult=${aggregateMultiplier.toFixed(2)}`);
  if (perOrderCap != null) {
    parts.push(`perOrderCap=${perOrderCap.toFixed(2)} (${learnedSource})`);
  }
  if (aggregateCap != null) {
    parts.push(`aggCap=${aggregateCap.toFixed(2)}`);
  }
  const notes = parts.join(" ");

  return {
    rejectRate,
    aggregateMultiplier,
    perOrderCap,
    aggregateCap,
    learnedCeiling,
    learnedSource,
    samples: { rejects: rejects.length, successes: successes.length, total },
    notes,
  };
}
