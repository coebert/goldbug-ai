// Event study for director / PDMR dealings.
//
// Question this answers: after an insider *sells* (or buys) a meaningful slug
// of stock, what did the share price actually do over the next days, weeks and
// quarter — both raw and net of the local index? The engine already nudges
// sentiment on a detected disposal; this module is the evidence layer that says
// whether such a nudge deserves to exist and how large it should be.
//
// Pure: no network, no database. Prices and events are injected.

export type InsiderTx = {
  symbol: string;
  /** Trade / filing date, ISO YYYY-MM-DD. */
  date: string;
  person: string | null;
  role: string | null;
  shares: number | null;
  /** Consideration in the quote currency of the symbol (GBX for LSE). */
  value: number | null;
  text: string | null;
};

export type Action = "buy" | "sell" | "other";
export type Flavour = "discretionary" | "mechanical" | "unknown";

export type Candlelike = { date: string; close: number };

export const DEFAULT_HORIZONS = [1, 5, 10, 21, 63] as const;

/**
 * Yahoo's `transactionText` is free-form but highly templated. Anything that is
 * an award, grant, option exercise, conversion or plain ownership statement is
 * mechanical — it carries almost no view. Open-market buys and sells are the
 * discretionary decisions worth studying.
 */
export function classifyTransactionText(text: string | null | undefined): {
  action: Action;
  flavour: Flavour;
} {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return { action: "other", flavour: "unknown" };

  const mechanical =
    /(award|grant|conversion|convert|exercis|vest|option|statement of ownership|gift|inherit|plan\b|scrip|dividend reinvest)/.test(
      t,
    );

  const isSell = /(sold|sale|sell|dispos)/.test(t);
  const isBuy = /(bought|purchase|buy|acquisition|acquired)/.test(t);

  const action: Action = isSell && !isBuy ? "sell" : isBuy && !isSell ? "buy" : "other";
  if (action === "other") return { action, flavour: mechanical ? "mechanical" : "unknown" };

  // "Sale at price X per share" with no award/exercise language is an
  // open-market discretionary trade.
  const priced = /at price/.test(t);
  const flavour: Flavour = mechanical ? "mechanical" : priced ? "discretionary" : "unknown";
  return { action, flavour };
}

export type ClassifiedEvent = InsiderTx & {
  action: Action;
  flavour: Flavour;
  /** True when the person is a board-level decision maker (CEO/CFO/Chair). */
  senior: boolean;
};

const SENIOR = /(chief exec|ceo|chief financ|cfo|chair|president|chief operating|coo)/i;

export function classifyEvents(txs: readonly InsiderTx[]): ClassifiedEvent[] {
  return txs.map((t) => {
    const { action, flavour } = classifyTransactionText(t.text);
    return { ...t, action, flavour, senior: SENIOR.test(t.role ?? "") };
  });
}

/** Index of trading-day position by date, for O(1) window slicing. */
function indexOf(series: readonly Candlelike[]): Map<string, number> {
  const m = new Map<string, number>();
  series.forEach((c, i) => m.set(c.date, i));
  return m;
}

