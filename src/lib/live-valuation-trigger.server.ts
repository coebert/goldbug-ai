// Event-driven live valuation refresh.
//
// Broker state changes between hourly runs: an order fills, a stop triggers,
// a manual sell routes, a reconciler discovers a fill Saxo never told us
// about. Waiting for the next tick to re-value meant the app's equity could
// sit stale for up to an hour after a real position change. Every place that
// learns of new broker positions or cash calls `triggerLiveValuationRefresh`
// and the numbers catch up immediately.
//
// Fire-and-forget by design: the caller is on the trading path and must not
// wait for (or fail on) a valuation read. A short per-portfolio cooldown
// collapses bursts — routing five orders in one tick refreshes once, not
// five times.

const COOLDOWN_MS = 15_000;

const lastRefreshAt = new Map<string, number>();
const inFlight = new Set<string>();

/** Test seam: forget cooldown state. */
export function resetLiveValuationTriggerState(): void {
  lastRefreshAt.clear();
  inFlight.clear();
}

export function shouldRefreshNow(
  portfolioId: string,
  now: number = Date.now(),
  cooldownMs: number = COOLDOWN_MS,
): boolean {
  if (inFlight.has(portfolioId)) return false;
  const last = lastRefreshAt.get(portfolioId);
  return last == null || now - last >= cooldownMs;
}

/**
 * Re-value a live portfolio now because broker data changed.
 * Never throws and never blocks the caller.
 */
export function triggerLiveValuationRefresh(input: {
  portfolioId: string;
  userId: string;
  reason: string;
  /** Await the refresh instead of firing it off (used by tests/manual flows). */
  wait?: boolean;
}): Promise<void> | void {
  const { portfolioId, userId, reason } = input;
  if (!portfolioId || !userId) return;
  if (!shouldRefreshNow(portfolioId)) return;

  inFlight.add(portfolioId);
  const run = (async () => {
    try {
      const { refreshLiveValuation } = await import(
        "@/lib/live-valuation-refresh.server"
      );
      const res = await refreshLiveValuation(portfolioId, userId);
      if (!res.refreshed) {
        console.warn("live valuation trigger skipped", reason, res.reason);
        return;
      }
      const { reconcileLiveEquityAgainstBroker } = await import(
        "@/lib/live-equity-reconcile.server"
      );
      const rec = await reconcileLiveEquityAgainstBroker(portfolioId, userId);
      if (rec.checked && rec.drift.severity !== "ok") {
        console.warn(
          `live valuation trigger (${reason}): equity drift ${rec.drift.severity} — ${rec.drift.note}`,
        );
      }
    } catch (e) {
      console.warn("live valuation trigger failed", reason, e);
    } finally {
      lastRefreshAt.set(portfolioId, Date.now());
      inFlight.delete(portfolioId);
    }
  })();

  if (input.wait) return run;
  void run;
}
