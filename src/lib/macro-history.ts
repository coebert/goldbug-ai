// Twenty-year news → market-pattern study (deterministic half).
//
// Two independent sources of evidence feed the learning layer:
//
//   1. A catalogue of the major documented macro episodes since 2005, each
//      tagged with the market-event kind that headlined it, the index
//      drawdown it produced, and how long the recovery took. This is the
//      historical record the app cannot re-derive from its own price cache
//      (it never stored intraday 2008 or the 2020 crash tick by tick).
//
//   2. A live drawdown/recovery study computed from the real index series in
//      `price_cache` (SPY back to 1993), which measures — on this system's own
//      data — what actually followed a given drawdown depth: the hit rate and
//      mean forward return at 1m / 3m / 12m, and how long the hole took to
//      fill.
//
// Pure and deterministic: no I/O, no LLM. The AI layer only interprets the
// output of this module and proposes *bounded* adjustments.

import type { MarketEventKind } from "./market-events";

/** Event kinds the catalogue uses, including two not produced by the classifier. */
export type MacroEpisodeKind = MarketEventKind | "liquidity_stress" | "retail_mania";

export type MacroEpisode = {
  id: string;
  label: string;
  /** ISO date the drawdown started (index peak). */
  start: string;
  /** ISO date of the trough. */
  trough: string;
  /** Headline market-event kind that characterised the episode. */
  kind: MacroEpisodeKind;
  /** Peak-to-trough drawdown of the US large-cap index, positive %. */
  drawdown_pct: number;
  /** Calendar days from trough back to the prior peak; null = not recovered in-sample. */
  recovery_days: number | null;
  /** Was the shock exogenous (war, pandemic) or endogenous (credit, valuation)? */
  origin: "credit" | "policy" | "geopolitical" | "pandemic" | "valuation" | "liquidity";
  /** What worked, in one line — the transferable lesson. */
  lesson: string;
};

/**
 * Documented episodes, 2005 → present. Drawdowns are peak-to-trough on the
 * S&P 500 in price terms, rounded; recovery is calendar days back to the old
 * high. These are stable historical facts used as priors, not predictions.
 */
