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
  /**
   * Full mix breakdown. Omitted on timelines that crossed the wire — the
   * chart only reads the stance shares, and the nested buckets triple the
   * payload for every point.
   */
  mix?: ActionMix;
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

/**
 * Bucket the sample once and resolve each bucket's evaluation window to a
 * ranked symbol set. The symbols depend only on the window, never on the
 * (risk, gap weight) setting, so a whole settings grid reuses this work.
 */
function buildWindows(trades: readonly SignalTrade[], options: MixTimelineOptions) {
  const bucket = options.bucket ?? "month";
  const window = options.window ?? "expanding";
  const rollingBuckets = Math.max(1, options.rollingBuckets ?? 6);
  const minConfirmed = options.minConfirmed ?? 3;

  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const buckets = new Map<string, SignalTrade[]>();
  for (const t of ordered) {
    const key = periodKey(t.date, bucket);
    const arr = buckets.get(key);
    if (arr) arr.push(t);
    else buckets.set(key, [t]);
  }

  const keys = [...buckets.keys()];
  const windows = keys.map((key, i) => {
    const from = window === "rolling" ? Math.max(0, i - rollingBuckets + 1) : 0;
    const windowTrades: SignalTrade[] = [];
    for (let j = from; j <= i; j++) windowTrades.push(...(buckets.get(keys[j]!) ?? []));
    const bucketTrades = buckets.get(key)!;
    return {
      period: key,
      asOf: bucketTrades[bucketTrades.length - 1]?.date ?? key,
      bucketTrades: bucketTrades.length,
      windowTrades: windowTrades.length,
      symbols: symbolDiagnostics(windowTrades, { minTrades: minConfirmed }),
    };
  });

  return { bucket, window, rollingBuckets, minConfirmed, windows };
}

export function mixTimeline(
  trades: readonly SignalTrade[],
  setting: DriverSetting,
  options: MixTimelineOptions = {},
): MixTimeline {
  const trimEmptyLead = options.trimEmptyLead ?? true;
  const built = buildWindows(trades, options);
  const points = pointsFor(built, setting);

  // Early buckets often carry too few signals for any symbol to rank. Charting
  // those as "100% stand aside" would be a lie — they are "no opinion yet".
  const trimmed = trimEmptyLead ? dropLeadingEmpty(points) : points;

  const shift = shiftOf(trimmed);
  const summary = summaryOf(trimmed, built);

  return {
    setting,
    bucket: built.bucket,
    window: built.window,
    rollingBuckets: built.rollingBuckets,
    points: trimmed,
    shift,
    summary,
  };
}

type BuiltWindows = ReturnType<typeof buildWindows>;

type PointLike = Omit<MixTimelinePoint, "mix">;

function shiftOf(points: readonly PointLike[]): Record<DriverStance, number> {
  const first = points.find((p) => p.ranked > 0) ?? null;
  const last = [...points].reverse().find((p) => p.ranked > 0) ?? null;
  if (!first || !last) return { buy: 0, hold: 0, sell: 0 };
  return {
    buy: last.buyPct - first.buyPct,
    hold: last.holdPct - first.holdPct,
    sell: last.sellPct - first.sellPct,
  };
}

const STANCE_WORD: Record<DriverStance, string> = {
  buy: "buy",
  hold: "partial",
  sell: "stand aside",
};

function summaryOf(points: readonly PointLike[], built: BuiltWindows): string {
  const first = points.find((p) => p.ranked > 0) ?? null;
  const last = [...points].reverse().find((p) => p.ranked > 0) ?? null;
  if (!first || !last) return "Not enough signals in any period to rank drivers.";
  const shift = shiftOf(points);
  return `${points.length} ${built.bucket === "month" ? "months" : "quarters"} (${built.window}${
    built.window === "rolling" ? ` ${built.rollingBuckets}` : ""
  }) · ${STANCES.map((s) => `${STANCE_WORD[s]} ${signed(shift[s])}pp`).join(" · ")} from ${
    first.period
  } to ${last.period}`;
}

function pointsFor(built: BuiltWindows, setting: DriverSetting): MixTimelinePoint[] {
  return built.windows.map((w) => {
    const mix = actionMixFor(w.symbols, setting, { minConfirmed: built.minConfirmed });
    return {
      period: w.period,
      asOf: w.asOf,
      bucketTrades: w.bucketTrades,
      windowTrades: w.windowTrades,
      ranked: mix.total,
      buy: mix.byStance.buy.count,
      hold: mix.byStance.hold.count,
      sell: mix.byStance.sell.count,
      buyPct: mix.byStance.buy.pct,
      holdPct: mix.byStance.hold.pct,
      sellPct: mix.byStance.sell.pct,
      avgSize: mix.avgSize,
      mix,
    };
  });
}

export type MixTimelineGrid = {
  bucket: MixBucketSize;
  window: MixWindowMode;
  rollingBuckets: number;
  /** Keyed `${risk}|${gapWeight}` — see `mixTimelineKey`. */
  entries: Record<string, MixTimeline>;
};

export const mixTimelineKey = (setting: DriverSetting) =>
  `${setting.risk}|${setting.gapWeight}`;

/**
 * One timeline per (risk × gap weight) cell, sharing a single pass of window
 * bucketing and symbol ranking. `mix` is stripped from every point so the grid
 * is cheap to serialise to the client.
 */
export function mixTimelineGrid(
  trades: readonly SignalTrade[],
  risks: readonly DriverSetting["risk"][],
  gapWeights: readonly number[],
  options: MixTimelineOptions = {},
): MixTimelineGrid {
  const built = buildWindows(trades, options);
  const trimEmptyLead = options.trimEmptyLead ?? true;
  const entries: Record<string, MixTimeline> = {};

  for (const risk of risks) {
    for (const gapWeight of gapWeights) {
      const setting = { risk, gapWeight };
      const raw = pointsFor(built, setting);
      const points = (trimEmptyLead ? dropLeadingEmpty(raw) : raw).map(
        ({ mix: _mix, ...rest }) => rest,
      );
      entries[mixTimelineKey(setting)] = {
        setting,
        bucket: built.bucket,
        window: built.window,
        rollingBuckets: built.rollingBuckets,
        points,
        shift: shiftOf(points),
        summary: summaryOf(points, built),
      };
    }
  }

  return { bucket: built.bucket, window: built.window, rollingBuckets: built.rollingBuckets, entries };
}

function dropLeadingEmpty<T extends PointLike>(points: T[]): T[] {
  const firstRanked = points.findIndex((p) => p.ranked > 0);
  return firstRanked <= 0 ? points : points.slice(firstRanked);
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
