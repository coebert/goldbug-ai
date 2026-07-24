// Item #1 — Walk-forward hyperparameter tuning.
//
// Nightly (weekly cadence per portfolio) grid-search of SMA/RSI lookbacks
// against the last ~2 years of cached daily closes for that portfolio's
// universe. The winning combo — plus a heuristic Kelly cap derived from
// universe volatility — is persisted on portfolios.hyperparams and:
//   (a) formatted into the AI prompt as PRIORS the model should respect;
//   (b) threaded into convictionSizedSpend so sizing actually shrinks/grows.
//
// The rule scored inside the grid is a deterministic long-only trend filter:
//   signal_t = 1 iff SMA_fast(t) > SMA_slow(t) AND close_t > SMA_slow(t)
//                    AND RSI_period(t) < 70
// forward return = signal_t * (close_{t+1}/close_t - 1). We rank by median
// per-symbol annualised Sharpe across the universe (robust to outliers).
//
// Cost: only cached prices — no external calls. Bounded grid (2*3*3 = 18).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/_server/db-json";
import { getDailyCandlesRange, sma as smaOf, rsi as rsiOf } from "./market-data.server";
import { filterUniverse, type AssetClass } from "./universe.server";

export type HyperparamGrid = {
  sma_fast: number;
  sma_slow: number;
  rsi_period: number;
};

export type TunedHyperparams = {
  sma_fast: number;
  sma_slow: number;
  rsi_period: number;
  kelly_cap: number;
  score: number; // median Sharpe across universe symbols
  n_symbols: number;
  tuned_at: string; // ISO date
  window_days: number;
  notes: string;
};

const DEFAULT_TUNED: TunedHyperparams = {
  sma_fast: 20,
  sma_slow: 100,
  rsi_period: 14,
  kelly_cap: 0.25,
  score: 0,
  n_symbols: 0,
  tuned_at: "",
  window_days: 0,
  notes: "defaults — not yet tuned",
};

const GRID: HyperparamGrid[] = (() => {
  const out: HyperparamGrid[] = [];
  for (const f of [10, 20]) for (const s of [50, 100, 200]) for (const r of [7, 14, 21]) {
    if (f < s) out.push({ sma_fast: f, sma_slow: s, rsi_period: r });
  }
  return out;
})();

export function parseHyperparams(raw: unknown): TunedHyperparams {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TUNED };
  const r = raw as Record<string, unknown>;
  const num = (k: string, d: number, min: number, max: number) => {
    const n = Number(r[k]);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  return {
    sma_fast: num("sma_fast", DEFAULT_TUNED.sma_fast, 3, 100),
    sma_slow: num("sma_slow", DEFAULT_TUNED.sma_slow, 10, 400),
    rsi_period: num("rsi_period", DEFAULT_TUNED.rsi_period, 3, 60),
    kelly_cap: num("kelly_cap", DEFAULT_TUNED.kelly_cap, 0.05, 0.5),
    score: Number.isFinite(Number(r.score)) ? Number(r.score) : 0,
    n_symbols: Number.isFinite(Number(r.n_symbols)) ? Number(r.n_symbols) : 0,
    tuned_at: typeof r.tuned_at === "string" ? r.tuned_at : "",
    window_days: Number.isFinite(Number(r.window_days)) ? Number(r.window_days) : 0,
    notes: typeof r.notes === "string" ? r.notes : DEFAULT_TUNED.notes,
  };
}

