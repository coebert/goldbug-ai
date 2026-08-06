// Turnover attribution: which parameters actually drive trading frequency and
// re-entry behaviour once realistic costs are paid.
//
// The optimiser ranks candidates on net CAGR; this module answers the adjacent
// question — *where does the churn come from?* It decomposes turnover across
// the search axes (one-way variance share + level means), measures the cost the
// tape charges per extra trade, and profiles re-entry gaps from the trade log.
//
// Pure functions only: no IO, no clock, no randomness.

export type ParamValue = number | boolean;
export type ParamSet = Record<string, ParamValue>;

/** Minimal view of an evaluated candidate — matches OptimizerResult. */
export type TurnoverRow = {
  params: ParamSet;
  metrics: {
    tradesPerYear: number;
    cagrPct: number;
    feeDragPct: number;
    maxDrawdownPct: number;
  };
  check?: { feasible: boolean; disqualified: boolean };
};

export type TurnoverLevel = {
  value: ParamValue;
  n: number;
  meanTradesPerYear: number;
  meanFeeDragPct: number;
  meanCagrPct: number;
  feasible: number;
};

export type TurnoverAxisAttribution = {
  key: string;
  levels: TurnoverLevel[];
  /** Turnover spread (trades/yr) between the busiest and quietest level. */
  spreadPerYear: number;
  /** Level producing the least churn. */
  quietestValue: ParamValue | null;
  busiestValue: ParamValue | null;
  /**
   * Share of total turnover variance explained by this axis (one-way eta²,
   * 0..1). This is the attribution weight: high eta² = a real driver.
   */
  varianceShare: number;
  /**
   * Sign of the relationship for numeric axes: +1 = raising the parameter
   * raises turnover, -1 = raising it damps turnover, 0 = flat / non-numeric.
   */
  direction: 1 | 0 | -1;
  /** Extra trades/yr per +1 unit of a numeric axis (OLS slope). */
  slopePerUnit: number;
};

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const numeric = (v: ParamValue) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

/** OLS slope of y on x; 0 when x has no spread. */
export function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function usable(rows: readonly TurnoverRow[], key: string): TurnoverRow[] {
  return rows.filter((r) => !r.check?.disqualified && key in r.params);
}

/**
 * Attribute turnover to one axis: level means plus the share of total turnover
 * variance the axis explains (between-group / total sum of squares).
 */
export function turnoverAxisAttribution(
  rows: readonly TurnoverRow[],
  key: string,
): TurnoverAxisAttribution {
  const pool = usable(rows, key);
  const empty: TurnoverAxisAttribution = {
    key,
    levels: [],
    spreadPerYear: 0,
    quietestValue: null,
    busiestValue: null,
    varianceShare: 0,
    direction: 0,
    slopePerUnit: 0,
  };
  if (pool.length === 0) return empty;

  const byValue = new Map<ParamValue, TurnoverRow[]>();
  for (const r of pool) {
    const v = r.params[key]!;
    byValue.set(v, [...(byValue.get(v) ?? []), r]);
  }

  const levels: TurnoverLevel[] = [...byValue.entries()]
    .map(([value, rs]) => ({
      value,
      n: rs.length,
      meanTradesPerYear: mean(rs.map((r) => r.metrics.tradesPerYear)),
      meanFeeDragPct: mean(rs.map((r) => r.metrics.feeDragPct)),
      meanCagrPct: mean(rs.map((r) => r.metrics.cagrPct)),
      feasible: rs.filter((r) => r.check?.feasible).length,
    }))
    .sort((a, b) => numeric(a.value) - numeric(b.value));

  const grand = mean(pool.map((r) => r.metrics.tradesPerYear));
  const ssTotal = pool.reduce(
    (a, r) => a + (r.metrics.tradesPerYear - grand) ** 2,
    0,
  );
  const ssBetween = levels.reduce(
    (a, l) => a + l.n * (l.meanTradesPerYear - grand) ** 2,
    0,
  );
  const varianceShare = ssTotal === 0 ? 0 : Math.min(1, ssBetween / ssTotal);

  const busiest = levels.reduce((a, b) =>
    b.meanTradesPerYear > a.meanTradesPerYear ? b : a,
  );
  const quietest = levels.reduce((a, b) =>
    b.meanTradesPerYear < a.meanTradesPerYear ? b : a,
  );

  const s = slope(
    pool.map((r) => numeric(r.params[key]!)),
    pool.map((r) => r.metrics.tradesPerYear),
  );
  const direction: 1 | 0 | -1 =
    Math.abs(s) < 1e-9 || levels.length < 2 ? 0 : s > 0 ? 1 : -1;

  return {
    key,
    levels,
    spreadPerYear: busiest.meanTradesPerYear - quietest.meanTradesPerYear,
    quietestValue: quietest.value,
    busiestValue: busiest.value,
    varianceShare,
    direction,
    slopePerUnit: s,
  };
}

