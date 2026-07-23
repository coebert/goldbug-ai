// Phase 6 — Circuit breaker + regime-linked risk tightening.
// Auto-pauses the AI (skips its call, no new buys) when:
//   - consecutive_losses >= 5, OR
//   - weight_drift_pp >= 20 (largest 45d avg vs previous 45d avg for any bucket)
// Also tightens per-symbol cap and stop-loss when regime is bear/crisis.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PersistedRegime } from "./regime-detector.server";
import { SIGNAL_KEYS, type SignalKey } from "./attribution.server";
import { parseRiskConfig, riskProfile, type RiskConfig } from "./universe.server";
import type { Database } from "@/integrations/supabase/types";

export type CircuitState = {
  paused: boolean;
  since: string | null;
  reason: string | null;
  consecutive_losses: number;
  last_check: string | null;
  max_weight_drift_pp: number | null;
  drift_signal: SignalKey | null;
};

const DEFAULT_STATE: CircuitState = {
  paused: false,
  since: null,
  reason: null,
  consecutive_losses: 0,
  last_check: null,
  max_weight_drift_pp: null,
  drift_signal: null,
};

export function parseCircuit(raw: unknown): CircuitState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
  const r = raw as Record<string, unknown>;
  return {
    paused: Boolean(r.paused),
    since: typeof r.since === "string" ? r.since : null,
    reason: typeof r.reason === "string" ? r.reason : null,
    consecutive_losses: typeof r.consecutive_losses === "number" ? r.consecutive_losses : 0,
    last_check: typeof r.last_check === "string" ? r.last_check : null,
    max_weight_drift_pp: typeof r.max_weight_drift_pp === "number" ? r.max_weight_drift_pp : null,
    drift_signal: SIGNAL_KEYS.includes(r.drift_signal as SignalKey) ? (r.drift_signal as SignalKey) : null,
  };
}

async function fetchWeightSeries(portfolioId: string, asOf: string) {
  const since = new Date(asOf);
  since.setDate(since.getDate() - 90);
  const { data } = await supabaseAdmin
    .from("decisions")
    .select("run_date, raw")
    .eq("portfolio_id", portfolioId)
    .gte("run_date", since.toISOString().slice(0, 10))
    .lte("run_date", asOf)
    .order("run_date", { ascending: true });
  const points: Array<{ date: string; w: Record<SignalKey, number> }> = [];
  for (const d of data ?? []) {
    const orders = ((d.raw as { orders?: Array<{ signal_weights?: Partial<Record<SignalKey, number>> }> })?.orders) ?? [];
    if (!orders.length) continue;
    const acc: Record<SignalKey, number> = { sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0 };
    let n = 0;
    for (const o of orders) {
      if (!o.signal_weights) continue;
      let s = 0;
      for (const k of SIGNAL_KEYS) s += Math.max(0, Number(o.signal_weights[k] ?? 0));
      if (s <= 0) continue;
      for (const k of SIGNAL_KEYS) acc[k] += (Math.max(0, Number(o.signal_weights[k] ?? 0)) / s) * 100;
      n++;
    }
    if (n === 0) continue;
    for (const k of SIGNAL_KEYS) acc[k] /= n;
    points.push({ date: d.run_date as string, w: acc });
  }
  return points;
}

function windowAvg(points: Array<{ date: string; w: Record<SignalKey, number> }>) {
  const acc: Record<SignalKey, number> = { sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0 };
  if (points.length === 0) return acc;
  for (const p of points) for (const k of SIGNAL_KEYS) acc[k] += p.w[k];
  for (const k of SIGNAL_KEYS) acc[k] /= points.length;
  return acc;
}

