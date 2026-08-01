// Event study: how do reported high-profile executive social posts map onto
// the subsequent price path of the symbols they touch?
//
// Pure module. Given detected posts (from `exec-posts.ts`) and a close-price
// series per symbol, it produces one event row per (post × symbol) with
// forward returns at +1/+3/+5 trading days, then aggregates those rows into
// per-executive statistics the learning layer turns into coefficients.

import type { DetectedExecPost } from "./exec-posts";

export type PriceBar = { date: string; close: number };

export type ExecPostEvent = {
  executive_id: string;
  executive_name: string;
  symbol: string;
  post_date: string;
  headline: string;
  source: string | null;
  url: string | null;
  /** -1..1 sentiment of the post as scored by the news layer. */
  sentiment: number;
  base_price: number;
  /** Percentage moves (e.g. 1.42 = +1.42%). Null when the bar is unavailable. */
  ret_1d: number | null;
  ret_3d: number | null;
  ret_5d: number | null;
  /**
   * Largest move *against* the post's direction within the 5-day window,
   * expressed as a positive percentage (0 when the path never went adverse).
   */
  max_adverse_pct: number | null;
};

function pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return Number((((to - from) / from) * 100).toFixed(4));
}

/** Index of the first bar strictly after `date`, or -1. */
function firstBarAfter(bars: PriceBar[], date: string): number {
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar && bar.date > date) return i;
  }
  return -1;
}

/** Last bar on or before `date`, or null. */
function barOnOrBefore(bars: PriceBar[], date: string): PriceBar | null {
  let found: PriceBar | null = null;
  for (const bar of bars) {
    if (bar.date <= date) found = bar;
    else break;
  }
  return found;
}

/**
 * Builds event rows. `prices` maps an upper-case symbol to its ascending
 * close series. Posts without a sentiment score, or symbols with no usable
 * base bar, are skipped — an unscored post carries no directional claim to
 * test.
 */
export function buildExecPostEvents(
  posts: DetectedExecPost[],
  prices: Map<string, PriceBar[]>,
): ExecPostEvent[] {
  const out: ExecPostEvent[] = [];

  for (const post of posts) {
    const sentiment = post.sentiment;
    if (sentiment == null || !Number.isFinite(sentiment)) continue;
    const postDate = (post.date ?? "").slice(0, 10);
    if (!postDate) continue;

    for (const rawSymbol of post.symbols) {
      const symbol = rawSymbol.toUpperCase();
      const bars = prices.get(symbol);
      if (!bars || bars.length === 0) continue;

      const base = barOnOrBefore(bars, postDate);
      if (!base || !Number.isFinite(base.close) || base.close <= 0) continue;

      const start = firstBarAfter(bars, postDate);
      const forward = start === -1 ? [] : bars.slice(start, start + 5);

      const at = (n: number): number | null => {
        const bar = forward[n - 1];
        return bar ? pct(base.close, bar.close) : null;
      };

      const dir = sentiment >= 0 ? 1 : -1;
      let maxAdverse: number | null = null;
      for (const bar of forward) {
        const move = pct(base.close, bar.close) * dir;
        const adverse = move < 0 ? -move : 0;
        maxAdverse = maxAdverse == null ? adverse : Math.max(maxAdverse, adverse);
      }

      out.push({
        executive_id: post.executive_id,
        executive_name: post.executive_name,
        symbol,
        post_date: postDate,
        headline: post.headline,
        source: post.source ?? null,
        url: post.url ?? null,
        sentiment: Number(sentiment.toFixed(3)),
        base_price: Number(base.close.toFixed(6)),
        ret_1d: at(1),
        ret_3d: at(3),
        ret_5d: at(5),
        max_adverse_pct: maxAdverse == null ? null : Number(maxAdverse.toFixed(4)),
      });
    }
  }

  return out.sort((a, b) => (a.post_date < b.post_date ? 1 : a.post_date > b.post_date ? -1 : 0));
}