/**
 * Rank every axis by how much of the turnover variation it explains. Ties on
 * variance share fall back to raw spread, so a two-level boolean knob with a
 * big effect still sorts above noise.
 */
export function rankTurnoverDrivers(
  rows: readonly TurnoverRow[],
  keys: readonly string[],
): TurnoverAxisAttribution[] {
  return keys
    .map((k) => turnoverAxisAttribution(rows, k))
    .filter((a) => a.levels.length > 0)
    .sort(
      (a, b) =>
        b.varianceShare - a.varianceShare ||
        Math.abs(b.spreadPerYear) - Math.abs(a.spreadPerYear) ||
        a.key.localeCompare(b.key),
    );
}

export type TurnoverCostCurve = {
  /** Net CAGR change (pp) per extra trade/yr. Negative = churn is destroying value. */
  cagrPerTrade: number;
  /** Fee drag (pp of equity) per extra trade/yr. */
  feeDragPerTrade: number;
  /**
   * Turnover level where the fitted net-CAGR line crosses zero. null when the
   * slope is flat or the line never crosses in the sampled range.
   */
  breakevenTradesPerYear: number | null;
  /** Turnover of the best-CAGR candidate actually observed. */
  bestObservedTradesPerYear: number;
  n: number;
};

/**
 * How much the tape charges for churn: regress net CAGR and fee drag on
 * turnover across all non-disqualified candidates.
 */
export function turnoverCostCurve(rows: readonly TurnoverRow[]): TurnoverCostCurve {
  const pool = rows.filter((r) => !r.check?.disqualified);
  const empty: TurnoverCostCurve = {
    cagrPerTrade: 0,
    feeDragPerTrade: 0,
    breakevenTradesPerYear: null,
    bestObservedTradesPerYear: 0,
    n: pool.length,
  };
  if (pool.length < 2) return empty;

  const x = pool.map((r) => r.metrics.tradesPerYear);
  const cagrPerTrade = slope(x, pool.map((r) => r.metrics.cagrPct));
  const feeDragPerTrade = slope(x, pool.map((r) => r.metrics.feeDragPct));

  const mx = mean(x);
  const my = mean(pool.map((r) => r.metrics.cagrPct));
  const intercept = my - cagrPerTrade * mx;
  let breakeven: number | null = null;
  if (Math.abs(cagrPerTrade) > 1e-9) {
    const t = -intercept / cagrPerTrade;
    if (Number.isFinite(t) && t >= 0) breakeven = t;
  }

  const best = pool.reduce((a, b) => (b.metrics.cagrPct > a.metrics.cagrPct ? b : a));
  return {
    cagrPerTrade,
    feeDragPerTrade,
    breakevenTradesPerYear: breakeven,
    bestObservedTradesPerYear: best.metrics.tradesPerYear,
    n: pool.length,
  };
}

// ------------------------------------------------------------- re-entry

export type TradeLeg = {
  date: string;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price?: number;
};

export type ReentryEvent = {
  symbol: string;
  exitDate: string;
  reentryDate: string;
  gapDays: number;
};

export type ReentryProfile = {
  /** Completed flat→re-buy events. */
  events: ReentryEvent[];
  /** Positions that were closed and never re-opened. */
  exitsWithoutReentry: number;
  reentryRate: number;
  meanGapDays: number;
  medianGapDays: number;
  /** Share of re-entries that happened within `fastDays` of the exit. */
  fastReentryShare: number;
  fastDays: number;
  /** Distinct symbols traded, and round trips per symbol. */
  symbols: number;
  roundTripsPerSymbol: number;
};

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Reconstruct re-entry behaviour from a raw trade log: track net quantity per
 * symbol, record the date it goes flat, and pair it with the next buy.
 */