/** First trading bar on or after `date`; -1 when the event post-dates the tape. */
export function barOnOrAfter(series: readonly Candlelike[], date: string): number {
  let lo = 0;
  let hi = series.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = series[mid];
    if (!c) break;
    if (c.date >= date) {
      hit = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return hit;
}

export type EventOutcome = {
  symbol: string;
  date: string;
  person: string | null;
  role: string | null;
  senior: boolean;
  action: Action;
  flavour: Flavour;
  value: number | null;
  entry_price: number;
  /** Raw forward return in % by horizon (trading days). */
  ret: Record<number, number | null>;
  /** Return in % minus the benchmark's return over the same window. */
  abn: Record<number, number | null>;
};

export type BuildOptions = {
  horizons?: readonly number[];
  /** Ignore dealings below this consideration (quote currency units). */
  minValue?: number;
  /** Drop events whose full longest window is not yet on the tape. */
  requireComplete?: boolean;
};

/**
 * Align each event onto its symbol's tape and measure forward returns. The
 * event bar is the first session on or after the reported date, so a filing
 * after the close is not credited with that day's move.
 */
export function buildEventOutcomes(
  events: readonly ClassifiedEvent[],
  prices: ReadonlyMap<string, readonly Candlelike[]>,
  benchmarks: ReadonlyMap<string, readonly Candlelike[]>,
  benchmarkFor: (symbol: string) => string | null,
  opts: BuildOptions = {},
): EventOutcome[] {
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const minValue = opts.minValue ?? 0;
  const maxH = Math.max(...horizons);
  const benchIdx = new Map<string, Map<string, number>>();

  const out: EventOutcome[] = [];
  for (const e of events) {
    if (minValue > 0 && (e.value == null || Math.abs(e.value) < minValue)) continue;
    const series = prices.get(e.symbol);
    if (!series || series.length === 0) continue;
    const i = barOnOrAfter(series, e.date);
    if (i < 0) continue;
    const entry = series[i];
    if (!entry || !Number.isFinite(entry.close) || entry.close <= 0) continue;

    if (opts.requireComplete && i + maxH >= series.length) continue;

    const bSym = benchmarkFor(e.symbol);
    const bSeries = bSym ? benchmarks.get(bSym) : undefined;
    let bIdx = -1;
    if (bSeries && bSeries.length > 0) {
      if (bSym && !benchIdx.has(bSym)) benchIdx.set(bSym, indexOf(bSeries));
      bIdx = barOnOrAfter(bSeries, entry.date);
    }

    const ret: Record<number, number | null> = {};
    const abn: Record<number, number | null> = {};
    for (const h of horizons) {
      const exit = series[i + h];
      const r = exit ? ((exit.close - entry.close) / entry.close) * 100 : null;
      ret[h] = r == null ? null : Number(r.toFixed(3));

      let a: number | null = null;
      if (r != null && bSeries && bIdx >= 0) {
        const be = bSeries[bIdx];
        const bx = bSeries[bIdx + h];
        if (be && bx && be.close > 0) {
          a = r - ((bx.close - be.close) / be.close) * 100;
        }
      }
      abn[h] = a == null ? null : Number(a.toFixed(3));
    }

    out.push({
      symbol: e.symbol,
      date: entry.date,
      person: e.person,
      role: e.role,
      senior: e.senior,
      action: e.action,
      flavour: e.flavour,
      value: e.value,
      entry_price: entry.close,
      ret,
      abn,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------------------------------------------------------------- statistics

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/** Deterministic PRNG so a rerun of the same study reports the same interval. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Percentile bootstrap CI for the mean. Small samples are the norm here. */
export function bootstrapMeanCI(
  xs: readonly number[],
  { iterations = 1500, alpha = 0.05, seed = 12345 } = {},
): { lo: number; hi: number } {
  if (xs.length < 3) return { lo: NaN, hi: NaN };
  const rand = rng(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let k = 0; k < xs.length; k++) sum += xs[Math.floor(rand() * xs.length)] as number;
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) =>
    means[Math.min(means.length - 1, Math.max(0, Math.round(q * (means.length - 1))))] as number;
  return { lo: Number(at(alpha / 2).toFixed(3)), hi: Number(at(1 - alpha / 2).toFixed(3)) };
}

export type HorizonStats = {
  horizon: number;
  n: number;
  mean_ret: number;
  median_ret: number;
  mean_abn: number;
  median_abn: number;
  /** Share of events with a positive abnormal return. */
  hit_rate: number;
  ci_lo: number;
  ci_hi: number;
  /** True when the abnormal-return CI excludes zero. */
  significant: boolean;
};

export function horizonStats(
  outcomes: readonly EventOutcome[],
  horizon: number,
  seed = 12345,
): HorizonStats {
  const rets = outcomes.map((o) => o.ret[horizon]).filter((v): v is number => v != null);
  const abns = outcomes.map((o) => o.abn[horizon]).filter((v): v is number => v != null);
  const basis = abns.length > 0 ? abns : rets;
  const ci = bootstrapMeanCI(basis, { seed });
  return {
    horizon,
    n: rets.length,
    mean_ret: Number(mean(rets).toFixed(3)),
    median_ret: Number(median(rets).toFixed(3)),
    mean_abn: Number(mean(abns).toFixed(3)),
    median_abn: Number(median(abns).toFixed(3)),
    hit_rate: basis.length === 0 ? 0 : Number((basis.filter((v) => v > 0).length / basis.length).toFixed(3)),
    ci_lo: ci.lo,
    ci_hi: ci.hi,
    significant: Number.isFinite(ci.lo) && Number.isFinite(ci.hi) && (ci.lo > 0 || ci.hi < 0),
  };
}

export type Bucket = {
  key: string;
  label: string;
  n: number;
  stats: HorizonStats[];
};

export type StudyBuckets = {
  buckets: Bucket[];
  horizons: number[];
};

const BUCKETS: Array<{ key: string; label: string; pick: (o: EventOutcome) => boolean }> = [
  { key: "sell_discretionary", label: "Open-market sells", pick: (o) => o.action === "sell" && o.flavour === "discretionary" },
  { key: "sell_senior", label: "Sells by CEO/CFO/Chair", pick: (o) => o.action === "sell" && o.senior },
  { key: "sell_mechanical", label: "Mechanical disposals (award/tax/exercise)", pick: (o) => o.action === "sell" && o.flavour !== "discretionary" },
  { key: "buy_discretionary", label: "Open-market buys", pick: (o) => o.action === "buy" && o.flavour === "discretionary" },
  { key: "all_sells", label: "All sells", pick: (o) => o.action === "sell" },
  { key: "all_buys", label: "All buys", pick: (o) => o.action === "buy" },
];

export function summariseStudy(
  outcomes: readonly EventOutcome[],
  horizons: readonly number[] = DEFAULT_HORIZONS,
): StudyBuckets {
  const buckets: Bucket[] = [];
  for (const b of BUCKETS) {
    const subset = outcomes.filter(b.pick);
    if (subset.length === 0) continue;
    buckets.push({
      key: b.key,
      label: b.label,
      n: subset.length,
      stats: horizons.map((h) => horizonStats(subset, h)),
    });
  }
  return { buckets, horizons: [...horizons] };
}

/**
 * Plain-English read of the study, and — crucially — the nudge magnitude the
 * evidence supports. `null` means "no evidence, leave the engine alone".
 */
export function studyVerdict(
  study: StudyBuckets,
  focusHorizon = 21,
): { verdict: string; supported_nudge: number | null; detail: string } {
  const sell = study.buckets.find((b) => b.key === "sell_discretionary");
  const mech = study.buckets.find((b) => b.key === "sell_mechanical");
  const s = sell?.stats.find((x) => x.horizon === focusHorizon);
  const m = mech?.stats.find((x) => x.horizon === focusHorizon);

  if (!s || s.n < 8) {
    return {
      verdict: "insufficient_evidence",
      supported_nudge: null,
      detail: `Only ${s?.n ?? 0} open-market sells with a complete ${focusHorizon}-day window — too few to conclude anything.`,
    };
  }

  const drift = s.mean_abn;
  const mechDrift = m?.mean_abn ?? 0;
  const separated = Math.abs(drift - mechDrift) > 0.75;

  if (s.significant && drift < 0) {
    // Map the measured drag onto a bounded nudge: 1% of abnormal drag over the
    // window is worth about 0.05 of sentiment, capped at the module's -0.15.
    const nudge = Math.max(-0.15, Number((drift * 0.05).toFixed(3)));
    return {
      verdict: "sells_predict_underperformance",
      supported_nudge: nudge,
      detail: `Open-market sells underperformed the index by ${drift.toFixed(2)}% over ${focusHorizon} sessions (95% CI ${s.ci_lo}..${s.ci_hi}, n=${s.n})${
        separated ? `, versus ${mechDrift.toFixed(2)}% for mechanical disposals` : ""
      }.`,
    };
  }
  if (s.significant && drift > 0) {
    return {
      verdict: "sells_not_bearish",
      supported_nudge: 0,
      detail: `Open-market sells were followed by ${drift.toFixed(2)}% outperformance over ${focusHorizon} sessions (95% CI ${s.ci_lo}..${s.ci_hi}, n=${s.n}) — a bearish nudge is not supported.`,
    };
  }
  return {
    verdict: "not_supported",
    supported_nudge: 0,
    detail: `Open-market sells drifted ${drift.toFixed(2)}% versus the index over ${focusHorizon} sessions but the 95% CI (${s.ci_lo}..${s.ci_hi}, n=${s.n}) straddles zero — no reliable edge.`,
  };
}
