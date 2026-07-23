// Portfolio-level checks that run AFTER per-asset AI decisions:
// 1. Correlation cap — reject/scale trades that push aggregate correlated exposure over a cap.
// 2. Loss cooldown — halve size for N days after a stop-out on the same asset.
// 3. Event awareness — reduce size when a known event (CPI/FOMC/earnings) is within 3 days.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDailyCandles } from "./market-data.server";
import { returnCorrelation } from "./signals-extended.server";

export type LossCooldowns = Record<string, string>; // symbol -> ISO date it becomes eligible again

const COOLDOWN_DAYS = 5;
const CORR_CLUSTER_THRESHOLD = 0.7;
const CORR_CLUSTER_MAX_PCT = 0.35; // max 35% of portfolio in a single correlated cluster

export async function loadLossCooldowns(portfolioId: string): Promise<LossCooldowns> {
  const { data } = await supabaseAdmin
    .from("portfolios")
    .select("loss_cooldowns")
    .eq("id", portfolioId)
    .single();
  const raw = (data?.loss_cooldowns ?? {}) as unknown;
  if (!raw || typeof raw !== "object") return {};
  const out: LossCooldowns = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function saveLossCooldowns(
  portfolioId: string,
  cooldowns: LossCooldowns,
): Promise<void> {
  await supabaseAdmin
    .from("portfolios")
    .update({ loss_cooldowns: cooldowns })
    .eq("id", portfolioId);
}

export function isSymbolCooling(cooldowns: LossCooldowns, symbol: string, asOf: string): boolean {
  const until = cooldowns[symbol];
  if (!until) return false;
  return asOf < until;
}

export function addCooldown(
  cooldowns: LossCooldowns,
  symbol: string,
  asOf: string,
): LossCooldowns {
  const d = new Date(asOf + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + COOLDOWN_DAYS);
  return { ...cooldowns, [symbol]: d.toISOString().slice(0, 10) };
}

export function pruneCooldowns(cooldowns: LossCooldowns, asOf: string): LossCooldowns {
  const out: LossCooldowns = {};
  for (const [k, v] of Object.entries(cooldowns)) if (v > asOf) out[k] = v;
  return out;
}

/** Build a correlation map for the given symbols using recent daily closes. */
export async function buildCorrelationMap(
  symbols: string[],
  asOf: string,
  lookbackDays = 60,
): Promise<Map<string, Map<string, number>>> {
  const closesBySym = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      const c = await getDailyCandles(s, lookbackDays + 5, asOf);
      if (c.length >= 20) closesBySym.set(s, c.map((k) => k.close));
    }),
  );
  const out = new Map<string, Map<string, number>>();
  const list = Array.from(closesBySym.keys());
  for (const a of list) {
    out.set(a, new Map());
    for (const b of list) {
      if (a === b) {
        out.get(a)!.set(b, 1);
        continue;
      }
      const r = returnCorrelation(closesBySym.get(a)!, closesBySym.get(b)!);
      out.get(a)!.set(b, r ?? 0);
    }
  }
  return out;
}

/**
 * For a candidate BUY of `spend` into `symbol`, compute how much of that spend
 * fits under the correlated-cluster cap. Returns the allowed spend.
 */
export function correlatedClusterAllowance(args: {
  symbol: string;
  spend: number;
  totalValue: number;
  existingExposureBySymbol: Map<string, number>; // dollar value per current holding
  corr: Map<string, Map<string, number>>;
}): { allowed: number; cluster: string[]; clusterExposurePct: number } {
  const { symbol, spend, totalValue, existingExposureBySymbol, corr } = args;
  if (totalValue <= 0) return { allowed: spend, cluster: [], clusterExposurePct: 0 };
  const row = corr.get(symbol);
  if (!row) return { allowed: spend, cluster: [], clusterExposurePct: 0 };

  const cluster: string[] = [];
  let clusterExposure = 0;
  for (const [other, r] of row.entries()) {
    if (other === symbol) continue;
    if (r >= CORR_CLUSTER_THRESHOLD) {
      cluster.push(other);
      clusterExposure += existingExposureBySymbol.get(other) ?? 0;
    }
  }
  clusterExposure += existingExposureBySymbol.get(symbol) ?? 0;
  const clusterCap = totalValue * CORR_CLUSTER_MAX_PCT;
  const room = Math.max(0, clusterCap - clusterExposure);
  return {
    allowed: Math.min(spend, room),
    cluster,
    clusterExposurePct: clusterExposure / totalValue,
  };
}

