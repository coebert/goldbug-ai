// Phase 4 — Signal attribution + walk-forward re-calibration.
// Reads each stored decision's raw JSON (orders + executed + signal_weights)
// and joins it to forward P&L over a horizon. Produces:
//   1. per-signal-bucket win rate + avg return (attribution)
//   2. a suggested prior over the five signal buckets (walk-forward re-cal)
// The prior gets injected into the AI prompt so losing signal sources are
// down-weighted in future decisions.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "./market-data.server";

export type SignalKey =
  | "sma_trend"
  | "rsi"
  | "price_change"
  | "news_sentiment"
  | "volatility";

export const SIGNAL_KEYS: SignalKey[] = [
  "sma_trend",
  "rsi",
  "price_change",
  "news_sentiment",
  "volatility",
];

export type AttributionRow = {
  signal: SignalKey;
  weighted_trades: number; // sum of weights across attributed trades
  weighted_wins: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  contribution_pct: number; // share of total attributed P&L (signed)
};

export type AttributionReport = {
  window_days: number;
  horizon_days: number;
  attributed_trades: number;
  rows: AttributionRow[];
  suggested_prior: Record<SignalKey, number>; // sums to 100
  notes: string;
};

const DEFAULT_PRIOR: Record<SignalKey, number> = {
  sma_trend: 25,
  rsi: 20,
  price_change: 20,
  news_sentiment: 20,
  volatility: 15,
};

function normalizePrior(p: Record<SignalKey, number>): Record<SignalKey, number> {
  const sum = SIGNAL_KEYS.reduce((a, k) => a + Math.max(0, p[k] ?? 0), 0);
  if (sum <= 0) return { ...DEFAULT_PRIOR };
  const out = { ...DEFAULT_PRIOR };
  for (const k of SIGNAL_KEYS) out[k] = (Math.max(0, p[k] ?? 0) / sum) * 100;
  return out;
}

type StoredOrder = {
  symbol?: string;
  side?: "buy" | "sell";
  signal_weights?: Partial<Record<SignalKey, number>>;
};