async function consecutiveLossesFromRecentTrades(portfolioId: string, asOf: string) {
  const since = new Date(asOf);
  since.setDate(since.getDate() - 30);
  const { data } = await supabaseAdmin
    .from("trades")
    .select("reason, trade_date")
    .eq("portfolio_id", portfolioId)
    .gte("trade_date", since.toISOString().slice(0, 10))
    .lte("trade_date", asOf)
    .order("trade_date", { ascending: false });
  let n = 0;
  for (const t of data ?? []) {
    const r = (t.reason as string | null)?.toLowerCase() ?? "";
    if (r.includes("stop-loss")) n++;
    else if (r.includes("take-profit")) break;
    else if (n > 0) break;
  }
  return n;
}

/**
 * Evaluate the breaker BEFORE the AI runs.
 * Returns updated state; if paused, caller should skip the AI and buys.
 */
export async function evaluateBreaker(
  portfolioId: string,
  asOf: string,
  current: CircuitState,
): Promise<CircuitState> {
  const [series, losses] = await Promise.all([
    fetchWeightSeries(portfolioId, asOf).catch(() => []),
    consecutiveLossesFromRecentTrades(portfolioId, asOf).catch(() => 0),
  ]);
  const mid = Math.floor(series.length / 2);
  const older = windowAvg(series.slice(0, mid));
  const recent = windowAvg(series.slice(mid));
  let maxDrift = 0;
  let driftKey: SignalKey | null = null;
  if (series.length >= 6) {
    for (const k of SIGNAL_KEYS) {
      const drift = Math.abs(recent[k] - older[k]);
      if (drift > maxDrift) { maxDrift = drift; driftKey = k; }
    }
  }
  const shouldPause =
    losses >= 5 || maxDrift >= 20;
  const state: CircuitState = {
    ...current,
    consecutive_losses: losses,
    last_check: asOf,
    max_weight_drift_pp: series.length >= 6 ? Number(maxDrift.toFixed(1)) : null,
    drift_signal: driftKey,
    paused: current.paused || shouldPause,
    since: current.paused ? current.since : shouldPause ? asOf : current.since,
    reason: shouldPause
      ? losses >= 5
        ? `auto-paused: ${losses} consecutive stop-loss exits`
        : `auto-paused: signal weight drift ${maxDrift.toFixed(1)}pp on ${driftKey}`
      : current.reason,
  };
  return state;
}

export async function persistCircuit(portfolioId: string, state: CircuitState) {
  await supabaseAdmin
    .from("portfolios")
    .update({ circuit_breaker: state as unknown as never })
    .eq("id", portfolioId);
}

/**
 * Apply regime-linked tightening to a portfolio's effective risk config.
 * Bear/crisis => tighter per-symbol cap and stop-loss.
 */
export function tightenForRegime(
  cfg: RiskConfig,
  riskLevel: Database["public"]["Enums"]["risk_level"],
  regime: PersistedRegime,
): { cfg: RiskConfig; per_symbol_effective_pct: number; stop_loss_effective_pct: number; note: string } {
  const rp = riskProfile(riskLevel);
  const basePerSym = cfg.per_symbol_limit_pct ?? rp.maxPositionPct;
  const baseStop = cfg.stop_loss_pct;
  let perFactor = 1;
  let stopFactor = 1;
  let note = "regime neutral — no tightening";
  const r = regime.regime;
  if (r === "crisis") {
    perFactor = 0.5;
    stopFactor = 0.6;
    note = "crisis regime — per-symbol cap ×0.5, stop-loss tightened ×0.6";
  } else if (r === "bear") {
    perFactor = 0.7;
    stopFactor = 0.75;
    note = "bear regime — per-symbol cap ×0.7, stop-loss tightened ×0.75";
  } else if (r === "correction") {
    perFactor = 0.85;
    stopFactor = 0.85;
    note = "correction — mild tightening ×0.85";
  }

  const per_symbol_effective_pct = Math.max(0.01, basePerSym * perFactor);
  const stop_loss_effective_pct = Math.max(0.005, baseStop * stopFactor);
  const tightened: RiskConfig = {
    ...cfg,
    per_symbol_limit_pct: per_symbol_effective_pct,
    stop_loss_pct: stop_loss_effective_pct,
  };
  return { cfg: tightened, per_symbol_effective_pct, stop_loss_effective_pct, note };
}
