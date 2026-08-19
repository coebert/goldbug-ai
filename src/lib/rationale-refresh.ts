/**
 * Cross-component refresh bus for trade-rationale derived views.
 *
 * When market data is refreshed (news reel, regime recompute) or Saxo
 * suitability assessments change (block re-check / clear), the derived
 * rationale levels, confidence and what-if replays are stale. Publishing on
 * this bus invalidates those queries everywhere and lets panels render an
 * inline status line explaining why they just refreshed.
 */

export type RationaleRefreshReason =
  | "market-data"
  | "news"
  | "regime"
  | "broker-assessments";

export type RationaleRefreshEvent = {
  reason: RationaleRefreshReason;
  at: number;
  detail?: string;
};

export const RATIONALE_REFRESH_QUERY_KEYS = [
  "trade-rationale",
  "rule-what-if",
  "signal-weight-history",
] as const;

export const REASON_LABEL: Record<RationaleRefreshReason, string> = {
  "market-data": "market data updated",
  news: "news feed refreshed",
  regime: "market regime recomputed",
  "broker-assessments": "Saxo assessments changed",
};

type Listener = (event: RationaleRefreshEvent) => void;

const listeners = new Set<Listener>();
let last: RationaleRefreshEvent | null = null;

/** Most recent refresh event, or null if none has been published yet. */
export function getLastRationaleRefresh(): RationaleRefreshEvent | null {
  return last;
}

/** Announce that rationale-derived views should recompute. */
export function publishRationaleRefresh(
  reason: RationaleRefreshReason,
  detail?: string,
): RationaleRefreshEvent {
  const event: RationaleRefreshEvent = { reason, at: Date.now(), ...(detail ? { detail } : {}) };
  last = event;
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
      /* a broken subscriber must not break the others */
    }
  }
  return event;
}

/** Subscribe to refresh events; returns an unsubscribe function. */
export function subscribeRationaleRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test helper: drop all subscribers and the last event. */
export function resetRationaleRefreshBus(): void {
  listeners.clear();
  last = null;
}

/** Human phrase for the inline status line. */
export function describeRationaleRefresh(
  event: RationaleRefreshEvent | null,
  now = Date.now(),
): string {
  if (!event) return "Levels are current.";
  const secs = Math.max(0, Math.round((now - event.at) / 1000));
  const ago = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  const suffix = event.detail ? ` — ${event.detail}` : "";
  return `Recalculated ${ago} · ${REASON_LABEL[event.reason]}${suffix}`;
}
