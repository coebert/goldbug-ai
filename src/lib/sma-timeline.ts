// Per-symbol SMA history report.
//
// The live engine (`alpha/sma-cross-rules`) only ever answers "what is the
// trend state *right now*". This module answers the retrospective question:
// across the whole price history of one symbol, where did SMA20/50 cross,
// which golden/death regime were we in at each point, and what did the AI
// actually do about it?
//
// It is deliberately a separate, pure module rather than a hook into the
// engine: replaying the engine bar-by-bar would drag in portfolio state,
// costs and gating, whereas a report only needs the trend geometry plus the
// executed trades. Same thresholds though — it reads `SmaCrossRuleConfig` so
// the report reflects whatever the portfolio's risk profile actually uses.
//
// Pure. No I/O.

import {
  DEFAULT_SMA_CROSS_RULES,
  type SmaCrossRuleConfig,
  type SmaDataQuality,
} from "./alpha/sma-cross-rules";

export type SmaBarInput = {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  close: number | string | null | undefined;
};

export type SmaDecisionInput = {
  /** ISO date, YYYY-MM-DD. Snapped to the bar on/before this date. */
  date: string;
  side: "buy" | "sell";
  quantity?: number | null;
  price?: number | null;
  value?: number | null;
  reason?: string | null;
};

export type SmaTimelineBar = {
  date: string;
  close: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  /** (SMA20 - SMA50) / SMA50. */
  fastSpreadPct: number | null;
  /** (SMA50 - SMA200) / SMA200. */
  regimeSpreadPct: number | null;
  regime: "golden" | "death" | null;
};

export type SmaCrossEvent = {
  kind: "fast" | "regime";
  /** fast: bull/bear (SMA20 vs SMA50). regime: golden/death (SMA50 vs 200). */
  direction: "bull" | "bear" | "golden" | "death";
  /** Date the SMA ordering flipped. */
  date: string;
  barIndex: number;
  /** Separation at the flip bar, as a fraction of the slow SMA. */
  separationPct: number;
  /**
   * Date the flip was confirmed (held `confirmBars` bars *and* cleared the
   * separation band). Null = never confirmed: a whipsaw the engine ignored.
   */
  confirmedDate: string | null;
  confirmedBarIndex: number | null;
  /** Bars the new ordering survived before flipping back (null = still live). */
  heldBars: number | null;
  /** Close-to-close price change from the flip bar to the next flip/today. */
  forwardReturnPct: number | null;
  /** True when the engine's thresholds would have rejected this as noise. */
  whipsaw: boolean;
};

export type SmaRegimeSegment = {
  regime: "golden" | "death" | "unknown";
  startDate: string;
  endDate: string;
  bars: number;
  /** Price change across the segment. */
  returnPct: number | null;
  buys: number;
  sells: number;
  /** Net traded value inside the segment (buys positive, sells negative). */
  netValue: number;
};

export type SmaDecisionRow = {
  date: string;
  side: "buy" | "sell";
  quantity: number | null;
  price: number | null;
  value: number | null;
  reason: string | null;
  /** Bar the decision was matched to (null when it predates the price data). */
  barIndex: number | null;
  close: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  fastSpreadPct: number | null;
  regimeSpreadPct: number | null;
  regime: "golden" | "death" | "unknown";
  /** Most recent confirmed fast cross at the time, and its age in bars. */
  lastFastCross: "bull" | "bear" | null;
  fastCrossAgeBars: number | null;
  lastRegimeCross: "golden" | "death" | null;
  regimeCrossAgeBars: number | null;
  /** How the trade lines up with the trend model at that moment. */
  alignment: "with_trend" | "against_trend" | "neutral";
  /** Plain-language one-liner for the report table. */
  note: string;
};

export type SmaSymbolReport = {
  symbol: string;
  bars: SmaTimelineBar[];
  crosses: SmaCrossEvent[];
  regimes: SmaRegimeSegment[];
  decisions: SmaDecisionRow[];
  summary: {
    barCount: number;
    droppedBars: number;
    firstDate: string | null;
    lastDate: string | null;
    quality: SmaDataQuality;
    currentRegime: "golden" | "death" | "unknown";
    fastCrosses: number;
    confirmedFastCrosses: number;
    whipsawFastCrosses: number;
    goldenCrosses: number;
    deathCrosses: number;
    buys: number;
    sells: number;
    withTrend: number;
    againstTrend: number;
    /** Share of decisions taken in the direction the trend model favoured. */
    withTrendPct: number | null;
    /** Median forward return after a confirmed bull cross, for context. */
    medianBullForwardPct: number | null;
    medianBearForwardPct: number | null;
    warnings: string[];
  };
};