export function reentryProfile(
  trades: readonly TradeLeg[],
  opts: { fastDays?: number } = {},
): ReentryProfile {
  const fastDays = opts.fastDays ?? 5;
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));

  const qty = new Map<string, number>();
  const flatSince = new Map<string, string>();
  const events: ReentryEvent[] = [];
  const roundTrips = new Map<string, number>();
  const symbols = new Set<string>();

  for (const t of sorted) {
    symbols.add(t.symbol);
    const prev = qty.get(t.symbol) ?? 0;
    const delta = t.side === "buy" ? Math.abs(t.quantity) : -Math.abs(t.quantity);
    const next = Math.max(0, prev + delta);

    if (t.side === "buy" && prev <= 0) {
      const since = flatSince.get(t.symbol);
      if (since) {
        events.push({
          symbol: t.symbol,
          exitDate: since,
          reentryDate: t.date,
          gapDays: Math.max(0, dayDiff(since, t.date)),
        });
        flatSince.delete(t.symbol);
      }
    }
    if (t.side === "sell" && prev > 0 && next <= 0) {
      flatSince.set(t.symbol, t.date);
      roundTrips.set(t.symbol, (roundTrips.get(t.symbol) ?? 0) + 1);
    }
    qty.set(t.symbol, next);
  }

  const gaps = events.map((e) => e.gapDays).sort((a, b) => a - b);
  const median =
    gaps.length === 0
      ? 0
      : gaps.length % 2
        ? gaps[(gaps.length - 1) / 2]!
        : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2;
  const exitsWithoutReentry = flatSince.size;
  const totalExits = events.length + exitsWithoutReentry;
  const trips = [...roundTrips.values()].reduce((a, b) => a + b, 0);

  return {
    events,
    exitsWithoutReentry,
    reentryRate: totalExits === 0 ? 0 : events.length / totalExits,
    meanGapDays: mean(gaps),
    medianGapDays: median,
    fastReentryShare:
      events.length === 0
        ? 0
        : events.filter((e) => e.gapDays <= fastDays).length / events.length,
    fastDays,
    symbols: symbols.size,
    roundTripsPerSymbol: symbols.size === 0 ? 0 : trips / symbols.size,
  };
}

export type ReentryLevelSummary = {
  value: ParamValue;
  n: number;
  meanGapDays: number;
  fastReentryShare: number;
  reentryRate: number;
  meanTradesPerYear: number;
};

/**
 * Re-entry behaviour grouped by the levels of one axis — this is what shows
 * whether a cooldown knob is actually being respected in the tape.
 */
export function reentryByLevel(
  rows: readonly TurnoverRow[],
  key: string,
  logFor: (row: TurnoverRow) => readonly TradeLeg[],
  opts: { fastDays?: number } = {},
): ReentryLevelSummary[] {
  const pool = usable(rows, key);
  const byValue = new Map<ParamValue, TurnoverRow[]>();
  for (const r of pool) {
    const v = r.params[key]!;
    byValue.set(v, [...(byValue.get(v) ?? []), r]);
  }
  return [...byValue.entries()]
    .map(([value, rs]) => {
      const profiles = rs.map((r) => reentryProfile(logFor(r), opts));
      const withEvents = profiles.filter((p) => p.events.length > 0);
      return {
        value,
        n: rs.length,
        meanGapDays: mean(withEvents.map((p) => p.meanGapDays)),
        fastReentryShare: mean(withEvents.map((p) => p.fastReentryShare)),
        reentryRate: mean(profiles.map((p) => p.reentryRate)),
        meanTradesPerYear: mean(rs.map((r) => r.metrics.tradesPerYear)),
      };
    })
    .sort((a, b) => numeric(a.value) - numeric(b.value));
}

/** One-line verdict per axis for the console/report. */
export function describeDriver(a: TurnoverAxisAttribution): string {
  const share = `${(a.varianceShare * 100).toFixed(0)}% of turnover variance`;
  if (a.levels.length < 2) return `${a.key}: single level — no signal`;
  if (a.direction === 0) {
    return `${a.key}: ${share}, no monotone direction (quietest at ${String(a.quietestValue)})`;
  }
  const verb = a.direction > 0 ? "raises" : "damps";
  return (
    `${a.key}: ${share}; raising it ${verb} churn ` +
    `(${a.slopePerUnit >= 0 ? "+" : ""}${a.slopePerUnit.toFixed(1)} trades/yr per unit), ` +
    `quietest at ${String(a.quietestValue)} (${a.spreadPerYear.toFixed(0)}/yr spread)`
  );
}
