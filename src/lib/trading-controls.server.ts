// Hard, server-side safety gate consulted immediately before any live broker
// order is routed. This is deliberately independent of the trading logic: even
// if a strategy bug, a prompt injection, or a stolen webhook secret produces a
// flood of buys, these two limits bound the damage.
//
//   * `trading_enabled = false` — global kill switch. Admin-only to flip
//     (see the RLS policy on public.trading_controls).
//   * `daily_notional_limit` — maximum BUY notional that may be routed to the
//     broker in a single UK trading day, summed across all portfolios.
//
// Notional is summed in the instrument's own currency without FX conversion,
// which is intentionally conservative for a GBP-denominated limit: it never
// under-counts a GBP/USD/EUR day materially, and erring low means the gate
// trips earlier rather than later.

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

  const { data: fills } = await supabaseAdmin
    .from("live_fills")
    .select("side, quantity, fill_price, filled_at")
    .gte("filled_at", since);

  let spentToday = 0;
  for (const f of fills ?? []) {
    if (String(f.side).toLowerCase() !== "buy") continue;
    if (ukDayKey(new Date(f.filled_at as string)) !== todayKey) continue;
    const qty = Number(f.quantity ?? 0);
    const px = Number(f.fill_price ?? 0);
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
