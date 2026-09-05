// Per-symbol desk view: measured signal strength, dealing cost, live price
// levels and the risk limits in force — merged from the portfolio rules and
// the owner's own per-symbol overrides.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { engineSymbolKey, priceSymbolVariants, resolvePriceSymbol } from "./price-symbol";
import { loadSymbolStrengths } from "./decision-model/symbol-strength.server";
import { loadSymbolExecutionCosts } from "./execution-costs.server";
import { loadSymbolOverrides } from "./symbol-overrides.server";
import { riskPresetConfig } from "./risk-presets";
import { buildTradeLevels, type TradeLevelPlan } from "./trade-levels";
import { effectiveLimits, type EffectiveLimits, type SymbolOverride } from "./symbol-overrides";

export type SymbolDeskRow = {
  symbol: string;
  key: string;
  /** 0..1 measured confidence in this name's signal, null when unmeasured. */
  strength: number | null;
  samples: number;
  ic: number | null;
  tStat: number | null;
  hitRate: number | null;
  meanNetBps: number | null;
  roundTripBps: number | null;
  costMeasured: boolean;
  lastPrice: number | null;
  priceDate: string | null;
  changePct: number | null;
  atrPct: number | null;
  held: boolean;
  quantity: number;
  avgCost: number | null;
  exposurePct: number | null;
  limits: EffectiveLimits;
  override: SymbolOverride | null;
};

export type SymbolDesk = {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  navBase: number;
  base: { maxPositionPct: number | null; stopLossPct: number | null; takeProfitPct: number | null };
  rows: SymbolDeskRow[];
};

export type SymbolDetail = {
  row: SymbolDeskRow;
  levels: TradeLevelPlan | null;
  history: Array<{ date: string; close: number }>;
  portfolioId: string;
  currency: string;
  navBase: number;
  base: SymbolDesk["base"];
};

function num(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function atrPctFrom(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const window = closes.slice(-15);
  let sum = 0;
  for (let i = 1; i < window.length; i += 1) {
    sum += Math.abs((window[i] as number) - (window[i - 1] as number));
  }
  const last = window[window.length - 1] as number;
  if (!last) return null;
  return sum / (window.length - 1) / last;
}

async function loadPortfolio(userId: string, portfolioId?: string) {
  let q = supabaseAdmin
    .from("portfolios")
    .select("id, name, currency, risk_level, risk_config, universe, current_cash, mode, status")
    .eq("user_id", userId);
  if (portfolioId) q = q.eq("id", portfolioId);
  const { data } = await q.order("created_at", { ascending: true });
  const rows = data ?? [];
  return (
    rows.find((r) => r.mode === "live_prod") ??
    rows.find((r) => r.status === "active") ??
    rows[0] ??
    null
  );
}

export async function buildSymbolDesk(args: {
  userId: string;
  portfolioId?: string;
  horizonDays?: number;
}): Promise<SymbolDesk | null> {
  const portfolio = await loadPortfolio(args.userId, args.portfolioId);
  if (!portfolio) return null;

  const preset = riskPresetConfig(Number(portfolio.risk_level ?? 3) || 3);
  const rc = (portfolio.risk_config ?? {}) as Record<string, unknown>;
  const base = {
    maxPositionPct: num(rc.per_symbol_limit_pct) ?? num(preset.per_symbol_limit_pct),
    stopLossPct: num(rc.stop_loss_pct) ?? num(preset.stop_loss_pct),
    takeProfitPct: num(rc.take_profit_pct) ?? num(preset.take_profit_pct),
  };

  const [strengths, costs, overrides, holdingsRes] = await Promise.all([
    loadSymbolStrengths(args.userId, args.horizonDays ?? 5).catch(
      () => new Map<string, Awaited<ReturnType<typeof loadSymbolStrengths>> extends Map<string, infer V> ? V : never>(),
    ),
    loadSymbolExecutionCosts(args.userId).catch(() => new Map()),
    loadSymbolOverrides(args.userId).catch(() => new Map()),
    supabaseAdmin
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", portfolio.id),
  ]);

  const holdings = new Map<string, { quantity: number; avgCost: number }>();
  for (const h of holdingsRes.data ?? []) {
    holdings.set(engineSymbolKey(String(h.symbol)), {
      quantity: Number(h.quantity) || 0,
      avgCost: Number(h.avg_cost) || 0,
    });
  }

  const universe = Array.isArray(portfolio.universe)
    ? (portfolio.universe as unknown[]).map((u) =>
        typeof u === "string" ? u : String((u as { symbol?: string })?.symbol ?? ""),
      )
    : [];

  const keys = new Set<string>();
  for (const s of universe) if (s) keys.add(engineSymbolKey(s));
  for (const k of strengths.keys()) keys.add(k);
  for (const k of holdings.keys()) keys.add(k);
  for (const k of overrides.keys()) keys.add(k);

  const priceSyms = new Set<string>();
  for (const k of keys) for (const v of priceSymbolVariants(k)) priceSyms.add(v);
  const { data: priceRows } = await supabaseAdmin
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", [...priceSyms])
    .order("price_date", { ascending: true })
    .limit(20000);

  const series = new Map<string, Array<{ date: string; close: number }>>();
  for (const p of priceRows ?? []) {
    const k = engineSymbolKey(String(p.symbol));
    const list = series.get(k) ?? [];
    list.push({ date: String(p.price_date), close: Number(p.close) });
    series.set(k, list);
  }

  let navBase = Number(portfolio.current_cash) || 0;
  for (const [k, h] of holdings) {
    const last = series.get(k)?.at(-1)?.close ?? h.avgCost;
    navBase += last * h.quantity;
  }

  const rows: SymbolDeskRow[] = [...keys].map((key) => {
    const st = strengths.get(key) ?? null;
    const cost = costs.get(key) ?? null;
    const ov = (overrides.get(key) as SymbolOverride | undefined) ?? null;
    const held = holdings.get(key) ?? null;
    const hist = series.get(key) ?? [];
    const last = hist.at(-1) ?? null;
    const prev = hist.at(-2) ?? null;
    const closes = hist.map((h) => h.close);
    const exposure = held && last ? held.quantity * last.close : held ? held.quantity * held.avgCost : 0;

    return {
      symbol: st?.symbol ?? resolvePriceSymbol(key),
      key,
      strength: st ? st.strength : null,
      samples: st?.samples ?? 0,
      ic: st?.ic ?? null,
      tStat: st?.tStat ?? null,
      hitRate: st?.hitRate ?? null,
      meanNetBps: st?.meanNetBps ?? null,
      roundTripBps: cost ? cost.roundTripBps : null,
      costMeasured: Boolean(cost?.measured),
      lastPrice: last?.close ?? null,
      priceDate: last?.date ?? null,
      changePct: last && prev && prev.close ? last.close / prev.close - 1 : null,
      atrPct: atrPctFrom(closes),
      held: Boolean(held && held.quantity > 0),
      quantity: held?.quantity ?? 0,
      avgCost: held?.avgCost ?? null,
      exposurePct: navBase > 0 ? exposure / navBase : null,
      limits: effectiveLimits(base, ov),
      override: ov,
    };
  });

  rows.sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1) || a.symbol.localeCompare(b.symbol));

  return {
    portfolioId: String(portfolio.id),
    portfolioName: String(portfolio.name),
    currency: String(portfolio.currency ?? "GBP"),
    navBase,
    base,
    rows,
  };
}