export const MACRO_EPISODES: MacroEpisode[] = [
  {
    id: "quant_quake_2007",
    label: "Quant quake",
    start: "2007-07-19", trough: "2007-08-15", kind: "liquidity_stress",
    drawdown_pct: 9.4, recovery_days: 62, origin: "liquidity",
    lesson: "A crowded-factor unwind hits leveraged lookalike books first; unlevered positions that survive the week are usually made whole.",
  },
  {
    id: "gfc_2008",
    label: "Global financial crisis",
    start: "2007-10-09", trough: "2009-03-09", kind: "credit_downgrade",
    drawdown_pct: 56.8, recovery_days: 1480, origin: "credit",
    lesson: "Credit-origin bears are long and stair-stepped: every 10% bounce failed for 17 months. Trend and breadth filters, not valuation, kept capital intact.",
  },
  {
    id: "flash_crash_2010",
    label: "Flash crash",
    start: "2010-04-23", trough: "2010-07-02", kind: "liquidity_stress",
    drawdown_pct: 16.0, recovery_days: 145, origin: "liquidity",
    lesson: "A microstructure air-pocket with no cash-flow news round-trips in weeks; market orders into the vacuum are the only permanent loss.",
  },
  {
    id: "euro_crisis_2011",
    label: "Euro sovereign crisis / US downgrade",
    start: "2011-04-29", trough: "2011-10-03", kind: "credit_downgrade",
    drawdown_pct: 19.4, recovery_days: 199, origin: "credit",
    lesson: "Sovereign-stress selloffs stop the day the central bank speaks, not the day the fundamentals improve.",
  },
  {
    id: "taper_tantrum_2013",
    label: "Taper tantrum",
    start: "2013-05-21", trough: "2013-06-24", kind: "rate_hike",
    drawdown_pct: 5.8, recovery_days: 55, origin: "policy",
    lesson: "A hawkish policy repricing without a growth shock is shallow and quick; bonds and gold suffered far more than equities.",
  },
  {
    id: "china_deval_2015",
    label: "China devaluation / growth scare",
    start: "2015-05-21", trough: "2016-02-11", kind: "geopolitical_shock",
    drawdown_pct: 14.2, recovery_days: 285, origin: "policy",
    lesson: "A two-leg correction with a failed retest: the second low, not the first, was the entry.",
  },
  {
    id: "brexit_2016",
    label: "Brexit referendum",
    start: "2016-06-23", trough: "2016-06-27", kind: "geopolitical_shock",
    drawdown_pct: 5.6, recovery_days: 12, origin: "geopolitical",
    lesson: "A binary political shock with no credit transmission was fully retraced inside two weeks; the FX move persisted far longer than the equity move.",
  },
  {
    id: "volmageddon_2018",
    label: "Volmageddon",
    start: "2018-01-26", trough: "2018-02-08", kind: "liquidity_stress",
    drawdown_pct: 10.2, recovery_days: 194, origin: "liquidity",
    lesson: "A volatility-product unwind is a mechanical, not fundamental, event — but it resets the whole year's volatility regime.",
  },
  {
    id: "trade_war_2018",
    label: "Trade war / Q4 tightening",
    start: "2018-09-20", trough: "2018-12-24", kind: "tariffs",
    drawdown_pct: 19.8, recovery_days: 121, origin: "policy",
    lesson: "Tariff headlines produced repeated 3-5% swings with no lasting direction until the policy path itself changed; trading each headline was the losing strategy.",
  },
  {
    id: "covid_2020",
    label: "COVID-19 crash",
    start: "2020-02-19", trough: "2020-03-23", kind: "geopolitical_shock",
    drawdown_pct: 33.9, recovery_days: 149, origin: "pandemic",
    lesson: "The fastest 30% drawdown on record and the fastest recovery: an exogenous shock met with immediate policy support recovers in months, not years.",
  },
  {
    id: "meme_2021",
    label: "Meme-stock mania",
    start: "2021-01-27", trough: "2021-01-29", kind: "retail_mania",
    drawdown_pct: 3.7, recovery_days: 8, origin: "liquidity",
    lesson: "Index impact was trivial while individual names moved 10x; crowding, not the index, was the risk to size for.",
  },
  {
    id: "inflation_bear_2022",
    label: "Inflation / rate-shock bear",
    start: "2022-01-03", trough: "2022-10-12", kind: "inflation_hot",
    drawdown_pct: 25.4, recovery_days: 476, origin: "policy",
    lesson: "In a rate-shock bear, bonds failed as a hedge for the first time in a generation; cash and energy were the only shelters.",
  },
  {
    id: "ukraine_2022",
    label: "Ukraine invasion / energy shock",
    start: "2022-02-10", trough: "2022-03-08", kind: "energy_shock",
    drawdown_pct: 8.5, recovery_days: 21, origin: "geopolitical",
    lesson: "War headlines moved commodities durably and equities only briefly; the tradable expression was the input cost, not the index.",
  },
  {
    id: "svb_2023",
    label: "SVB / regional bank stress",
    start: "2023-02-02", trough: "2023-03-13", kind: "credit_downgrade",
    drawdown_pct: 7.8, recovery_days: 37, origin: "credit",
    lesson: "A contained credit event with a fast backstop is a dip to buy in the index and a hole to avoid in the affected sector.",
  },
  {
    id: "yen_carry_2024",
    label: "Yen carry unwind",
    start: "2024-07-16", trough: "2024-08-05", kind: "liquidity_stress",
    drawdown_pct: 8.5, recovery_days: 41, origin: "liquidity",
    lesson: "A funding-currency unwind produced a one-day VIX spike above 60 that had fully mean-reverted within a month; selling into the panic print was the error.",
  },
  {
    id: "tariff_shock_2025",
    label: "Reciprocal-tariff shock",
    start: "2025-02-19", trough: "2025-04-08", kind: "tariffs",
    drawdown_pct: 18.9, recovery_days: 88, origin: "policy",
    lesson: "A policy-made drawdown can be un-made by the same policy: the recovery began on the announcement of a pause, not on any change in earnings.",
  },
];

/** Distinct event kinds referenced by the catalogue (some are engine-specific). */
export function episodesByKind(kind: string): MacroEpisode[] {
  return MACRO_EPISODES.filter((e) => String(e.kind) === kind);
}