const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

function rollingSma(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= period) sum -= closes[i - period]!;
    if (i >= period - 1) {
      const avg = sum / period;
      out[i] = Number.isFinite(avg) && avg > 0 ? avg : null;
    }
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const fmtPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

/**
 * Detect every ordering flip between two SMA series, and mark which ones the
 * engine's thresholds would have accepted.
 */
function detectCrosses(
  dates: string[],
  closes: number[],
  fast: (number | null)[],
  slow: (number | null)[],
  kind: "fast" | "regime",
  separationBand: number,
  confirmBars: number,
): SmaCrossEvent[] {
  const events: SmaCrossEvent[] = [];
  const confirm = Math.max(1, confirmBars);
  let prevAbove: boolean | null = null;

  for (let i = 0; i < closes.length; i++) {
    const f = fast[i];
    const s = slow[i];
    if (f == null || s == null || !(s > 0)) continue;
    const above = f > s;
    if (prevAbove == null) {
      prevAbove = above;
      continue;
    }
    if (above === prevAbove) continue;
    prevAbove = above;

    // Ordering must survive `confirm` bars and clear the separation band on
    // the confirmation bar — the same two tests the live rule applies.
    let confirmedIndex: number | null = null;
    let held = 0;
    for (let j = i + 1; j < closes.length; j++) {
      const fj = fast[j];
      const sj = slow[j];
      if (fj == null || sj == null || !(sj > 0)) break;
      if (fj > sj !== above) break;
      held++;
      if (
        confirmedIndex == null &&
        held >= confirm &&
        Math.abs((fj - sj) / sj) >= separationBand
      ) {
        confirmedIndex = j;
      }
    }
    const stillLive = i + held === closes.length - 1;

    // Forward return runs to the next flip (or to the end of the series).
    const endIdx = Math.min(closes.length - 1, i + held);
    const from = closes[i]!;
    const forward = from > 0 ? (closes[endIdx]! - from) / from : null;

    events.push({
      kind,
      direction: kind === "fast" ? (above ? "bull" : "bear") : above ? "golden" : "death",
      date: dates[i]!,
      barIndex: i,
      separationPct: (f - s) / s,
      confirmedDate: confirmedIndex == null ? null : dates[confirmedIndex]!,
      confirmedBarIndex: confirmedIndex,
      heldBars: stillLive ? null : held,
      forwardReturnPct: forward,
      whipsaw: confirmedIndex == null,
    });
  }
  return events;
}

/**
 * Build the full per-symbol report: SMA20/50 crossover points, the
 * SMA50/200 golden/death regime timeline, and every buy/sell decision
 * annotated with the trend state at the moment it was taken.
 */
