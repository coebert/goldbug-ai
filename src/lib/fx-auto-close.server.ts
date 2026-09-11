/**
 * Automatic close of losing spare currency legs.
 *
 * Runs on every hourly cycle for live books. Values each open FX funding leg
 * at the live rate net of the charge it would cost to close, checks how much
 * of it is still funding foreign holdings, and flattens the ones the rule in
 * `fx-auto-close.ts` condemns. Anything still funding holdings is untouched.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFxPair, valueFxLeg, netClosePnl } from "./fx-leg-quotes";
import { assessFxLegs, type HygieneLegInput } from "./fx-leg-hygiene";
import {
  decideAutoCloses,
  AUTO_CLOSE_DEFAULTS,
  type AutoCloseLeg,
  type AutoCloseSettings,
} from "./fx-auto-close";

export type AutoCloseOutcome = {
  symbol: string;
  closed: boolean;
  lossPctOfLeg: number;
  reason: string;
  detail?: string;
};

export type AutoCloseSweepResult = {
  ran: boolean;
  skipped?: string;
  outcomes: AutoCloseOutcome[];
};

export async function loadAutoCloseSettings(
  supabase: SupabaseClient<any, any, any>,
): Promise<AutoCloseSettings> {
  const { data } = await supabase
    .from("trading_controls")
    .select("fx_auto_close_enabled, fx_auto_close_loss_pct, fx_auto_close_min_notional_base")
    .maybeSingle();
  if (!data) return AUTO_CLOSE_DEFAULTS;
  const lossPct = Number(data.fx_auto_close_loss_pct);
  const minNotional = Number(data.fx_auto_close_min_notional_base);
  return {
    enabled: data.fx_auto_close_enabled !== false,
    lossPct: Number.isFinite(lossPct) && lossPct > 0 ? lossPct : AUTO_CLOSE_DEFAULTS.lossPct,
    minNotionalBase:
      Number.isFinite(minNotional) && minNotional >= 0
        ? minNotional
        : AUTO_CLOSE_DEFAULTS.minNotionalBase,
  };
}

export async function sweepLosingFxLegs(args: {
  supabase: SupabaseClient<any, any, any>;
  userId: string;
  portfolioId: string;
  /** Report only; never places anything. */
  dryRun?: boolean;
}): Promise<AutoCloseSweepResult> {
  const { supabase, portfolioId } = args;
  const settings = await loadAutoCloseSettings(supabase);
  if (!settings.enabled) return { ran: false, skipped: "disabled", outcomes: [] };

  const { getFxRateAudited } = await import("./fx.server");
  const { feeInFromCcy } = await import("./fx-cost-model");

  const [{ data: portfolio }, { data: holdings }] = await Promise.all([
    supabase.from("portfolios").select("currency").eq("id", portfolioId).maybeSingle(),
    supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, asset_class, instrument_ccy, opened_at")
      .eq("portfolio_id", portfolioId),
  ]);
  const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
  const rows = holdings ?? [];

  // How much foreign currency the rest of the book actually needs.
  const exposureByCcy: Record<string, number> = {};
  for (const h of rows) {
    if (h.asset_class === "fx") continue;
    const qty = Number(h.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const ccy = String(h.instrument_ccy ?? baseCcy).toUpperCase();
    exposureByCcy[ccy] = (exposureByCcy[ccy] ?? 0) + qty * Number(h.avg_cost ?? 0);
  }

  const legInputs: HygieneLegInput[] = [];
  const valuation = new Map<string, { pnlBaseNet: number; stale: boolean }>();

  for (const h of rows) {
    if (h.asset_class !== "fx") continue;
    const qty = Number(h.quantity);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const symbol = String(h.symbol);
    const pair = parseFxPair(symbol, h.instrument_ccy ?? null);
    const pairBase = (pair?.base ?? baseCcy).toUpperCase();
    const quoteCcy = (pair?.quote ?? String(h.instrument_ccy ?? baseCcy)).toUpperCase();
    const avgCost = Number(h.avg_cost ?? 0);

    let rate: number | null = null;
    let stale = true;
    try {
      const r = await getFxRateAudited(pairBase, quoteCcy);
      rate = Number(r.rate);
      stale = r.stale === true;
    } catch {
      rate = null;
    }

    // Quote currency -> account currency, so the loss is judged in the money
    // the account is actually kept in.
    let quoteToBase = 1;
    if (quoteCcy !== baseCcy) {
      try {
        const r = await getFxRateAudited(quoteCcy, baseCcy);
        if (Number.isFinite(r.rate) && r.rate > 0) quoteToBase = Number(r.rate);
      } catch {
        stale = true;
      }
    }

    const v = valueFxLeg({ quantity: qty, avgCost, rate: rate ?? avgCost, quoteToBase });
    const { fee, quote: costQuote } = feeInFromCcy(v.notionalQuote, quoteCcy, pairBase, "spot");
    const net = netClosePnl({
      pnlQuote: v.pnlQuote,
      notionalQuote: v.notionalQuote,
      exitCostBps: costQuote.totalBps,
      minFeeQuote: v.notionalQuote > 0 ? Math.min(fee, costQuote.minFeeFrom) : 0,
    });

    let notionalBase = Math.abs(qty);
    if (pairBase !== baseCcy) {
      try {
        const r = await getFxRateAudited(pairBase, baseCcy);
        if (Number.isFinite(r.rate) && r.rate > 0) notionalBase = Math.abs(qty) * Number(r.rate);
      } catch {
        /* leave sized in the pair's base ccy */
      }
    }

    legInputs.push({
      symbol,
      quantity: qty,
      quoteCcy,
      openedAt: h.opened_at ?? null,
      notionalQuote: v.notionalQuote,
      notionalBase,
    });
    valuation.set(symbol, {
      pnlBaseNet: net.pnlQuoteNet * quoteToBase,
      stale: stale || rate == null,
    });
  }

  if (legInputs.length === 0) return { ran: true, outcomes: [] };

  // Age is irrelevant for a losing leg — a bad rate today is bad today.
  const assessments = assessFxLegs(legInputs, exposureByCcy, new Date(), { minAgeDays: 0 });
  const byNotional = new Map(legInputs.map((l) => [l.symbol, l.notionalBase]));

  const legs: AutoCloseLeg[] = assessments.map((a) => ({
    symbol: a.symbol,
    verdict: a.verdict,
    coverRatio: a.coverRatio,
    notionalBase: byNotional.get(a.symbol) ?? 0,
    pnlBaseNet: valuation.get(a.symbol)?.pnlBaseNet ?? Number.NaN,
    stale: valuation.get(a.symbol)?.stale ?? true,
  }));

  const decisions = decideAutoCloses(legs, settings);
  const outcomes: AutoCloseOutcome[] = [];

  for (const d of decisions) {
    if (!d.close || args.dryRun) {
      outcomes.push({ symbol: d.symbol, closed: false, lossPctOfLeg: d.lossPctOfLeg, reason: d.reason });
      continue;
    }
    const { closeFxLegCore } = await import("./fx-leg-close.server");
    const res = await closeFxLegCore({
      supabase,
      userId: args.userId,
      portfolioId,
      symbol: d.symbol,
      automated: true,
    });
    if (res.ok) {
      outcomes.push({ symbol: d.symbol, closed: true, lossPctOfLeg: d.lossPctOfLeg, reason: d.reason });
      await notifyAutoClose(supabase, args.userId, portfolioId, d.symbol, d.lossPctOfLeg, res.pnlQuoteNet, res.toCcy);
    } else {
      outcomes.push({
        symbol: d.symbol,
        closed: false,
        lossPctOfLeg: d.lossPctOfLeg,
        reason: d.reason,
        detail: `${res.reason}: ${res.detail}`,
      });
    }
  }

  return { ran: true, outcomes };
}

async function notifyAutoClose(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  portfolioId: string,
  symbol: string,
  lossPct: number,
  pnl: number,
  ccy: string,
): Promise<void> {
  try {
    await supabase.from("notifications").insert({
      user_id: userId,
      portfolio_id: portfolioId,
      category: "fx_auto_close",
      severity: "info",
      title: `Closed ${symbol} currency position`,
      body: `It was spare currency losing ${lossPct.toFixed(2)}%, so it was closed at the live rate (${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)} ${ccy} after charges).`,
    });
  } catch {
    // notification is best-effort; the close itself is already booked
  }
}