// ---------------------------------------------------------------------------
// Live study over the real index series
// ---------------------------------------------------------------------------

export type IndexBar = { date: string; close: number };

export type DrawdownEpisode = {
  peak_date: string;
  trough_date: string;
  drawdown_pct: number;
  /** Calendar days peak → trough. */
  decline_days: number;
  /** Calendar days trough → new high; null when still unrecovered at series end. */
  recovery_days: number | null;
};

/** Forward-return statistics measured from a set of entry points. */
export type ForwardStats = {
  samples: number;
  hit_rate: number;
  mean_pct: number;
  median_pct: number;
  worst_pct: number;
  best_pct: number;
};

export type DrawdownBucketStat = {
  /** Inclusive lower bound of the drawdown bucket, in %. */
  bucket_from: number;
  bucket_to: number;
  fwd_1m: ForwardStats;
  fwd_3m: ForwardStats;
  fwd_12m: ForwardStats;
};

export type IndexHistoryStudy = {
  symbol: string;
  from: string;
  to: string;
  bars: number;
  years: number;
  /** Annualised return over the whole sample, %. */
  cagr_pct: number;
  /** Annualised stdev of daily returns, %. */
  vol_pct: number;
  max_drawdown_pct: number;
  episodes: DrawdownEpisode[];
  /** Median calendar days to recover, across recovered episodes ≥10%. */
  median_recovery_days: number | null;
  /** Buy-the-dip evidence, bucketed by how deep the market already is. */
  buckets: DrawdownBucketStat[];
  /** Forward returns conditioned on trailing realised volatility tercile. */
  vol_regime: Array<{ regime: "calm" | "normal" | "stressed"; fwd_1m: ForwardStats; fwd_3m: ForwardStats }>;
};

function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function stats(values: number[]): ForwardStats {
  if (values.length === 0) {
    return { samples: 0, hit_rate: 0, mean_pct: 0, median_pct: 0, worst_pct: 0, best_pct: 0 };
  }
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    samples: values.length,
    hit_rate: Number((values.filter((v) => v > 0).length / values.length).toFixed(3)),
    mean_pct: Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2)),
    median_pct: Number(median.toFixed(2)),
    worst_pct: Number(sorted[0]!.toFixed(2)),
    best_pct: Number(sorted[sorted.length - 1]!.toFixed(2)),
  };
}

/** Peak-to-trough drawdown episodes deeper than `minPct`. */
export function findDrawdownEpisodes(bars: IndexBar[], minPct = 8): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  if (bars.length < 3) return out;

  let peakIdx = 0;
  let troughIdx = 0;
  let inDrawdown = false;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    if (bar.close >= bars[peakIdx]!.close) {
      if (inDrawdown) {
        const dd = -pct(bars[troughIdx]!.close, bars[peakIdx]!.close);
        if (dd >= minPct) {
          out.push({
            peak_date: bars[peakIdx]!.date,
            trough_date: bars[troughIdx]!.date,
            drawdown_pct: Number(dd.toFixed(2)),
            decline_days: daysBetween(bars[peakIdx]!.date, bars[troughIdx]!.date),
            recovery_days: daysBetween(bars[troughIdx]!.date, bar.date),
          });
        }
        inDrawdown = false;
      }
      peakIdx = i;
      troughIdx = i;
      continue;
    }
    if (bar.close < bars[troughIdx]!.close || !inDrawdown) {
      if (bar.close < bars[troughIdx]!.close || troughIdx === peakIdx) troughIdx = i;
      inDrawdown = true;
    }
  }

  // An unrecovered drawdown still in progress at the end of the series.
  if (inDrawdown) {
    const dd = -pct(bars[troughIdx]!.close, bars[peakIdx]!.close);
    if (dd >= minPct) {
      out.push({
        peak_date: bars[peakIdx]!.date,
        trough_date: bars[troughIdx]!.date,
        drawdown_pct: Number(dd.toFixed(2)),
        decline_days: daysBetween(bars[peakIdx]!.date, bars[troughIdx]!.date),
        recovery_days: null,
      });
    }
  }
  return out;
}