/**
 * Kelly-capped conviction sizing.
 * conviction: model-reported 0..1
 * edge: model-implied expected move fraction (default 0.02 = 2%)
 * baseSize: what the guardrails would otherwise allow (currency)
 * Cap Kelly fraction at 25% for safety.
 */
export function convictionSizedSpend(args: {
  baseSize: number;
  conviction: number;
  edge?: number;
  volPct?: number | null; // 20d daily vol
  kellyCap?: number | null; // tuned per portfolio; defaults to 0.25 for safety
}): number {
  const conviction = Math.max(0, Math.min(1, args.conviction));
  const edge = args.edge ?? 0.02;
  const vol = args.volPct && args.volPct > 0 ? args.volPct : 0.02;
  const cap = args.kellyCap && args.kellyCap > 0 ? Math.min(0.5, args.kellyCap) : 0.25;
  const rawKelly = (edge * conviction) / (vol * vol);
  const kelly = Math.max(0, Math.min(cap, rawKelly));
  // Blend: at low conviction shrink base size aggressively; at high conviction allow full base.
  const scale = 0.25 + 0.75 * conviction;
  const kellyBudget = args.baseSize * (kelly / cap); // normalize so kelly=cap => baseSize
  return Math.min(args.baseSize, Math.max(kellyBudget, args.baseSize * scale * 0.5));
}

/** Detect stop-outs in recent trade history and update the cooldowns map. */
export async function refreshCooldownsFromRecentTrades(
  portfolioId: string,
  asOf: string,
): Promise<LossCooldowns> {
  const cooldowns = pruneCooldowns(await loadLossCooldowns(portfolioId), asOf);
  const since = new Date(asOf + "T00:00:00Z");
  since.setUTCDate(since.getUTCDate() - 3);
  const { data: trades } = await supabaseAdmin
    .from("trades")
    .select("symbol, side, reason, trade_date")
    .eq("portfolio_id", portfolioId)
    .gte("trade_date", since.toISOString().slice(0, 10))
    .lte("trade_date", asOf);
  let changed = false;
  for (const t of trades ?? []) {
    const reason = (t.reason as string | null)?.toLowerCase() ?? "";
    if (t.side === "sell" && reason.includes("stop-loss")) {
      const next = addCooldown(cooldowns, t.symbol, t.trade_date as string);
      if (next[t.symbol] !== cooldowns[t.symbol]) {
        cooldowns[t.symbol] = next[t.symbol];
        changed = true;
      }
    }
  }
  if (changed) await saveLossCooldowns(portfolioId, cooldowns);
  return cooldowns;
}

/** Return market_events within +/- windowDays of asOf that affect symbols or macro. */
export async function upcomingEvents(
  asOf: string,
  symbols: string[],
  windowDays = 3,
): Promise<Array<{ event_date: string; kind: string; symbol: string | null; title: string; impact: string }>> {
  const start = new Date(asOf + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + windowDays);
  const { data } = await supabaseAdmin
    .from("market_events")
    .select("event_date, kind, symbol, title, impact")
    .gte("event_date", asOf)
    .lte("event_date", end.toISOString().slice(0, 10));
  const set = new Set(symbols.map((s) => s.toUpperCase()));
  return (data ?? []).filter((e) => !e.symbol || set.has((e.symbol as string).toUpperCase())) as Array<{
    event_date: string; kind: string; symbol: string | null; title: string; impact: string;
  }>;
}

export const OPTIMIZER_CONSTANTS = {
  COOLDOWN_DAYS,
  CORR_CLUSTER_THRESHOLD,
  CORR_CLUSTER_MAX_PCT,
};
