// Pure fill-matching rules for the SIM environment.
//
// Saxo's SIM (and some LIVE tenants) do NOT expose `/hist/v3/orders`, so once
// an order disappears from `/port/v1/orders/me` we have no authoritative
// broker record of what happened to it. To stop the UI from stranding
// executed orders in `submitted` forever, we apply narrow, conservative
// "presumed filled" rules — extracted here so they can be unit tested in
// isolation from Supabase / the Saxo adapter.
//
// Rules apply ONLY when:
//   - the order is not in the working list (Saxo doesn't know about it any more)
//   - the history endpoint returned nothing (SIM shape: unsupported / 404)
//   - the local status is a non-terminal state we own (pending/submitted/
//     working/partial/error)
//
// Terminal-in-the-broker states (rejected, cancelled, filled) are never
// promoted here — the reconciler decides those from the working list or
// history payload, not from silence.

export type SimFillDecision =
  | { kind: "presumed_filled"; ageMs: number; reason: string }
  | { kind: "presumed_rejected"; ageMs: number; reason: string }
  | { kind: "keep"; reason: string };

export interface SimFillInput {
  orderType: string | null | undefined;
  status: string | null | undefined;
  submittedAt: string | number | Date | null | undefined;
  createdAt: string | number | Date | null | undefined;
  quantity: number;
  hasBrokerOrderId: boolean;
  now?: number;
  /**
   * Market-hours awareness. When `false` we know the venue has not been open
   * at any point between submission and `now`, so we cannot presume the
   * order filled — it's simply queued for the next session. When `true` or
   * omitted (backwards-compat default) the original age-based rules apply.
   */
  marketHadOpenPeriod?: boolean;
  /** Short venue label used in the "keep" reason for logs/UI (e.g. "LSE"). */
  venueLabel?: string;
  /** ISO of the next scheduled session open — surfaced in the reason so the audit trail explains the wait. */
  nextOpenIso?: string | null;
}

export const SIM_PRESUMED_FILL_AFTER_MS = 2 * 60 * 1000; // 2 minutes
export const SIM_LIMIT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
// Anything older than this without any broker signal is presumed rejected
// (the broker never accepted it) rather than presumed filled.
export const SIM_STALE_UNRECOVERABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const NON_TERMINAL_STATUSES = new Set([
  "pending",
  "submitted",
  "working",
  "partial",
  "error",
]);

function toMs(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function decideSimFill(input: SimFillInput): SimFillDecision {
  const status = String(input.status ?? "").toLowerCase();
  const orderType = String(input.orderType ?? "market").toLowerCase();
  const now = input.now ?? Date.now();

  if (!NON_TERMINAL_STATUSES.has(status)) {
    return { kind: "keep", reason: `status "${status}" is terminal — reconciler does not override` };
  }

  // An order with no broker id never reached Saxo. It's either an error we
  // already own or a pending write that was never routed — do not synthesise
  // a fill for it.
  if (!input.hasBrokerOrderId) {
    return { kind: "keep", reason: "no broker id — order never left the app" };
  }

  if (!(input.quantity > 0)) {
    return { kind: "keep", reason: "non-positive quantity — cannot fabricate a fill row" };
  }

  const submittedMs = toMs(input.submittedAt) ?? toMs(input.createdAt);
  if (submittedMs == null) {
    return { kind: "keep", reason: "missing submitted_at/created_at — cannot age-check" };
  }
  const ageMs = now - submittedMs;
  if (ageMs < 0) {
    return { kind: "keep", reason: "submitted_at in the future — clock skew, wait" };
  }

  // Market-hours awareness. If the caller has told us the venue has been
  // closed for the entire life of the order, we cannot presume anything —
  // there was literally no session in which Saxo could match a fill. Hold
  // the order (or defer the stale-limit rejection) until the next session.
  // Applies to normal-age orders only; the >7-day unrecoverable branch
  // above still fires so genuinely-abandoned orders don't hang forever.
  const marketClosedThroughout = input.marketHadOpenPeriod === false;

  // Absurdly stale orders with no broker footprint were almost certainly
  // rejected pre-fill (e.g. a SIM tenant issue). Don't mint a fake fill for
  // them; presume rejected so the dashboard stops showing them as in-flight.
  if (ageMs > SIM_STALE_UNRECOVERABLE_AFTER_MS) {
    return {
      kind: "presumed_rejected",
      ageMs,
      reason: `order older than ${Math.round(SIM_STALE_UNRECOVERABLE_AFTER_MS / 86_400_000)}d with no broker record — presumed rejected`,
    };
  }

  if (orderType === "market") {
    if (ageMs <= SIM_PRESUMED_FILL_AFTER_MS) {
      return {
        kind: "keep",
        reason: `market order too fresh (${Math.round(ageMs / 1000)}s) — wait for the working list`,
      };
    }
    if (marketClosedThroughout) {
      const venue = input.venueLabel ? `${input.venueLabel} ` : "";
      const nextOpen = input.nextOpenIso ? ` (next open ${input.nextOpenIso})` : "";
      return {
        kind: "keep",
        reason: `${venue}market closed since submission — presumption deferred until session opens${nextOpen}`,
      };
    }
    return {
      kind: "presumed_filled",
      ageMs,
      reason:
        status === "partial"
          ? "partial market order absent from open list; SIM /hist unsupported — presume balance filled"
          : "market order absent from open list; SIM /hist unsupported — presume filled",
    };
  }

  // Non-market (limit/stop/etc). We never presume these filled — a limit that
  // vanished silently may equally have been cancelled by the broker for
  // stale-quote or session reasons. Only after 24h with no signal do we mark
  // them as presumed cancelled/rejected so operators can act.
  if (ageMs > SIM_LIMIT_STALE_AFTER_MS) {
    if (marketClosedThroughout) {
      const venue = input.venueLabel ? `${input.venueLabel} ` : "";
      const nextOpen = input.nextOpenIso ? ` (next open ${input.nextOpenIso})` : "";
      return {
        kind: "keep",
        reason: `${orderType} order silent >24h but ${venue}market closed throughout — deferring stale-reject until session opens${nextOpen}`,
      };
    }
    return {
      kind: "presumed_rejected",
      ageMs,
      reason: `${orderType} order silent for >24h in SIM — presumed cancelled by broker`,
    };
  }
  return {
    kind: "keep",
    reason: `${orderType} order silent — SIM cannot confirm; leaving as ${status}`,
  };
}