export function buildSmaSymbolReport(
  symbol: string,
  barsInput: SmaBarInput[],
  decisionsInput: SmaDecisionInput[] = [],
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaSymbolReport {
  const warnings: string[] = [];

  // Normalise: drop unusable closes, dedupe dates (last write wins), sort.
  const byDate = new Map<string, number>();
  let dropped = 0;
  for (const raw of barsInput ?? []) {
    const close = toNum(raw?.close);
    const date = typeof raw?.date === "string" ? raw.date.slice(0, 10) : "";
    if (!close || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dropped++;
      continue;
    }
    byDate.set(date, close);
  }
  if (dropped > 0) warnings.push(`${dropped} invalid bar(s) dropped`);

  const dates = [...byDate.keys()].sort();
  const closes = dates.map((d) => byDate.get(d)!);
  const n = closes.length;

  const sma20 = rollingSma(closes, 20);
  const sma50 = rollingSma(closes, 50);
  const sma200 = rollingSma(closes, 200);

  const bars: SmaTimelineBar[] = dates.map((date, i) => {
    const f = sma20[i] ?? null;
    const s = sma50[i] ?? null;
    const l = sma200[i] ?? null;
    return {
      date,
      close: closes[i]!,
      sma20: f,
      sma50: s,
      sma200: l,
      fastSpreadPct: f != null && s != null && s > 0 ? (f - s) / s : null,
      regimeSpreadPct: s != null && l != null && l > 0 ? (s - l) / l : null,
      regime: s != null && l != null && l > 0 ? (s > l ? "golden" : "death") : null,
    };
  });

  if (n > 0 && n < Math.max(20, cfg.minBarsFast)) {
    warnings.push(`only ${n} bars (<${Math.max(20, cfg.minBarsFast)}) — fast crosses are provisional`);
  }
  if (n < Math.max(200, cfg.minBarsRegime)) {
    warnings.push(`${n} bars — no SMA200 yet, long-term regime unknown for part of the history`);
  }

  const fastCrosses = detectCrosses(dates, closes, sma20, sma50, "fast", cfg.fastSeparationPct, cfg.confirmBars);
  const regimeCrosses = detectCrosses(dates, closes, sma50, sma200, "regime", cfg.regimeSeparationPct, cfg.confirmBars);
  const crosses = [...fastCrosses, ...regimeCrosses].sort(
    (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
  );

  // ---- Regime segments (contiguous runs of golden/death/unknown) --------
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const decisions: SmaDecisionRow[] = [];
  const segments: SmaRegimeSegment[] = [];
  let segStart = 0;
  for (let i = 0; i <= n; i++) {
    const cur = i < n ? (bars[i]!.regime ?? "unknown") : null;
    const prev = bars[segStart]?.regime ?? "unknown";
    if (i === n || cur !== prev) {
      if (n > 0) {
        const endIdx = i - 1;
        const from = closes[segStart]!;
        segments.push({
          regime: prev,
          startDate: dates[segStart]!,
          endDate: dates[endIdx]!,
          bars: endIdx - segStart + 1,
          returnPct: from > 0 ? (closes[endIdx]! - from) / from : null,
          buys: 0,
          sells: 0,
          netValue: 0,
        });
      }
      segStart = i;
    }
  }

  // ---- Decisions, annotated with the state at the time -----------------
  const sortedDecisions = [...(decisionsInput ?? [])]
    .filter((d) => d && (d.side === "buy" || d.side === "sell") && typeof d.date === "string")
    .map((d) => ({ ...d, date: d.date.slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lastConfirmedAtOrBefore = (events: SmaCrossEvent[], barIdx: number) => {
    let best: SmaCrossEvent | null = null;
    for (const e of events) {
      if (e.confirmedBarIndex == null || e.confirmedBarIndex > barIdx) continue;
      best = e;
    }
    return best;
  };

  for (const d of sortedDecisions) {
    // Snap to the bar on or before the trade date — trades happen intraday
    // and can land on a date with no cached close (holiday, missing bar).
    let barIndex = dateIndex.get(d.date) ?? null;
    if (barIndex == null) {
      let lo = 0;
      let hi = n - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid]! <= d.date) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      barIndex = found >= 0 ? found : null;
    }

    const bar = barIndex == null ? null : bars[barIndex]!;
    const regime = bar?.regime ?? "unknown";
    const fastEvent = barIndex == null ? null : lastConfirmedAtOrBefore(fastCrosses, barIndex);
    const regimeEvent = barIndex == null ? null : lastConfirmedAtOrBefore(regimeCrosses, barIndex);
    const fastDir = fastEvent ? (fastEvent.direction as "bull" | "bear") : null;
    const regimeDir = regimeEvent ? (regimeEvent.direction as "golden" | "death") : null;
    const fastAge =
      fastEvent && barIndex != null ? barIndex - (fastEvent.confirmedBarIndex ?? fastEvent.barIndex) : null;
    const regimeAge =
      regimeEvent && barIndex != null ? barIndex - (regimeEvent.confirmedBarIndex ?? regimeEvent.barIndex) : null;

    // "With trend" = buying while the fast trend is up (or, absent a fast
    // read, in a golden regime) and selling while it is down.
    const trendUp = fastDir === "bull" ? true : fastDir === "bear" ? false : regime === "golden" ? true : null;
    const alignment: SmaDecisionRow["alignment"] =
      trendUp == null
        ? "neutral"
        : (d.side === "buy") === trendUp
          ? "with_trend"
          : "against_trend";

    const value = Number.isFinite(Number(d.value)) ? Number(d.value) : null;
    const parts: string[] = [];
    parts.push(
      fastDir
        ? `SMA20/50 ${fastDir === "bull" ? "bull" : "bear"} cross ${fastAge === 0 ? "that day" : `${fastAge} bar(s) earlier`}`
        : "no confirmed SMA20/50 cross on record",
    );
    parts.push(
      regime === "unknown"
        ? "long-term regime unknown (short history)"
        : `${regime} regime (SMA50 ${fmtPct(bar?.regimeSpreadPct ?? null)} vs SMA200)`,
    );
    if (regimeDir && regimeAge != null && regimeAge <= cfg.maxCrossAgeBars) {
      parts.push(`fresh ${regimeDir} cross ${regimeAge} bar(s) earlier`);
    }
    parts.push(
      alignment === "with_trend"
        ? `${d.side} ran with the trend`
        : alignment === "against_trend"
          ? `${d.side} ran against the trend`
          : `${d.side} taken with no clear trend read`,
    );

    const row: SmaDecisionRow = {
      date: d.date,
      side: d.side,
      quantity: Number.isFinite(Number(d.quantity)) ? Number(d.quantity) : null,
      price: Number.isFinite(Number(d.price)) ? Number(d.price) : null,
      value,
      reason: d.reason ?? null,
      barIndex,
      close: bar?.close ?? null,
      sma20: bar?.sma20 ?? null,
      sma50: bar?.sma50 ?? null,
      sma200: bar?.sma200 ?? null,
      fastSpreadPct: bar?.fastSpreadPct ?? null,
      regimeSpreadPct: bar?.regimeSpreadPct ?? null,
      regime,
      lastFastCross: fastDir,
      fastCrossAgeBars: fastAge,
      lastRegimeCross: regimeDir,
      regimeCrossAgeBars: regimeAge,
      alignment,
      note: parts.join("; "),
    };
    decisions.push(row);

    // Roll the trade into its regime segment.
    const seg = segments.find((s) => d.date >= s.startDate && d.date <= s.endDate);
    if (seg) {
      if (d.side === "buy") seg.buys++;
      else seg.sells++;
      if (value != null) seg.netValue += d.side === "buy" ? value : -value;
    }
  }

  const confirmedFast = fastCrosses.filter((c) => !c.whipsaw);
  const withTrend = decisions.filter((d) => d.alignment === "with_trend").length;
  const againstTrend = decisions.filter((d) => d.alignment === "against_trend").length;
  const decided = withTrend + againstTrend;

  const quality: SmaDataQuality =
    n === 0 || n < Math.max(20, cfg.minBarsFast)
      ? "insufficient"
      : n >= Math.max(200, cfg.minBarsRegime)
        ? "full"
        : "partial";

  return {
    symbol,
    bars,
    crosses,
    regimes: segments,
    decisions,
    summary: {
      barCount: n,
      droppedBars: dropped,
      firstDate: dates[0] ?? null,
      lastDate: dates[n - 1] ?? null,
      quality,
      currentRegime: bars[n - 1]?.regime ?? "unknown",
      fastCrosses: fastCrosses.length,
      confirmedFastCrosses: confirmedFast.length,
      whipsawFastCrosses: fastCrosses.length - confirmedFast.length,
      goldenCrosses: regimeCrosses.filter((c) => c.direction === "golden" && !c.whipsaw).length,
      deathCrosses: regimeCrosses.filter((c) => c.direction === "death" && !c.whipsaw).length,
      buys: decisions.filter((d) => d.side === "buy").length,
      sells: decisions.filter((d) => d.side === "sell").length,
      withTrend,
      againstTrend,
      withTrendPct: decided > 0 ? withTrend / decided : null,
      medianBullForwardPct: median(
        confirmedFast
          .filter((c) => c.direction === "bull" && c.forwardReturnPct != null)
          .map((c) => c.forwardReturnPct!),
      ),
      medianBearForwardPct: median(
        confirmedFast
          .filter((c) => c.direction === "bear" && c.forwardReturnPct != null)
          .map((c) => c.forwardReturnPct!),
      ),
      warnings,
    },
  };
}
