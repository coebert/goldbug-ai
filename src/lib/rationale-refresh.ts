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
  /** How many publishes were coalesced into this delivery (>=1). */
  coalesced?: number;
};

export const RATIONALE_REFRESH_QUERY_KEYS = [
  "trade-rationale",
  "rule-what-if",
  "signal-weight-history",
] as const;

/** Quiet period after the last publish before subscribers are notified. */
export const RATIONALE_REFRESH_DEBOUNCE_MS = 800;
/** Never delay a delivery longer than this, even under a constant stream. */
export const RATIONALE_REFRESH_MAX_WAIT_MS = 3_000;

export const REASON_LABEL: Record<RationaleRefreshReason, string> = {
  "market-data": "market data updated",
  news: "news feed refreshed",
  regime: "market regime recomputed",
  "broker-assessments": "Saxo assessments changed",
};

type Listener = (event: RationaleRefreshEvent) => void;

const listeners = new Set<Listener>();
let last: RationaleRefreshEvent | null = null;

let pending: RationaleRefreshEvent | null = null;
let pendingCount = 0;
let firstPendingAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Most recent delivered refresh event, or null if none has been delivered. */
export function getLastRationaleRefresh(): RationaleRefreshEvent | null {
  return last;
}

/** True while publishes are being coalesced and not yet delivered. */
export function hasPendingRationaleRefresh(): boolean {
  return pending !== null;
}

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function deliver() {
  clearTimer();
  const event = pending;
  pending = null;
  const count = pendingCount;
  pendingCount = 0;
  firstPendingAt = 0;
  if (!event) return;
  const delivered: RationaleRefreshEvent = { ...event, coalesced: count };
  last = delivered;
  for (const fn of [...listeners]) {
    try {
      fn(delivered);
    } catch {
      /* a broken subscriber must not break the others */
    }
  }
}

/**
 * Announce that rationale-derived views should recompute.
 *
 * Rapid bursts (a news refresh that also recomputes the regime, several Saxo
 * block clears in a row) are coalesced: subscribers are notified once, after a
 * short quiet period, with the latest reason — bounded by a max wait so a
 * continuous stream still refreshes.
 */
export function publishRationaleRefresh(
  reason: RationaleRefreshReason,
  detail?: string,
): RationaleRefreshEvent {
  const event: RationaleRefreshEvent = { reason, at: Date.now(), ...(detail ? { detail } : {}) };
  pending = event;
  pendingCount += 1;
  if (firstPendingAt === 0) firstPendingAt = event.at;

  clearTimer();
  const elapsed = event.at - firstPendingAt;
  const wait = Math.max(0, Math.min(RATIONALE_REFRESH_DEBOUNCE_MS, RATIONALE_REFRESH_MAX_WAIT_MS - elapsed));
  timer = setTimeout(deliver, wait);
  return event;
}

/** Deliver any coalesced event immediately (tests, unmount, forced refresh). */
export function flushRationaleRefresh(): void {
  deliver();
}

/** Subscribe to refresh events; returns an unsubscribe function. */
export function subscribeRationaleRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test helper: drop all subscribers, pending work and the last event. */
export function resetRationaleRefreshBus(): void {
  clearTimer();
  listeners.clear();
  pending = null;
  pendingCount = 0;
  firstPendingAt = 0;
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
