// Keep live portfolios' equity in step with the broker on EVERY hourly run.
//
// The AI tick is gated (market hours, credit budget, once-per-hour) so a live
// portfolio can go many hours without a single decision cycle. Valuation used
// to ride along inside that tick, which meant the app's equity number lagged
// the broker whenever a tick was skipped — overnight, at weekends, or when the
// budget ran out. Marking to market is cheap (two broker reads) and has no AI
// cost, so it runs unconditionally, ahead of every gate.
//
// Never throws: a broker outage must not fail or block the tick.

import { withOwnedClient } from "@/lib/_server/owned-client";

export type LiveValuationRefresh = {
  refreshed: boolean;
  reason?: string;
  totalValue?: number;
  cash?: number;
  positions?: number;
  currency?: string;
};

/**
 * Re-read broker cash + positions, rewrite holdings, today's equity snapshot
 * and the hourly intraday equity point for a live portfolio.
 */
export async function refreshLiveValuation(
  portfolioId: string,
  userId: string,
): Promise<LiveValuationRefresh> {
  const owned = withOwnedClient(userId);
  try {
    const { syncLiveCashFromBroker } = await import("@/lib/live-cash-sync.server");
    const cash = await syncLiveCashFromBroker(portfolioId, owned);

    const { reconcileLiveHoldingsFromBroker } = await import(
      "@/lib/live-holdings-sync.server"
    );
    const holdings = await reconcileLiveHoldingsFromBroker(portfolioId, owned);

    if (holdings.skipped) {
      return { refreshed: false, reason: holdings.reason };
    }
    return {
      refreshed: true,
      totalValue: holdings.newTotalValue,
      cash: cash.skipped ? holdings.brokerCash : cash.newCash,
      positions: holdings.brokerPositions,
      currency: holdings.currency,
    };
  } catch (e) {
    return {
      refreshed: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