export type ExecPostStat = {
  executive_id: string;
  executive_name: string;
  /** Events with a usable +1d return. */
  samples: number;
  /** Share of events where the +1d move agreed with the post's sign. */
  hit_rate_1d: number;
  /** Mean +1d move measured in the post's direction (positive = post "worked"). */
  mean_signed_1d: number;
  mean_signed_3d: number;
  mean_signed_5d: number;
  /** Mean absolute +1d move — how much the tape actually reacts at all. */
  mean_abs_1d: number;
  /** Share where +1d agreed but +5d had given it all back and gone the other way. */
  reversal_rate: number;
  /** Mean of the worst adverse excursion, in percent. */
  mean_max_adverse: number;
  /**
   * Rough decay: how much of the +1d signed move survives to +5d, 0..1.
   * <=0 means the move fully reverses inside the week.
   */
  persistence: number;
  symbols: string[];
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(n: number, dp = 4): number {
  return Number(n.toFixed(dp));
}

/** Per-executive aggregate. Executives with no scored events are omitted. */
export function summariseExecPostEvents(events: ExecPostEvent[]): ExecPostStat[] {
  const groups = new Map<string, ExecPostEvent[]>();
  for (const ev of events) {
    const list = groups.get(ev.executive_id) ?? [];
    list.push(ev);
    groups.set(ev.executive_id, list);
  }

  const stats: ExecPostStat[] = [];
  for (const [id, list] of groups) {
    const withRet = list.filter((e) => e.ret_1d != null);
    if (withRet.length === 0) continue;

    const dir = (e: ExecPostEvent) => (e.sentiment >= 0 ? 1 : -1);
    const signed1 = withRet.map((e) => (e.ret_1d as number) * dir(e));
    const signed3 = list.filter((e) => e.ret_3d != null).map((e) => (e.ret_3d as number) * dir(e));
    const signed5 = list.filter((e) => e.ret_5d != null).map((e) => (e.ret_5d as number) * dir(e));
    const hits = signed1.filter((v) => v > 0).length;
    const reversals = withRet.filter((e) => {
      const d = dir(e);
      const one = (e.ret_1d as number) * d;
      const five = e.ret_5d == null ? null : (e.ret_5d as number) * d;
      return one > 0 && five != null && five < 0;
    }).length;
    const adverse = list
      .filter((e) => e.max_adverse_pct != null)
      .map((e) => e.max_adverse_pct as number);

    const m1 = mean(signed1);
    const m5 = signed5.length > 0 ? mean(signed5) : 0;

    stats.push({
      executive_id: id,
      executive_name: list[0]?.executive_name ?? id,
      samples: withRet.length,
      hit_rate_1d: round(hits / withRet.length),
      mean_signed_1d: round(m1),
      mean_signed_3d: round(signed3.length > 0 ? mean(signed3) : 0),
      mean_signed_5d: round(m5),
      mean_abs_1d: round(mean(withRet.map((e) => Math.abs(e.ret_1d as number)))),
      reversal_rate: round(reversals / withRet.length),
      mean_max_adverse: round(adverse.length > 0 ? mean(adverse) : 0),
      persistence: round(Math.abs(m1) < 1e-9 ? 0 : Math.max(-1, Math.min(1, m5 / Math.abs(m1)))),
      symbols: Array.from(new Set(list.map((e) => e.symbol))).sort(),
    });
  }

  return stats.sort((a, b) => b.samples - a.samples || a.executive_id.localeCompare(b.executive_id));
}

export type ExecPostStudySummary = {
  window_days: number;
  events: number;
  scored_posts: number;
  executives: number;
  overall_hit_rate_1d: number;
  overall_mean_abs_1d: number;
  overall_reversal_rate: number;
  by_executive: ExecPostStat[];
};

export function summariseStudy(
  events: ExecPostEvent[],
  windowDays: number,
): ExecPostStudySummary {
  const byExec = summariseExecPostEvents(events);
  const withRet = events.filter((e) => e.ret_1d != null);
  const dir = (e: ExecPostEvent) => (e.sentiment >= 0 ? 1 : -1);
  const hits = withRet.filter((e) => (e.ret_1d as number) * dir(e) > 0).length;
  const reversals = withRet.filter((e) => {
    const d = dir(e);
    return (e.ret_1d as number) * d > 0 && e.ret_5d != null && (e.ret_5d as number) * d < 0;
  }).length;

  return {
    window_days: windowDays,
    events: events.length,
    scored_posts: new Set(events.map((e) => `${e.executive_id}|${e.post_date}|${e.headline}`)).size,
    executives: byExec.length,
    overall_hit_rate_1d: withRet.length > 0 ? round(hits / withRet.length) : 0,
    overall_mean_abs_1d:
      withRet.length > 0 ? round(mean(withRet.map((e) => Math.abs(e.ret_1d as number)))) : 0,
    overall_reversal_rate: withRet.length > 0 ? round(reversals / withRet.length) : 0,
    by_executive: byExec,
  };
}
