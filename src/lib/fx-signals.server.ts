// FX signal computation for the AI trading engine.
//
// Given a currency pair, returns a compact set of momentum / volatility /
// mean-reversion metrics the model can cite in its rationale:
//
//   • ret5d, ret20d, ret60d — trailing % change of the pair rate
//   • vol20d               — annualised realised volatility (√252 scaling)
//   • distSma50Pct         — distance of the latest close from the 50d SMA
//                            expressed as a % (positive = above SMA)
//   • trendBias            — "long_from" / "long_to" / "neutral"
//
// Data source is Yahoo Finance chart history for `${FROM}${TO}=X`; we cache
// results in-process for 30 min so the hourly tick is cheap. All math lives
// in pure helpers below so the tests don't need the network.

import { pairHasEventNear, type FxEvent, eventsNear } from "./fx-events";

export interface FxPairSignals {
  from: string;
  to: string;
  latest: number | null;
  ret5dPct: number | null;
  ret20dPct: number | null;
  ret60dPct: number | null;
  vol20dPct: number | null;
  distSma50Pct: number | null;
  trendBias: "long_from" | "long_to" | "neutral";
  eventWithin24h: FxEvent[];
  source: string;
  stale: boolean;
}

// ---------- pure math (unit-tested) -----------------------------------------

export function pctChange(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (xs.length - 1));
}

/** Compute daily simple returns from a closes series. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i - 1];
    if (p > 0 && Number.isFinite(closes[i])) out.push((closes[i] - p) / p);
  }
  return out;
}

/**
 * Annualised realised volatility from a closes series, using the trailing
 * `window` daily returns and √252 scaling. Returns a percentage.
 */
export function annualisedVolPct(closes: number[], window = 20): number | null {
  const rets = dailyReturns(closes).slice(-window);
  if (rets.length < 2) return null;
  const sd = stddev(rets);
  if (!Number.isFinite(sd)) return null;
  return sd * Math.sqrt(252) * 100;
}

/** Trailing simple moving average of the last `window` closes. */
export function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  return mean(closes.slice(-window));
}

/**
 * Turn the raw closes into the signal bundle. Pure — the network fetch
 * lives in `getFxPairSignals` below.
 */
export function signalsFromCloses(
  from: string,
  to: string,
  closes: number[],
  asOf: Date,
  opts: { source?: string; stale?: boolean } = {},
): FxPairSignals {
  const latest = closes.length > 0 ? closes[closes.length - 1] : null;
  const at = (lookback: number) =>
    closes.length > lookback ? closes[closes.length - 1 - lookback] : null;

  const ret5 = latest != null && at(5) != null ? pctChange(latest, at(5) as number) : null;
  const ret20 = latest != null && at(20) != null ? pctChange(latest, at(20) as number) : null;
  const ret60 = latest != null && at(60) != null ? pctChange(latest, at(60) as number) : null;
  const vol20 = annualisedVolPct(closes, 20);
  const sma50 = sma(closes, 50);
  const distSma50 =
    latest != null && sma50 != null && sma50 > 0
      ? ((latest - sma50) / sma50) * 100
      : null;

  // Trend bias: majority sign of {ret20, ret60, distSma50}. `long_from`
  // means the from-currency has been strengthening vs the to-currency.
  const signs = [ret20, ret60, distSma50]
    .filter((x): x is number => x != null)
    .map((x) => Math.sign(x));
  const pos = signs.filter((s) => s > 0).length;
  const neg = signs.filter((s) => s < 0).length;
  const trendBias: FxPairSignals["trendBias"] =
    pos >= 2 ? "long_from" : neg >= 2 ? "long_to" : "neutral";

  return {
    from: from.toUpperCase(),
    to: to.toUpperCase(),
    latest,
    ret5dPct: ret5,
    ret20dPct: ret20,
    ret60dPct: ret60,
    vol20dPct: vol20,
    distSma50Pct: distSma50,
    trendBias,
    eventWithin24h: [
      ...eventsNear(from, asOf, 24),
      ...eventsNear(to, asOf, 24),
    ],
    source: opts.source ?? "closes",
    stale: opts.stale ?? false,
  };
}

// ---------- network layer ---------------------------------------------------

type Cached = { closes: number[]; ts: number; source: string };
const cache = new Map<string, Cached>();
const TTL_MS = 30 * 60 * 1000;

async function fetchYahooCloses(from: string, to: string): Promise<number[]> {
  const symbol = `${from}${to}=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=6mo&interval=1d`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (aegis-fx-signals)" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`yahoo chart ${res.status}`);
  const json = (await res.json()) as {
    chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
  };
  const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
}

/**
 * Fetch (or serve from cache) the signals for one FX pair. `asOf` defaults
 * to now — passing a fixed date is useful for backtests.
 */
export async function getFxPairSignals(
  from: string,
  to: string,
  asOf: Date = new Date(),
): Promise<FxPairSignals> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) {
    return signalsFromCloses(f, t, [1, 1, 1], asOf, { source: "identity" });
  }
  const key = `${f}${t}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.ts < TTL_MS) {
    return signalsFromCloses(f, t, cached.closes, asOf, { source: cached.source });
  }
  try {
    const closes = await fetchYahooCloses(f, t);
    if (closes.length < 5) throw new Error("insufficient history");
    cache.set(key, { closes, ts: now, source: "yahoo" });
    return signalsFromCloses(f, t, closes, asOf, { source: "yahoo" });
  } catch (err) {
    if (cached) {
      return signalsFromCloses(f, t, cached.closes, asOf, {
        source: `${cached.source}-stale`,
        stale: true,
      });
    }
    const msg = err instanceof Error ? err.message : "fetch failed";
    return {
      from: f,
      to: t,
      latest: null,
      ret5dPct: null,
      ret20dPct: null,
      ret60dPct: null,
      vol20dPct: null,
      distSma50Pct: null,
      trendBias: "neutral",
      eventWithin24h: [...eventsNear(f, asOf, 24), ...eventsNear(t, asOf, 24)],
      source: `unavailable:${msg}`,
      stale: true,
    };
  }
}

export function __resetFxSignalsCacheForTests() {
  cache.clear();
}

// Re-export so the prompt builder can reuse the calendar helper without
// pulling in the events module directly.
export { pairHasEventNear };