function sharpeOfRule(closes: number[], p: HyperparamGrid): number | null {
  const need = Math.max(p.sma_slow, p.rsi_period + 1) + 30;
  if (closes.length < need) return null;
  const rets: number[] = [];
  for (let i = need; i < closes.length - 1; i++) {
    const window = closes.slice(0, i + 1);
    const smaF = smaOf(window, p.sma_fast);
    const smaS = smaOf(window, p.sma_slow);
    const r = rsiOf(window, p.rsi_period);
    if (smaF == null || smaS == null || r == null) continue;
    const c = closes[i];
    const long = smaF > smaS && c > smaS && r < 70;
    if (!long) { rets.push(0); continue; }
    const next = closes[i + 1];
    if (!next || !c) { rets.push(0); continue; }
    rets.push((next - c) / c);
  }
  if (rets.length < 60) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  if (sd <= 0) return null;
  // annualised Sharpe assuming ~252 trading days
  return (mean / sd) * Math.sqrt(252);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * Kelly cap heuristic: lower universe volatility ⇒ allow larger cap, up to 0.35;
 * higher vol clamps down toward 0.10. Deterministic function of realised daily
 * vol across the universe over the tuning window.
 */
function deriveKellyCap(dailyVols: number[]): number {
  if (dailyVols.length === 0) return 0.25;
  const medVol = median(dailyVols); // e.g. 0.012 = 1.2%/day
  // Linear map: vol 0.008 -> 0.35, vol 0.030 -> 0.10, clamp.
  const cap = 0.35 - ((medVol - 0.008) / (0.030 - 0.008)) * 0.25;
  return Math.max(0.10, Math.min(0.35, Number(cap.toFixed(2))));
}

/**
 * Run a walk-forward grid search across the portfolio's universe and persist
 * the winner on portfolios.hyperparams. Prices come from cache so this is
 * cheap; a full run for a 25-symbol universe evaluates 18 param combos = ~450
 * lightweight SMA/RSI passes over 500-day windows.
 */
export async function tunePortfolioHyperparams(
  portfolioId: string,
  asOf: string,
  opts?: { windowDays?: number; classes?: AssetClass[] },
): Promise<TunedHyperparams> {
  const windowDays = opts?.windowDays ?? 500;
  const from = new Date(asOf);
  from.setDate(from.getDate() - windowDays - 60);
  const fromStr = from.toISOString().slice(0, 10);

  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("universe")
    .eq("id", portfolioId)
    .maybeSingle();
  const classes = (portfolio?.universe as AssetClass[] | undefined) ?? ["etf", "stock"];
  const symbols = filterUniverse(classes).slice(0, 30);

  // Load closes once per symbol.
  const seriesBySymbol: Array<{ symbol: string; closes: number[] }> = [];
  for (const u of symbols) {
    try {
      const candles = await getDailyCandlesRange(u.symbol, fromStr, asOf);
      const closes = candles.map((c) => c.close).filter((n) => n > 0);
      if (closes.length >= 220) seriesBySymbol.push({ symbol: u.symbol, closes });
    } catch {
      /* skip */
    }
  }

  if (seriesBySymbol.length === 0) {
    return { ...DEFAULT_TUNED, tuned_at: asOf, window_days: windowDays, notes: "no cached prices — kept defaults" };
  }

  // Grid search: for each param combo, collect per-symbol Sharpes, rank by median.
  let best: { p: HyperparamGrid; score: number } | null = null;
  for (const p of GRID) {
    const perSym: number[] = [];
    for (const s of seriesBySymbol) {
      const sh = sharpeOfRule(s.closes, p);
      if (sh != null && Number.isFinite(sh)) perSym.push(sh);
    }
    if (perSym.length < Math.max(3, seriesBySymbol.length / 3)) continue;
    const score = median(perSym);
    if (!best || score > best.score) best = { p, score };
  }

  // Daily-return vol per symbol (for Kelly cap derivation).
  const vols: number[] = [];
  for (const s of seriesBySymbol) {
    const closes = s.closes.slice(-60);
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1];
      if (prev > 0) rets.push((closes[i] - prev) / prev);
    }
    const sd = stddev(rets);
    if (sd > 0) vols.push(sd);
  }
  const kelly = deriveKellyCap(vols);

  const chosen = best?.p ?? { sma_fast: DEFAULT_TUNED.sma_fast, sma_slow: DEFAULT_TUNED.sma_slow, rsi_period: DEFAULT_TUNED.rsi_period };
  const score = best?.score ?? 0;

  const tuned: TunedHyperparams = {
    sma_fast: chosen.sma_fast,
    sma_slow: chosen.sma_slow,
    rsi_period: chosen.rsi_period,
    kelly_cap: kelly,
    score: Number(score.toFixed(3)),
    n_symbols: seriesBySymbol.length,
    tuned_at: asOf,
    window_days: windowDays,
    notes: best
      ? `winner via median Sharpe ${score.toFixed(2)} across ${seriesBySymbol.length} symbols (grid=${GRID.length})`
      : `no winner found — reverted to defaults (grid=${GRID.length})`,
  };

  await supabaseAdmin
    .from("portfolios")
    .update({ hyperparams: asJson(tuned) })
    .eq("id", portfolioId);

  return tuned;
}

/**
 * Read persisted hyperparams; if missing or older than `staleDays`, re-tune.
 * Called at the top of runDailyTick.
 */
export async function getOrRefreshHyperparams(
  portfolioId: string,
  asOf: string,
  staleDays = 7,
): Promise<TunedHyperparams> {
  const { data } = await supabaseAdmin
    .from("portfolios")
    .select("hyperparams")
    .eq("id", portfolioId)
    .maybeSingle();
  const current = parseHyperparams(data?.hyperparams);
  if (!current.tuned_at) return tunePortfolioHyperparams(portfolioId, asOf);
  const ageDays = (new Date(asOf).getTime() - new Date(current.tuned_at).getTime()) / 86400000;
  if (ageDays >= staleDays) {
    try {
      return await tunePortfolioHyperparams(portfolioId, asOf);
    } catch (e) {
      console.warn("hyperparam retune failed, keeping stored:", e);
      return current;
    }
  }
  return current;
}

export function formatHyperparamBlock(t: TunedHyperparams): string {
  if (!t.tuned_at) return "";
  return `HYPERPARAM PRIORS (walk-forward tuned on ${t.window_days}d of cached prices, refreshed ${t.tuned_at}, median-Sharpe ${t.score.toFixed(2)} across ${t.n_symbols} symbols):
- Preferred trend lookbacks: SMA_fast=${t.sma_fast}, SMA_slow=${t.sma_slow}
- Preferred RSI period: ${t.rsi_period}
- Sizing Kelly cap in force: ${(t.kelly_cap * 100).toFixed(0)}% of the classical Kelly fraction (guardrails already apply this to conviction-weighted spend)
Use these as priors when the shown daily SMA/RSI features are close-calls; disagreements are OK if news, regime, or cross-asset context clearly override.`;
}
