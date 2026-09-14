// Loads everything the daily report needs to explain a portfolio's change in
// value: the measured day/week/month move, what drove it, whether the pattern
// looks likely to persist, and the guardrails that move is already feeding.
//
// All reads go through the caller's RLS-scoped client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

import {
  assessPersistence,
  buildEquitySummary,
  windowTotal,
  type DailyReportEquity,
  type EquityChangeRow,
  type EquityMover,
} from "./daily-report-equity";
import { normalizeLseDisplayPriceToBase } from "./market-price-units";
import { priceSymbolVariants } from "./price-symbol";
import { isFxLegHolding } from "./fx-leg-value";

const EMPTY_PERSISTENCE = {
  direction: "flat" as const,
  runLengthDays: 0,
  dailyVolPct: null,
  concentrationPct: null,
  regime: null,
  verdict: "too_early" as const,
  text: "There is not enough measured history to say whether this pattern continues.",
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function emptyEquity(currency: string): DailyReportEquity {
  const base = {
    currency,
    hasData: false,
    equity: null,
    day: null,
    week: null,
    month: null,
    split: { positions: null, fxLegs: null, fees: null },
    helped: [],
    hurt: [],
    persistence: EMPTY_PERSISTENCE,
    reaction: {
      drawdownPct: null,
      drawdownLimitPct: null,
      dailyLossLimitPct: null,
      haltActive: false,
      haltReason: null,
      cashPct: null,
      targetPerNamePct: null,
      dailyNotionalLimit: null,
      notes: [],
    },
  };
  return { ...base, summary: buildEquitySummary(base) };
}

export async function loadDailyReportEquity(params: {
  db: SupabaseClient<Database>;
  portfolioId: string;
  date: string;
  currency: string;
  /** `decisions.raw` for the day, used only for the recorded market regime. */
  regime?: string | null;
}): Promise<DailyReportEquity> {
  const { db, portfolioId, date } = params;
  const currency = (params.currency || "GBP").toUpperCase();
  const since = shiftIso(date, -45);

  const [changesRes, snapRes, portfolioRes, controlsRes, holdingsRes, fillsRes] = await Promise.all([
    db
      .from("daily_equity_changes")
      .select("change_date, prev_date, prev_equity, equity, pnl, net_flow, pct")
      .eq("portfolio_id", portfolioId)
      .gte("change_date", since)
      .lte("change_date", date)
      .order("change_date", { ascending: true }),
    db
      .from("equity_snapshots")
      .select("snapshot_date, cash, total_value")
      .eq("portfolio_id", portfolioId)
      .lte("snapshot_date", date)
      .order("snapshot_date", { ascending: false })
      .limit(400),
    db
      .from("portfolios")
      .select("risk_config, concentration_cap_pct")
      .eq("id", portfolioId)
      .maybeSingle(),
    db
      .from("trading_controls")
      .select("trading_enabled, halt_reason, daily_notional_limit")
      .limit(1)
      .maybeSingle(),
    db
      .from("holdings")
      .select("symbol, quantity, asset_class, instrument_ccy")
      .eq("portfolio_id", portfolioId)
      .limit(200),
    db
      .from("live_fills")
      .select("fee, currency, filled_at")
      .eq("portfolio_id", portfolioId)
      .gte("filled_at", `${date}T00:00:00.000Z`)
      .lte("filled_at", `${date}T23:59:59.999Z`),
  ]);

  const rows: EquityChangeRow[] = (changesRes.data ?? []).map((r) => ({
    date: String(r.change_date),
    prevDate: (r.prev_date as string | null) ?? null,
    prevEquity: num(r.prev_equity),
    equity: num(r.equity),
    pnl: num(r.pnl),
    netFlow: num(r.net_flow),
    pct: r.pct == null ? null : num(r.pct),
  }));

  const today = rows.find((r) => r.date === date) ?? null;
  if (!today) return emptyEquity(currency);

  // --- FX rates for anything not already in the base currency -----------
  const holdings = (holdingsRes.data ?? []).filter((h) => Number(h.quantity));
  const { loadFxRates } = await import("./valuation/value-holdings.server");
  const currencies = new Set<string>();
  for (const h of holdings) currencies.add(String(h.instrument_ccy || currency).toUpperCase());
  for (const f of fillsRes.data ?? []) currencies.add(String(f.currency || currency).toUpperCase());
  const rates = await loadFxRates(currencies, currency);
  const rateFor = (ccy: string): number =>
    ccy.toUpperCase() === currency ? 1 : (rates.get(`${ccy.toUpperCase()}>${currency}`) ?? 1);

  // --- broker charges booked that day ------------------------------------
  let fees = 0;
  for (const f of fillsRes.data ?? []) {
    const amt = Number(f.fee);
    if (!Number.isFinite(amt) || amt === 0) continue;
    fees += amt * rateFor(String(f.currency || currency));
  }

  // --- per-holding contribution to the day's move ------------------------
  const prevDate = today.prevDate ?? shiftIso(date, -1);
  const symbolVariants = new Map<string, string[]>();
  for (const h of holdings) {
    const s = String(h.symbol);
    symbolVariants.set(s, Array.from(new Set([s, ...priceSymbolVariants(s)])));
  }
  const allVariants = [...new Set([...symbolVariants.values()].flat())];
  const closeBySymbolDate = new Map<string, number>();
  if (allVariants.length > 0) {
    for (let i = 0; i < allVariants.length; i += 60) {
      const chunk = allVariants.slice(i, i + 60);
      const { data } = await db
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", chunk)
        .gte("price_date", shiftIso(prevDate, -7))
        .lte("price_date", date)
        .order("price_date", { ascending: true });
      for (const b of data ?? []) {
        const close = Number(b.close);
        if (!Number.isFinite(close) || close <= 0) continue;
        closeBySymbolDate.set(`${String(b.symbol).toUpperCase()}|${String(b.price_date)}`, close);
      }
    }
  }

  /** Latest close at or before `on`, searching a week back. */
  const closeAt = (symbol: string, on: string): number | null => {
    for (const variant of symbolVariants.get(symbol) ?? [symbol]) {
      for (let back = 0; back <= 7; back += 1) {
        const v = closeBySymbolDate.get(`${variant.toUpperCase()}|${shiftIso(on, -back)}`);
        if (v != null) return v;
      }
    }
    return null;
  };

  const movers: EquityMover[] = [];
  let fxLegs = 0;
  for (const h of holdings) {
    const symbol = String(h.symbol);
    const qty = num(h.quantity);
    const assetClass = (h.asset_class as string | null) ?? null;
    const curClose = closeAt(symbol, date);
    const prevClose = closeAt(symbol, prevDate);
    if (curClose == null || prevClose == null) continue;
    const isFx = isFxLegHolding({ asset_class: assetClass });
    const ccy = String(h.instrument_ccy || currency).toUpperCase();
    const normalise = (p: number) =>
      isFx ? p : normalizeLseDisplayPriceToBase(symbol, p, assetClass);
    const delta = (normalise(curClose) - normalise(prevClose)) * qty * (isFx ? 1 : rateFor(ccy));
    if (!Number.isFinite(delta) || delta === 0) continue;
    if (isFx) {
      fxLegs += delta;
      continue;
    }
    movers.push({
      symbol,
      contribution: Math.round(delta * 100) / 100,
      pricePct: prevClose > 0 ? Math.round(((curClose / prevClose - 1) * 100) * 100) / 100 : null,
    });
  }
  movers.sort((a, b) => b.contribution - a.contribution);
  const helped = movers.filter((m) => m.contribution > 0).slice(0, 3);
  const hurt = movers
    .filter((m) => m.contribution < 0)
    .slice(-3)
    .reverse();

  const positions = Math.round((today.pnl - fxLegs + fees) * 100) / 100;

  // --- guardrail state the move is already feeding -----------------------
  const snaps = snapRes.data ?? [];
  const latest = snaps[0] ?? null;
  const peak = snaps.reduce((acc, s) => Math.max(acc, num(s.total_value)), 0);
  const equity = today.equity || num(latest?.total_value);
  const cash = latest ? num(latest.cash) : null;
  const riskConfig = (portfolioRes.data?.risk_config ?? {}) as Record<string, unknown>;
  const pctOf = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n <= 1 ? n * 100 : n;
  };
  const drawdownLimitPct = pctOf(riskConfig["max_drawdown_halt_pct"]);
  const dailyLossLimitPct = pctOf(riskConfig["max_daily_loss_pct"]);
  const targetPerNamePct = pctOf(riskConfig["max_position_pct"]) ?? pctOf(portfolioRes.data?.concentration_cap_pct);
  const drawdownPct = peak > 0 && equity > 0 ? Math.round(((peak - equity) / peak) * 10000) / 100 : null;
  const controls = controlsRes.data ?? null;
  const haltActive = controls ? controls.trading_enabled === false : false;

  const notes: string[] = [];
  if (drawdownPct != null && drawdownLimitPct != null && drawdownPct >= drawdownLimitPct * 0.6) {
    notes.push(
      "Because the account is closer to its stop-buying level, new positions are being sized more cautiously.",
    );
  }
  if (today.pnl < 0 && hurt.length > 0) {
    notes.push(
      `${hurt[0]!.symbol} losing money is remembered by the engine: it tightens that holding's protective stop and makes a fresh buy in the same name harder to justify.`,
    );
  }
  if (movers.length === 0) {
    notes.push(
      "Per-holding attribution was not available for this date, so the split above is measured at account level only.",
    );
  }

  const persistence = assessPersistence({
    rows,
    endDate: date,
    movers,
    regime: params.regime ?? null,
  });

  const base: Omit<DailyReportEquity, "summary"> = {
    currency,
    hasData: true,
    equity: equity || null,
    day: {
      pnl: today.pnl,
      pct: today.pct,
      days: 1,
      fromDate: today.prevDate,
      toDate: today.date,
    },
    week: windowTotal(rows, date, 7),
    month: windowTotal(rows, date, 30),
    split: { positions, fxLegs: Math.round(fxLegs * 100) / 100, fees: Math.round(fees * 100) / 100 },
    helped,
    hurt,
    persistence,
    reaction: {
      drawdownPct,
      drawdownLimitPct,
      dailyLossLimitPct,
      haltActive,
      haltReason: (controls?.halt_reason as string | null) ?? null,
      cashPct: cash != null && equity > 0 ? Math.round((cash / equity) * 1000) / 10 : null,
      targetPerNamePct,
      dailyNotionalLimit:
        controls?.daily_notional_limit == null ? null : num(controls.daily_notional_limit),
      notes,
    },
  };

  return { ...base, summary: buildEquitySummary(base) };
}