export async function computeAttribution(
  portfolioId: string,
  asOf: string,
  windowDays = 45,
  horizonDays = 5,
): Promise<AttributionReport> {
  const since = new Date(asOf);
  since.setDate(since.getDate() - Math.ceil(windowDays * 1.5));
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: decisions } = await supabaseAdmin
    .from("decisions")
    .select("run_date, raw")
    .eq("portfolio_id", portfolioId)
    .gte("run_date", sinceStr)
    .lte("run_date", asOf)
    .order("run_date", { ascending: true });

  const per: Record<SignalKey, { wTrades: number; wWins: number; wReturnSum: number; contrib: number }> = {
    sma_trend: { wTrades: 0, wWins: 0, wReturnSum: 0, contrib: 0 },
    rsi: { wTrades: 0, wWins: 0, wReturnSum: 0, contrib: 0 },
    price_change: { wTrades: 0, wWins: 0, wReturnSum: 0, contrib: 0 },
    news_sentiment: { wTrades: 0, wWins: 0, wReturnSum: 0, contrib: 0 },
    volatility: { wTrades: 0, wWins: 0, wReturnSum: 0, contrib: 0 },
  };
  let attributed = 0;

  for (const d of decisions ?? []) {
    const raw = d.raw as unknown;
    if (!raw || typeof raw !== "object") continue;
    const orders = (raw as { orders?: StoredOrder[] }).orders ?? [];
    const executed = (raw as { executed?: Array<{ symbol: string; side: string; quantity: number; price: number; rejected?: string }> }).executed ?? [];
    const executedMap = new Map<string, { side: string; price: number }>();
    for (const e of executed) {
      if (!e.rejected && e.quantity > 0) executedMap.set(`${e.symbol}:${e.side}`, { side: e.side, price: e.price });
    }
    // Forward return from run_date to horizon
    for (const o of orders) {
      if (!o.symbol || !o.side || !o.signal_weights) continue;
      const key = `${o.symbol.toUpperCase()}:${o.side}`;
      const ex = executedMap.get(key);
      if (!ex) continue; // only score trades that actually executed
      const tradeDate = d.run_date as string;
      const target = new Date(tradeDate);
      target.setDate(target.getDate() + horizonDays);
      const exitDate = target > new Date(asOf) ? asOf : target.toISOString().slice(0, 10);
      const exit = await getPriceOn(o.symbol, exitDate).catch(() => null);
      if (exit == null || exit <= 0 || ex.price <= 0) continue;
      const raw_r = (exit - ex.price) / ex.price;
      const signed = o.side === "buy" ? raw_r : -raw_r;
      const weights = o.signal_weights;
      const totalW = SIGNAL_KEYS.reduce((a, k) => a + Math.max(0, Number(weights[k] ?? 0)), 0);
      if (totalW <= 0) continue;
      attributed++;
      for (const k of SIGNAL_KEYS) {
        const w = Math.max(0, Number(weights[k] ?? 0)) / totalW; // fractional attribution
        per[k].wTrades += w;
        if (signed >= 0) per[k].wWins += w;
        per[k].wReturnSum += w * signed;
        per[k].contrib += w * signed; // signed contribution
      }
    }
  }

  const totalAbsContrib = SIGNAL_KEYS.reduce((a, k) => a + Math.abs(per[k].contrib), 0);

  const rows: AttributionRow[] = SIGNAL_KEYS.map((k) => {
    const p = per[k];
    return {
      signal: k,
      weighted_trades: Number(p.wTrades.toFixed(3)),
      weighted_wins: Number(p.wWins.toFixed(3)),
      win_rate: p.wTrades > 0 ? p.wWins / p.wTrades : null,
      avg_return_pct: p.wTrades > 0 ? (p.wReturnSum / p.wTrades) * 100 : null,
      contribution_pct: totalAbsContrib > 0 ? (p.contrib / totalAbsContrib) * 100 : 0,
    };
  });

  // Walk-forward prior: start from DEFAULT_PRIOR, tilt by contribution.
  // Signals with strong positive contribution grow (up to +50% relative),
  // strong negative contribution shrinks (down to -60%).
  const tilted: Record<SignalKey, number> = { ...DEFAULT_PRIOR };
  if (attributed >= 8) {
    for (const k of SIGNAL_KEYS) {
      const contrib = rows.find((r) => r.signal === k)?.contribution_pct ?? 0; // -100..100
      const factor = 1 + Math.max(-0.6, Math.min(0.5, contrib / 100));
      tilted[k] = Math.max(2, DEFAULT_PRIOR[k] * factor);
    }
  }

  return {
    window_days: windowDays,
    horizon_days: horizonDays,
    attributed_trades: attributed,
    rows,
    suggested_prior: normalizePrior(tilted),
    notes:
      attributed < 8
        ? "Not enough evaluable trades yet — using default prior."
        : "Prior tilted from rolling signal-source P&L.",
  };
}

export function formatAttributionBlock(a: AttributionReport): string {
  const rowsTxt = a.rows
    .map(
      (r) =>
        `  ${r.signal.padEnd(15)} contrib ${r.contribution_pct.toFixed(1).padStart(6)}%  win ${r.win_rate != null ? `${(r.win_rate * 100).toFixed(0)}%` : "n/a"}  avg ${r.avg_return_pct != null ? `${r.avg_return_pct.toFixed(2)}%` : "n/a"}`,
    )
    .join("\n");
  const priorTxt = SIGNAL_KEYS.map((k) => `${k}=${a.suggested_prior[k].toFixed(0)}`).join(", ");
  return `SIGNAL ATTRIBUTION (walk-forward over ${a.window_days}d, horizon ${a.horizon_days}d, n=${a.attributed_trades}):
${rowsTxt || "  (no attributable trades yet)"}
Suggested weight prior for signal_weights on today's orders: ${priorTxt}
${a.notes} Nudge — do not blindly copy — allocation toward signals with positive contribution and away from consistently negative ones.`;
}
