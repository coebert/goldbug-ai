// Real historical market data loader for backtests (server / script only).
//
// Pulls unadjusted + adjusted daily closes plus the split and dividend event
// stream from the public Yahoo chart endpoint, normalises pence-quoted LSE
// lines to major units, and hands `SymbolHistory` rows to the pure tape
// builder in `real-market-tape.ts`.
//
// Deliberately dependency-light so `scripts/*` can run it directly.

import type { CorporateAction, RawDailyBar, SymbolHistory } from "./real-market-tape";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (compatible; AegisBacktest/1.0)";

type ChartResponse = {
  chart?: {
    result?: Array<{
      meta?: { currency?: string };
      timestamp?: number[];
      events?: {
        dividends?: Record<string, { amount?: number; date?: number }>;
        splits?: Record<
          string,
          { date?: number; numerator?: number; denominator?: number; splitRatio?: string }
        >;
      };
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
          volume?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

function isoDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Yahoo quotes LSE lines in pence (GBp); everything downstream wants majors. */
function unitDivisor(currency: string | undefined): number {
  return currency === "GBp" || currency === "GBX" ? 100 : 1;
}

export type FetchHistoryOptions = {
  /** Inclusive ISO start date. */
  from: string;
  /** Inclusive ISO end date. Defaults to today. */
  to?: string;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
};

/** Fetch one symbol's daily history with corporate-action events. */
export async function fetchSymbolHistory(
  symbol: string,
  opts: FetchHistoryOptions,
): Promise<SymbolHistory & { currency: string | null }> {
  const to = opts.to ?? new Date().toISOString().slice(0, 10);
  const period1 = Math.floor(Date.parse(`${opts.from}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
  const url =
    `${CHART_URL}/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&events=div%2Csplit&includeAdjustedClose=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let json: ChartResponse;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
    json = (await res.json()) as ChartResponse;
  } finally {
    clearTimeout(timer);
  }

  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    throw new Error(`No data for ${symbol}: ${json.chart?.error?.description ?? "empty result"}`);
  }
  const currency = result.meta?.currency ?? null;
  const div = unitDivisor(result.meta?.currency);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const volumes = result.indicators?.quote?.[0]?.volume ?? [];
  const highs = result.indicators?.quote?.[0]?.high ?? [];
  const lows = result.indicators?.quote?.[0]?.low ?? [];
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  const bars: RawDailyBar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    const a = adj[i];
    const hi = highs[i];
    const lo = lows[i];
    bars.push({
      date: isoDay(result.timestamp[i]!),
      close: close / div,
      adjClose: a != null && Number.isFinite(a) && a > 0 ? a / div : null,
      volume: volumes[i] ?? null,
      high: hi != null && Number.isFinite(hi) && hi > 0 ? hi / div : null,
      low: lo != null && Number.isFinite(lo) && lo > 0 ? lo / div : null,
    });
  }

  const dividends: CorporateAction[] = Object.values(result.events?.dividends ?? {})
    .filter((d) => d?.date != null && (d.amount ?? 0) > 0)
    .map((d) => ({
      symbol,
      date: isoDay(d.date!),
      kind: "dividend" as const,
      value: (d.amount ?? 0) / div,
    }));

  const splits: CorporateAction[] = Object.values(result.events?.splits ?? {})
    .filter((s) => s?.date != null)
    .map((s) => ({
      symbol,
      date: isoDay(s.date!),
      kind: "split" as const,
      value:
        (s.numerator ?? 0) > 0 && (s.denominator ?? 0) > 0
          ? s.numerator! / s.denominator!
          : Number(String(s.splitRatio ?? "1:1").split(":")[0] ?? 1),
    }));

  return { symbol, bars, dividends, splits, currency };
}

/** Fetch many symbols sequentially with a small pause (Yahoo rate-limits bursts). */
export async function fetchUniverseHistory(
  symbols: readonly string[],
  opts: FetchHistoryOptions & { pauseMs?: number; onProgress?: (msg: string) => void },
): Promise<Array<SymbolHistory & { currency: string | null }>> {
  const out: Array<SymbolHistory & { currency: string | null }> = [];
  for (const symbol of symbols) {
    try {
      const h = await fetchSymbolHistory(symbol, opts);
      out.push(h);
      opts.onProgress?.(
        `${symbol}: ${h.bars.length} bars, ${h.splits?.length ?? 0} splits, ${h.dividends?.length ?? 0} dividends (${h.currency ?? "?"})`,
      );
    } catch (err) {
      opts.onProgress?.(`${symbol}: FAILED — ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, opts.pauseMs ?? 400));
  }
  if (out.length === 0) throw new Error("No symbol history could be fetched");
  return out;
}
