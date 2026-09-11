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
  /**
   * Whether SELLs may still route while `enabled` is false. A transient
   * failure to read the controls row must never strand a stop-loss or exit:
   * only an explicit operator kill switch (`trading_enabled = false`) stops
   * risk-reducing orders too.
   */
  sellsEnabled: boolean;
  dailyLimit: number;
  spentToday: number;
  /** Remaining BUY notional allowed today (>= 0). */
  remaining: number;
}

/**
 * The user-set safety multiple for the net-of-cost edge gate (Costs page
 * slider). Falls back to null when unreadable so the gate keeps its tuned
 * default; a missing knob must never disable trading.
 */
export async function loadCostHurdleMultiple(): Promise<number | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("trading_controls")
    .select("cost_hurdle_multiple")
    .eq("id", true)
    .maybeSingle();
  const v = Number((data as { cost_hurdle_multiple?: number | null } | null)?.cost_hurdle_multiple);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Read the singleton controls row and today's routed BUY notional.
 *
 * `scaleFor` lets a practice (non-`live_prod`) book scale the ceiling to its
 * own NAV — the operator's figure is sized for the real account and would
 * otherwise stop a much larger simulated book from testing anything.
 */
export async function loadTradingGate(scaleFor?: {
  mode?: string | null;
  navBase?: number | null;
}): Promise<TradingGate> {
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
      sellsEnabled: true,
      dailyLimit: 0,
      spentToday: 0,
      remaining: 0,
    };
  }

  const { resolveDailyNotionalLimit } = await import("./daily-notional-limit");
  const dailyLimit = resolveDailyNotionalLimit({
    configuredLimit: Number(controls.daily_notional_limit ?? 0),
    mode: scaleFor?.mode ?? "live_prod",
    navBase: scaleFor?.navBase ?? null,
  }).limit;
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
    sellsEnabled: Boolean(controls.trading_enabled),
    haltReason: controls.halt_reason ?? null,
    dailyLimit,
    spentToday,
    remaining: Math.max(0, dailyLimit - spentToday),
  };
}

export interface CoreAllocationSettings {
  /** Share of NAV to hold in the long-term core holding, 0–1.0 = off. */
  targetPct: number;
  /** Ticker of the broad diversified fund used as the core. */
  symbol: string;
  /** Drift allowed either side of the target before topping up or trimming. */
  bandPct: number;
}

/**
 * The owner's core-allocation setting (Risk controls). Reads fail SAFE to
 * "off": an unreadable knob must never start buying on its own.
 */
export async function loadCoreAllocationSettings(): Promise<CoreAllocationSettings> {
  const off: CoreAllocationSettings = { targetPct: 0, symbol: "VWRL.L", bandPct: 0.05 };
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("trading_controls")
      .select("core_allocation_pct, core_symbol, core_band_pct")
      .eq("id", true)
      .maybeSingle();
    if (!data) return off;
    const target = Number(data.core_allocation_pct);
    const band = Number(data.core_band_pct);
    return {
      targetPct: Number.isFinite(target) ? Math.min(0.9, Math.max(0, target)) : 0,
      symbol: String(data.core_symbol || "VWRL.L").toUpperCase(),
      bandPct: Number.isFinite(band) ? Math.min(0.3, Math.max(0.01, band)) : 0.05,
    };
  } catch {
    return off;
  }
}

export interface CashSleeveSettings {
  /** Off by default: an unreadable knob must never start trading on its own. */
  enabled: boolean;
  /** Ticker of the cash-like interest fund. */
  symbol: string;
  /** Cash always kept liquid for trades, charges and settlement, base ccy. */
  buffer: number;
}

/**
 * The owner's cash-sleeve setting (Settings → spare cash). Reads fail SAFE to
 * "off" and to a generous buffer.
 */
export async function loadCashSleeveSettings(): Promise<CashSleeveSettings> {
  const off: CashSleeveSettings = { enabled: false, symbol: "ERNS.L", buffer: 1500 };
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("trading_controls")
      .select("cash_sleeve_enabled, cash_sleeve_symbol, cash_sleeve_buffer")
      .eq("id", true)
      .maybeSingle();
    if (!data) return off;
    const buffer = Number(data.cash_sleeve_buffer);
    return {
      enabled: Boolean(data.cash_sleeve_enabled),
      symbol: String(data.cash_sleeve_symbol || "ERNS.L").toUpperCase(),
      buffer: Number.isFinite(buffer) ? Math.max(0, buffer) : 1500,
    };
  } catch {
    return off;
  }
}
