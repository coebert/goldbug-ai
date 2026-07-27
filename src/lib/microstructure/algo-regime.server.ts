// Phase E — Observability + end-to-end wiring for the algo-regime guard.
//
// Server-only helper that pulls the raw series needed by `detectAlgoRegime`
// straight from `price_cache`, so trading-engine (and any other server-side
// caller) can compute a live snapshot without owning the SQL. Detectors
// themselves are pure and unit-tested; this file is just I/O + shape.
//
// Never called from the browser: it uses the service-role admin client and
// reads global reference data. Keep the import path `.server.ts` so the
// TanStack import guard blocks it from client bundles.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  detectAlgoRegime,
  type AlgoRegimeConfig,
  type AlgoRegimeSnapshot,
  type BarSeries,
} from "./algo-regime";

/** Primary equity-market benchmark. SPY has daily bars in price_cache. */
export const DEFAULT_ALGO_REGIME_BENCH = "SPY";

async function loadBars(symbol: string, asOf: string, lookbackDays: number): Promise<BarSeries> {
  const { data, error } = await supabaseAdmin
    .from("price_cache")
    .select("close, volume, price_date")
    .eq("symbol", symbol)
    .lte("price_date", asOf)
    .order("price_date", { ascending: false })
    .limit(lookbackDays);
  if (error) throw new Error(`price_cache read failed for ${symbol}: ${error.message}`);
  const rows = (data ?? []).slice().reverse();
  return {
    closes: rows.map((r) => Number(r.close)).filter((n) => Number.isFinite(n)),
    volumes: rows.map((r) => (r.volume == null ? 0 : Number(r.volume))),
  };
}

async function loadReturns(symbol: string, asOf: string, lookbackDays: number): Promise<number[]> {
  const bars = await loadBars(symbol, asOf, lookbackDays + 1);
  const out: number[] = [];
  for (let i = 1; i < bars.closes.length; i++) {
    const p = bars.closes[i - 1];
    if (p > 0) out.push((bars.closes[i] - p) / p);
  }
  return out;
}

export type BuildAlgoRegimeInputs = {
  asOf: string;
  /** Top holding symbols for the correlation-spike detector. */
  holdingSymbols?: string[];
  /** Override the benchmark symbol (defaults to SPY). */
  benchSymbol?: string;
  /** Days of history to pull. Detectors need ≥ 30 for whipsaw / vol baseline. */
  lookbackDays?: number;
  /**
   * Portfolio id — used to look up an auto-tuned config override in
   * `algo_regime_config_overrides`. Omit for a global/default snapshot.
   */
  portfolioId?: string;
};

async function loadConfigOverride(
  portfolioId: string | undefined,
): Promise<Partial<AlgoRegimeConfig> | undefined> {
  if (!portfolioId) return undefined;
  const { data, error } = await supabaseAdmin
    .from("algo_regime_config_overrides")
    .select("config")
    .eq("portfolio_id", portfolioId)
    .maybeSingle();
  if (error || !data) return undefined;
  const cfg = data.config as Partial<AlgoRegimeConfig> | null;
  return cfg && typeof cfg === "object" ? cfg : undefined;
}

/**
 * Build an `AlgoRegimeSnapshot` from `price_cache` for the given portfolio
 * context. Returns `null` when the benchmark series is too short to run
 * meaningful detection — callers should treat that as "guard unavailable
 * this tick" rather than "no signals". Never throws for missing data;
 * only for infrastructure errors.
 */
export async function buildAlgoRegimeSnapshot(
  input: BuildAlgoRegimeInputs,
): Promise<AlgoRegimeSnapshot | null> {
  const bench = input.benchSymbol ?? DEFAULT_ALGO_REGIME_BENCH;
  const lookback = input.lookbackDays ?? 60;
  const primary = await loadBars(bench, input.asOf, lookback);
  if (primary.closes.length < 30) return null;

  // Cross-section: pull daily returns for the top holdings. If we can't get
  // at least two, the correlation-spike detector short-circuits to false —
  // that's fine; other detectors still run.
  const holdings = (input.holdingSymbols ?? []).slice(0, 8);
  const crossSection: Record<string, number[]> = {};
  await Promise.all(
    holdings.map(async (sym) => {
      try {
        const r = await loadReturns(sym, input.asOf, 30);
        if (r.length >= 10) crossSection[sym] = r;
      } catch {
        // best-effort — skip symbols with missing price history
      }
    }),
  );

  const configOverride = await loadConfigOverride(input.portfolioId);

  return detectAlgoRegime({
    primary,
    crossSection: Object.keys(crossSection).length >= 2 ? crossSection : undefined,
    config: configOverride,
  });
}