/** Index of the last bar on or before `target` days after bar `i`. */
function barAfterDays(bars: IndexBar[], i: number, days: number): number | null {
  const targetMs = Date.parse(bars[i]!.date) + days * 86_400_000;
  for (let j = i + 1; j < bars.length; j++) {
    if (Date.parse(bars[j]!.date) >= targetMs) return j;
  }
  return null;
}

const BUCKETS: Array<[number, number]> = [
  [0, 2],
  [2, 5],
  [5, 10],
  [10, 20],
  [20, 100],
];

/**
 * Full history study: drawdowns, recovery, and what the forward return looked
 * like from each level of drawdown. This is the "buy the dip" question asked
 * of the actual data rather than of intuition.
 */
export function analyseIndexHistory(symbol: string, barsIn: IndexBar[]): IndexHistoryStudy {
  const bars = [...barsIn]
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const empty: IndexHistoryStudy = {
    symbol, from: "", to: "", bars: 0, years: 0, cagr_pct: 0, vol_pct: 0,
    max_drawdown_pct: 0, episodes: [], median_recovery_days: null,
    buckets: [], vol_regime: [],
  };
  if (bars.length < 30) return empty;

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const years = Math.max(0.1, daysBetween(first.date, last.date) / 365.25);
  const cagr = (Math.pow(last.close / first.close, 1 / years) - 1) * 100;

  // Running peak + trailing volatility per bar.
  const runningPeak: number[] = [];
  let peak = 0;
  for (const b of bars) {
    peak = Math.max(peak, b.close);
    runningPeak.push(peak);
  }

  const rets: number[] = [0];
  for (let i = 1; i < bars.length; i++) rets.push(pct(bars[i]!.close, bars[i - 1]!.close));
  const barsPerYear = bars.length / years;
  const meanRet = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - meanRet) ** 2, 0) / Math.max(1, rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(barsPerYear);

  const trailingVol: Array<number | null> = bars.map((_, i) => {
    if (i < 20) return null;
    const win = rets.slice(i - 19, i + 1);
    const m = win.reduce((s, v) => s + v, 0) / win.length;
    const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1);
    return Math.sqrt(v) * Math.sqrt(barsPerYear);
  });

  const observedVols = trailingVol.filter((v): v is number => v != null).sort((a, b) => a - b);
  const loCut = observedVols[Math.floor(observedVols.length / 3)] ?? 0;
  const hiCut = observedVols[Math.floor((observedVols.length * 2) / 3)] ?? 0;

  // Forward returns from every bar, bucketed by current drawdown and vol regime.
  const byBucket = new Map<string, { m1: number[]; m3: number[]; m12: number[] }>();
  const byVol = new Map<string, { m1: number[]; m3: number[] }>();

  for (let i = 0; i < bars.length; i++) {
    const dd = -pct(bars[i]!.close, runningPeak[i]!);
    const bucket = BUCKETS.find(([lo, hi]) => dd >= lo && dd < hi);
    const i1 = barAfterDays(bars, i, 30);
    const i3 = barAfterDays(bars, i, 91);
    const i12 = barAfterDays(bars, i, 365);
    const r1 = i1 == null ? null : pct(bars[i1]!.close, bars[i]!.close);
    const r3 = i3 == null ? null : pct(bars[i3]!.close, bars[i]!.close);
    const r12 = i12 == null ? null : pct(bars[i12]!.close, bars[i]!.close);

    if (bucket) {
      const key = `${bucket[0]}-${bucket[1]}`;
      const acc = byBucket.get(key) ?? { m1: [], m3: [], m12: [] };
      if (r1 != null) acc.m1.push(r1);
      if (r3 != null) acc.m3.push(r3);
      if (r12 != null) acc.m12.push(r12);
      byBucket.set(key, acc);
    }

    const tv = trailingVol[i];
    if (tv != null) {
      const regime = tv <= loCut ? "calm" : tv >= hiCut ? "stressed" : "normal";
      const acc = byVol.get(regime) ?? { m1: [], m3: [] };
      if (r1 != null) acc.m1.push(r1);
      if (r3 != null) acc.m3.push(r3);
      byVol.set(regime, acc);
    }
  }

  const episodes = findDrawdownEpisodes(bars, 8);
  const recovered = episodes
    .filter((e) => e.drawdown_pct >= 10 && e.recovery_days != null)
    .map((e) => e.recovery_days!)
    .sort((a, b) => a - b);

  return {
    symbol,
    from: first.date,
    to: last.date,
    bars: bars.length,
    years: Number(years.toFixed(1)),
    cagr_pct: Number(cagr.toFixed(2)),
    vol_pct: Number(vol.toFixed(2)),
    max_drawdown_pct: Number(Math.max(0, ...episodes.map((e) => e.drawdown_pct)).toFixed(2)),
    episodes: episodes.sort((a, b) => b.drawdown_pct - a.drawdown_pct).slice(0, 12),
    median_recovery_days: recovered.length > 0 ? recovered[Math.floor(recovered.length / 2)]! : null,
    buckets: BUCKETS.map(([lo, hi]) => {
      const acc = byBucket.get(`${lo}-${hi}`) ?? { m1: [], m3: [], m12: [] };
      return {
        bucket_from: lo,
        bucket_to: hi,
        fwd_1m: stats(acc.m1),
        fwd_3m: stats(acc.m3),
        fwd_12m: stats(acc.m12),
      };
    }),
    vol_regime: (["calm", "normal", "stressed"] as const).map((regime) => {
      const acc = byVol.get(regime) ?? { m1: [], m3: [] };
      return { regime, fwd_1m: stats(acc.m1), fwd_3m: stats(acc.m3) };
    }),
  };
}

