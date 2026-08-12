/**
 * Post-reclaim setup scanner rules.
 *
 * These encode the transferable lessons the AI extracted from the CoreWeave
 * (CRWV) +21% session: a high-volatility name that reclaimed its long moving
 * averages on thin relative volume is a *watch*, not a buy. The scan surfaces
 * the same shape elsewhere so those names get monitored for a pullback into
 * the reclaimed averages instead of chased on the surge bar.
 *
 * Pure functions only — candles in, verdict out — so the rules are unit
 * testable without touching the network or the database.
 */

export type ScanCandle = {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
};

export type SetupScanRules = {
  /** Minimum 5-session gain that qualifies as a surge. */
  minSurgePct: number;
  /** Relative volume must stay BELOW this — thin tape is the froth tell. */
  maxRelVolume: number;
  /** Minimum annualised volatility for the "high-vol" leg of the setup. */
  minAnnualVolPct: number;
  /** How recently the moving-average reclaim must have happened. */
  reclaimLookbackDays: number;
  /** Reject names already extended far above the reclaimed average. */
  maxExtensionPct: number;
};

export const RECLAIM_SCAN_RULES: SetupScanRules = {
  minSurgePct: 10,
  maxRelVolume: 2.0,
  minAnnualVolPct: 60,
  reclaimLookbackDays: 5,
  maxExtensionPct: 25,
};

export type SetupMatch = {
  symbol: string;
  name: string | null;
  price: number;
  sma50: number;
  sma200: number;
  rsi14: number | null;
  relVolume: number;
  annualVolPct: number;
  changePct1d: number;
  changePct5d: number;
  /** Sessions since the close first crossed back above the 50d average. */
  reclaimAgeDays: number;
  /** Higher = closer to the archetype. 0-100. */
  score: number;
  reasons: string[];
  /** Suggested pullback alert zone (into the reclaimed averages). */
  zoneLow: number;
  zoneHigh: number;
  /** Close below this fills the surge gap and voids the setup. */
  invalidationBelow: number;
  /** Position cap implied by the realised volatility. */
  maxWeightPct: number;
  thesis: string;
  /** Compact chart + timeline context for the match. */
  timeline: SetupTimeline;
};

/** One session in the compact match chart. */
export type SetupSeriesPoint = {
  date: string;
  close: number;
  sma50: number | null;
  sma200: number | null;
  volume: number;
  /** Volume relative to the trailing 20-session average, when computable. */
  relVolume: number | null;
};

export type SetupTimeline = {
  /** Session on which the close crossed back above the 50d average. */
  reclaimDate: string;
  /** First session of the 5-session surge window. */
  surgeStartDate: string;
  /** Latest session in the window (the scan date). */
  surgeEndDate: string;
  latestDate: string;
  todayVolume: number;
  avgVolume20d: number;
  /** Highest single-session relative volume inside the surge window. */
  peakRelVolume: number;
  /** Trailing sessions for the sparkline, oldest first. */
  series: SetupSeriesPoint[];
};