export async function buildSymbolDetail(args: {
  userId: string;
  symbol: string;
  portfolioId?: string;
  horizonDays?: number;
}): Promise<SymbolDetail | null> {
  const desk = await buildSymbolDesk({
    userId: args.userId,
    ...(args.portfolioId ? { portfolioId: args.portfolioId } : {}),
    ...(args.horizonDays == null ? {} : { horizonDays: args.horizonDays }),
  });
  if (!desk) return null;
  const key = engineSymbolKey(args.symbol);
  const row =
    desk.rows.find((r) => r.key === key) ??
    ({
      symbol: resolvePriceSymbol(key),
      key,
      strength: null,
      samples: 0,
      ic: null,
      tStat: null,
      hitRate: null,
      meanNetBps: null,
      roundTripBps: null,
      costMeasured: false,
      lastPrice: null,
      priceDate: null,
      changePct: null,
      atrPct: null,
      held: false,
      quantity: 0,
      avgCost: null,
      exposurePct: null,
      limits: effectiveLimits(desk.base, null),
      override: null,
    } satisfies SymbolDeskRow);

  const { data: priceRows } = await supabaseAdmin
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", priceSymbolVariants(key))
    .order("price_date", { ascending: false })
    .limit(180);
  const history = (priceRows ?? [])
    .map((p) => ({ date: String(p.price_date), close: Number(p.close) }))
    .reverse();

  const levels = buildTradeLevels({
    action: row.held ? "hold" : "buy",
    decisionPrice: row.lastPrice,
    featurePrice: row.lastPrice,
    atrPct: row.atrPct,
    avgCost: row.avgCost,
    currency: desk.currency,
    config: {
      stop_loss_pct: row.limits.stopLossPct,
      take_profit_pct: row.limits.takeProfitPct,
      take_profit_enabled: row.limits.takeProfitPct != null,
    },
  });

  return {
    row,
    levels,
    history,
    portfolioId: desk.portfolioId,
    currency: desk.currency,
    navBase: desk.navBase,
    base: desk.base,
  };
}