// ---------------------------------------------------------------------------
// News-event → index response study (measured on whatever news history exists)
// ---------------------------------------------------------------------------

export type KindResponse = {
  kind: string;
  samples: number;
  /** Mean index move over the 5 sessions after a day carrying this event kind. */
  mean_fwd_5d: number;
  /** Share of those windows that closed higher. */
  up_rate: number;
  /** Mean move over the 20 sessions after — does the first reaction stick? */
  mean_fwd_20d: number;
  /** +1 the 20d move extended the 5d move, -1 it reversed it. */
  persistence: number;
};

/**
 * How the index behaved after days carrying each typed macro event kind.
 * `eventDays` is a map of ISO date → the event kinds seen that day.
 */
export function measureKindResponses(
  eventDays: Map<string, string[]>,
  bars: IndexBar[],
): KindResponse[] {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const byKind = new Map<string, { f5: number[]; f20: number[] }>();

  for (const [date, kinds] of eventDays) {
    let idx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.date <= date) idx = i;
      else break;
    }
    if (idx < 0) continue;
    const i5 = barAfterDays(sorted, idx, 7);
    const i20 = barAfterDays(sorted, idx, 28);
    const f5 = i5 == null ? null : pct(sorted[i5]!.close, sorted[idx]!.close);
    const f20 = i20 == null ? null : pct(sorted[i20]!.close, sorted[idx]!.close);
    for (const kind of new Set(kinds)) {
      const acc = byKind.get(kind) ?? { f5: [], f20: [] };
      if (f5 != null) acc.f5.push(f5);
      if (f20 != null) acc.f20.push(f20);
      byKind.set(kind, acc);
    }
  }

  const out: KindResponse[] = [];
  for (const [kind, acc] of byKind) {
    if (acc.f5.length === 0) continue;
    const m5 = acc.f5.reduce((s, v) => s + v, 0) / acc.f5.length;
    const m20 = acc.f20.length > 0 ? acc.f20.reduce((s, v) => s + v, 0) / acc.f20.length : m5;
    out.push({
      kind,
      samples: acc.f5.length,
      mean_fwd_5d: Number(m5.toFixed(2)),
      up_rate: Number((acc.f5.filter((v) => v > 0).length / acc.f5.length).toFixed(3)),
      mean_fwd_20d: Number(m20.toFixed(2)),
      persistence: Math.sign(m5) === Math.sign(m20) && Math.abs(m20) >= Math.abs(m5) ? 1 : -1,
    });
  }
  return out.sort((a, b) => b.samples - a.samples);
}

export type MacroHistoryStudy = {
  generated_at: string;
  index: IndexHistoryStudy;
  secondary: IndexHistoryStudy | null;
  kind_responses: KindResponse[];
  episodes: MacroEpisode[];
  news_window_days: number;
  news_events: number;
  /** Curated global-events reel measured against the index (may be absent on old rows). */
  global_events?: import("./global-event-study").GlobalEventStudy | null;
};