export type SetupVerdict =
  | { match: SetupMatch; rejected: null }
  | { match: null; rejected: string };

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function smaAt(closes: number[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  return mean(closes.slice(endIndex + 1 - period, endIndex + 1));
}

function annualisedVolPct(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - window; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (!(prev > 0)) continue;
    rets.push(closes[i] / prev - 1);
  }
  if (rets.length < 5) return null;
  const m = mean(rets);
  const variance = mean(rets.map((r) => (r - m) ** 2));
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function wilderRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Sessions since close crossed from below to above the 50d average, or null. */
function reclaimAge(closes: number[], lookback: number): number | null {
  const last = closes.length - 1;
  for (let back = 0; back <= lookback; back += 1) {
    const i = last - back;
    if (i <= 0) break;
    const now = smaAt(closes, 50, i);
    const prev = smaAt(closes, 50, i - 1);
    if (now == null || prev == null) break;
    if (closes[i] > now && closes[i - 1] <= prev) return back;
  }
  return null;
}

/**
 * Evaluate one symbol against the post-reclaim, high-vol, low-relative-volume
 * archetype. Needs ~220 sessions of history for the 200d average.
 */
export function evaluateSetup(
  symbol: string,
  candles: ScanCandle[],
  opts: { name?: string | null; rules?: SetupScanRules } = {},
): SetupVerdict {
  const rules = opts.rules ?? RECLAIM_SCAN_RULES;
  const clean = candles.filter((c) => Number.isFinite(c.close) && c.close > 0);
  if (clean.length < 210) return { match: null, rejected: "not enough history for the 200d average" };

  const closes = clean.map((c) => c.close);
  const last = closes.length - 1;
  const price = closes[last];
  const sma50 = smaAt(closes, 50, last);
  const sma200 = smaAt(closes, 200, last);
  if (sma50 == null || sma200 == null) return { match: null, rejected: "moving averages unavailable" };

  if (!(price > sma50 && price > sma200)) {
    return { match: null, rejected: "price is not above both the 50d and 200d averages" };
  }

  const age = reclaimAge(closes, rules.reclaimLookbackDays);
  if (age == null) {
    return { match: null, rejected: `no 50d reclaim in the last ${rules.reclaimLookbackDays} sessions` };
  }

  const changePct5d = closes.length > 5 ? (price / closes[last - 5] - 1) * 100 : 0;
  if (changePct5d < rules.minSurgePct) {
    return { match: null, rejected: `5d move ${changePct5d.toFixed(1)}% below the ${rules.minSurgePct}% surge bar` };
  }

  const annualVolPct = annualisedVolPct(closes);
  if (annualVolPct == null) return { match: null, rejected: "volatility unavailable" };
  if (annualVolPct < rules.minAnnualVolPct) {
    return { match: null, rejected: `volatility ${annualVolPct.toFixed(0)}% under the ${rules.minAnnualVolPct}% bar` };
  }

  const vols = clean.slice(-21, -1).map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  const avgVol = vols.length >= 10 ? mean(vols) : null;
  const todayVol = clean[last].volume;
  if (avgVol == null || !(todayVol > 0)) return { match: null, rejected: "volume history unavailable" };
  const relVolume = todayVol / avgVol;
  if (relVolume >= rules.maxRelVolume) {
    return {
      match: null,
      rejected: `relative volume ${relVolume.toFixed(2)}x confirms the move (not the thin-tape setup)`,
    };
  }

  const extensionPct = (price / Math.max(sma50, sma200) - 1) * 100;
  if (extensionPct > rules.maxExtensionPct) {
    return { match: null, rejected: `${extensionPct.toFixed(0)}% extended above the reclaimed average` };
  }

  const changePct1d = (price / closes[last - 1] - 1) * 100;
  const rsi14 = wilderRsi(closes);
  const surgeWindow = clean.slice(-(age + 6));
  const gapLow = Math.min(...surgeWindow.map((c) => c.low).filter((n) => Number.isFinite(n) && n > 0));

  const maxWeightPct = annualVolPct > 100 ? 2.5 : annualVolPct > 75 ? 3.5 : 5;
  const zoneLow = Math.min(sma50, sma200) * 0.99;
  const zoneHigh = Math.max(sma50, sma200) * 1.02;
  const invalidationBelow = Math.min(gapLow * 0.995, zoneLow * 0.96);

  const reasons = [
    `Reclaimed the 50d (${sma50.toFixed(2)}) and 200d (${sma200.toFixed(2)}) ${age === 0 ? "today" : `${age} session${age === 1 ? "" : "s"} ago`}`,
    `+${changePct5d.toFixed(1)}% over 5 sessions`,
    `Relative volume only ${relVolume.toFixed(2)}x the 20d average — unconfirmed`,
    `Annualised volatility ${annualVolPct.toFixed(0)}%`,
  ];

  // Score: thinner tape, fresher reclaim and less extension all look more like
  // the archetype, so they score higher.
  const thinness = Math.min(1, Math.max(0, (rules.maxRelVolume - relVolume) / rules.maxRelVolume));
  const freshness = 1 - age / (rules.reclaimLookbackDays + 1);
  const tightness = Math.min(1, Math.max(0, 1 - extensionPct / rules.maxExtensionPct));
  const surge = Math.min(1, changePct5d / (rules.minSurgePct * 2));
  const score = Math.round((thinness * 35 + freshness * 25 + tightness * 20 + surge * 20));

  const thesis = [
    `Post-reclaim, unconfirmed-volume setup (CRWV archetype).`,
    `${symbol} is +${changePct5d.toFixed(1)}% over 5 sessions and back above its 50d (${sma50.toFixed(2)}) and 200d (${sma200.toFixed(2)}) averages, but on only ${relVolume.toFixed(2)}x average volume — price discovery on thin tape, not institutional accumulation.`,
    `Rule: do not chase. Wait for a pullback into ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)} that holds the reclaimed averages, or a 2-day consolidation.`,
    `Volatility ${annualVolPct.toFixed(0)}% annualised caps any position at ${maxWeightPct}% of NAV, limit orders only.`,
    `Invalidated on a daily close below ${invalidationBelow.toFixed(2)} (surge gap filled).`,
  ].join(" ");

  const timeline = buildTimeline(clean, closes, age);

  return {
    match: {
      symbol,
      name: opts.name ?? null,
      price,
      sma50,
      sma200,
      rsi14,
      relVolume,
      annualVolPct,
      changePct1d,
      changePct5d,
      reclaimAgeDays: age,
      score,
      reasons,
      zoneLow,
      zoneHigh,
      invalidationBelow,
      maxWeightPct,
      thesis,
      timeline,
    },
    rejected: null,
  };
}
