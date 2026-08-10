// How the driver action mix (buy / partial / stand aside) evolves across the
// backtest timeline at one (risk, expectancy-gap weight) setting.
//
// The action mix panel answers "what would I be doing today?". This module
// answers "was that stance stable, or is it an artefact of the last few
// weeks?" — it re-ranks the drivers using only the trades available up to
// each point in the sample and re-derives the stance split there.
//
// Two windowing modes, both deliberate:
//   expanding — every trade from the start of the sample to the bucket end.
//               This is what an operator running the engine live would have
//               seen: knowledge accumulates, the mix settles as n grows.
//   rolling   — only the last N buckets. Sharper, noisier, and the honest way
//               to spot regime shifts that an expanding window averages away.
//
// Pure: same trades in, same series out. No clock, no I/O, no randomness.

import type { SignalTrade } from "@/lib/breakout-backtest";
import { symbolDiagnostics } from "@/lib/breakout-diagnostics";
import {
  actionMixFor,
  STANCES,
  type ActionMix,
  type DriverStance,
} from "@/lib/breakout-action-mix";
import type { DriverSetting } from "@/lib/breakout-driver-compare";

export type MixBucketSize = "month" | "quarter";
export type MixWindowMode = "expanding" | "rolling";

export type MixTimelinePoint = {
  /** Sortable bucket key, e.g. "2025-04" or "2025-Q2". */
  period: string;
  /** Last trade date included in this bucket's window. */
  asOf: string;
  /** Signals that landed inside this bucket. */
  bucketTrades: number;
  /** Signals inside the evaluation window (expanding or rolling). */
  windowTrades: number;
  /** Symbols that cleared the ranking threshold in this window. */
  ranked: number;
  /** Stance counts at this point in the timeline. */
  buy: number;
  hold: number;
  sell: number;
  /** Stance shares, 0–100, summing to 100 when `ranked` > 0. */
  buyPct: number;
  holdPct: number;
  sellPct: number;
  /** Mean size multiplier across the ranked set. */
  avgSize: number;
  mix: ActionMix;
};

export type MixTimeline = {
  setting: DriverSetting;
  bucket: MixBucketSize;
  window: MixWindowMode;
  /** Buckets retained in the rolling window (ignored when expanding). */
  rollingBuckets: number;
  points: MixTimelinePoint[];
  /** Change in each stance's share from the first to the last point, in pp. */
  shift: Record<DriverStance, number>;
  summary: string;
};

export type MixTimelineOptions = {
  bucket?: MixBucketSize;
  window?: MixWindowMode;
  rollingBuckets?: number;
  /** Minimum confirmed signals before a symbol is rankable. */
  minConfirmed?: number;
  /** Drop leading buckets that produce no rankable symbols. */
  trimEmptyLead?: boolean;
};

/** "2025-04-17" → "2025-04" | "2025-Q2". Non-ISO input falls back to itself. */
export function periodKey(date: string, bucket: MixBucketSize): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (!year || !Number.isFinite(month) || month < 1 || month > 12) return date;
  if (bucket === "month") return `${year}-${date.slice(5, 7)}`;
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

export function mixTimeline(
  trades: readonly SignalTrade[],
  setting: DriverSetting,
  options: MixTimelineOptions = {},
): MixTimeline {
  const bucket = options.bucket ?? "month";
  const window = options.window ?? "expanding";
  const rollingBuckets = Math.max(1, options.rollingBuckets ?? 6);
  const minConfirmed = options.minConfirmed ?? 3;
  const trimEmptyLead = options.trimEmptyLead ?? true;

  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Bucket in date order; a Map preserves insertion order, which is already
  // chronological because `ordered` is.
  const buckets = new Map<string, SignalTrade[]>();
  for (const t of ordered) {
    const key = periodKey(t.date, bucket);
    const arr = buckets.get(key);
    if (arr) arr.push(t);
    else buckets.set(key, [t]);
  }

  const keys = [...buckets.keys()];
  const points: MixTimelinePoint[] = [];

  for (let i = 0; i < keys.length; i++) {
    const from = window === "rolling" ? Math.max(0, i - rollingBuckets + 1) : 0;
    const windowTrades: SignalTrade[] = [];
    for (let j = from; j <= i; j++) windowTrades.push(...(buckets.get(keys[j]!) ?? []));

    const symbols = symbolDiagnostics(windowTrades, { minTrades: minConfirmed });
    const mix = actionMixFor(symbols, setting, { minConfirmed });
    const bucketTrades = buckets.get(keys[i]!) ?? [];

    points.push({
      period: keys[i]!,
      asOf: bucketTrades[bucketTrades.length - 1]?.date ?? keys[i]!,
      bucketTrades: bucketTrades.length,
      windowTrades: windowTrades.length,
      ranked: mix.total,
      buy: mix.byStance.buy.count,
      hold: mix.byStance.hold.count,
      sell: mix.byStance.sell.count,
      buyPct: mix.byStance.buy.pct,
      holdPct: mix.byStance.hold.pct,
      sellPct: mix.byStance.sell.pct,
      avgSize: mix.avgSize,
      mix,
    });
  }

  // Early buckets often carry too few signals for any symbol to rank. Charting
  // those as "100% stand aside" would be a lie — they are "no opinion yet".
  const trimmed = trimEmptyLead ? dropLeadingEmpty(points) : points;

  const first = trimmed.find((p) => p.ranked > 0) ?? null;
  const last = [...trimmed].reverse().find((p) => p.ranked > 0) ?? null;
  const shift = {
    buy: first && last ? last.buyPct - first.buyPct : 0,
    hold: first && last ? last.holdPct - first.holdPct : 0,
    sell: first && last ? last.sellPct - first.sellPct : 0,
  } satisfies Record<DriverStance, number>;

  const summary = !first
    ? "Not enough signals in any period to rank drivers."
    : `${trimmed.length} ${bucket === "month" ? "months" : "quarters"} (${window}${
        window === "rolling" ? ` ${rollingBuckets}` : ""
      }) · ${STANCES.map(
        (s) => `${s === "hold" ? "partial" : s === "sell" ? "stand aside" : "buy"} ${signed(shift[s])}pp`,
      ).join(" · ")} from ${first.period} to ${last!.period}`;

  return { setting, bucket, window, rollingBuckets, points: trimmed, shift, summary };
}

function dropLeadingEmpty(points: MixTimelinePoint[]): MixTimelinePoint[] {
  const firstRanked = points.findIndex((p) => p.ranked > 0);
  return firstRanked <= 0 ? points : points.slice(firstRanked);
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
