// Hard, server-side safety gate consulted immediately before any live broker
// order is routed. This is deliberately independent of the trading logic: even
// if a strategy bug, a prompt injection, or a stolen webhook secret produces a
// flood of buys, these two limits bound the damage.
//
//   * `trading_enabled = false` — global kill switch. Admin-only to flip
//     (see the RLS policy on public.trading_controls).
//   * `daily_notional_limit` — maximum BUY notional that may be routed to the
//     broker in a single UK trading day, summed across real-money portfolios.
// Two things the running total must get right, both of which have bitten us:
//
//   * Only REAL-money (`live_prod`) fills count. Simulated portfolios route
//     nothing to the broker, so charging their fills against the cap silently
//     burns the whole day's real budget — on 10 Aug 2026 two sim fills
//     "spent" £671k of a £10k limit and blocked every live buy, NVDA included.
//   * Notional must be in base units. LSE tickers fill in pence, so a raw
//     quantity x fill_price on GLEN.L over-counts by 100x.
//
// Notional is summed in the instrument's own currency without FX conversion,
// which is intentionally conservative for a GBP-denominated limit: it never
// under-counts a GBP/USD/EUR day materially, and erring low means the gate
// trips earlier rather than later.

import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import { ukDayKey } from "@/lib/uk-time";


export interface TradingGate {
  enabled: boolean;
  haltReason: string | null;
  dailyLimit: number;
  spentToday: number;
  /** Remaining BUY notional allowed today (>= 0). */
  remaining: number;
}

/** Read the singleton controls row and today's routed BUY notional. */
export async function loadTradingGate(): Promise<TradingGate> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: controls } = await supabaseAdmin
    .from("trading_controls")
    .select("trading_enabled, daily_notional_limit, halt_reason")
    .eq("id", true)
    .maybeSingle();

  // Fail CLOSED: if the controls row cannot be read we do not trade.
  if (!controls) {
    return {
      enabled: false,
      haltReason: "trading_controls unreadable",
      dailyLimit: 0,
      spentToday: 0,
      remaining: 0,
    };
  }

  const dailyLimit = Number(controls.daily_notional_limit ?? 0);
  const todayKey = ukDayKey(new Date());
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();

  // Only real-money portfolios can consume the broker budget.
  const { data: realPortfolios } = await supabaseAdmin
    .from("portfolios")
    .select("id")
    .eq("mode", "live_prod");
  const realIds = new Set((realPortfolios ?? []).map((p) => String(p.id)));

  const { data: fills } = realIds.size
    ? await supabaseAdmin
        .from("live_fills")
        .select("side, quantity, fill_price, filled_at, symbol, portfolio_id")
        .in("portfolio_id", [...realIds])
        .gte("filled_at", since)
    : { data: [] as never[] };

  let spentToday = 0;
  for (const f of fills ?? []) {
    if (!realIds.has(String(f.portfolio_id))) continue;
    if (String(f.side).toLowerCase() !== "buy") continue;
    if (ukDayKey(new Date(f.filled_at as string)) !== todayKey) continue;
    const qty = Number(f.quantity ?? 0);
    // Pence-quoted LSE fills land here in GBX; the cap is a base-currency figure.
    const px = normalizeLseDisplayPriceToBase(String(f.symbol ?? ""), Number(f.fill_price ?? 0));
    if (Number.isFinite(qty) && Number.isFinite(px)) spentToday += qty * px;
  }


  return {
    enabled: Boolean(controls.trading_enabled),
    haltReason: controls.halt_reason ?? null,
    dailyLimit,
    spentToday,
    remaining: Math.max(0, dailyLimit - spentToday),
  };
}
