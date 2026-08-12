// Replay of the bounded insider-dealing nudge against a baseline strategy.
//
// The event study answers "what did the price do after a director dealt?".
// This module answers the operational question: if the engine had been running
// its trend strategy over the last 1-2 years, would applying the bounded
// insider nudge to the symbol score have made or lost money versus running the
// exact same strategy with the nudge switched off?
//
// Both arms trade the identical universe, tape, selection rule and cost model.
// The ONLY difference is `score + activeNudge` in the nudge arm, where the
// nudge comes from the production scorer (`insiderScoreBreakdown`) and decays
// with the same bounded magnitude the live engine uses.
//
// Pure: no network, no database. Prices and events are injected.

import {
  insiderScoreBreakdown,
  INSIDER_NUDGE_FLOOR,
  INSIDER_NUDGE_CEILING,
  type InsiderDirection,
  type InsiderFlavour,
} from "@/lib/insider-dealings";
import {
  riskSizingFor,
  realisedVol,
  targetWeights,
  stepWeights,
  tailRisk,
  type RiskSizing,
} from "./replay-risk-sizing";

export type Candlelike = { date: string; close: number };

export type ReplayEvent = {
  symbol: string;
  /** Filing / trade date, ISO YYYY-MM-DD. */
  date: string;
  direction: InsiderDirection;
  flavour: InsiderFlavour;
  /** Normalised role token ("CEO", "CFO", "Chair", "COO") or null. */
  role: string | null;
  /** Consideration in quote-currency units. */
  value: number | null;
};

export type ReplayParams = {
  /** Score at or above which a symbol is eligible to be held (0..1). */
  entryThreshold: number;
  /** Maximum simultaneous equal-weighted positions. */
  maxPositions: number;
  /** Days a filing keeps influencing the score. */
  activeDays: number;
  /** Half-life of the decay inside the active window. */
  halfLifeDays: number;
  /** Round-trip friction charged on weight changes, bps of traded notional. */
  costBps: number;
  /** Multiplier on the production nudge; 1 = live behaviour, 0 = baseline. */
  nudgeScale: number;
  /**
   * Risk dial (1..5). Both arms size positions through the same preset the live
   * AI uses, so drawdown/VaR comparisons reflect real deployment, not equal
   * weights.
   */
  riskLevel: number;
};

export const DEFAULT_REPLAY_PARAMS: ReplayParams = {
  entryThreshold: 0.55,
  maxPositions: 6,
  activeDays: 14,
  halfLifeDays: 7,
  costBps: 25,
  nudgeScale: 1,
  riskLevel: 3,
};


const SENIOR_ROLE = /(chief exec|ceo|founder)/i;
const CFO_ROLE = /(chief financ|cfo|finance director)/i;
const CHAIR_ROLE = /(chair|president)/i;
const COO_ROLE = /(chief operating|coo|operations director)/i;

/** Map a free-form filing role onto the tokens the production scorer expects. */
export function normaliseRole(role: string | null | undefined): string | null {
  const r = (role ?? "").trim();
  if (!r) return null;
  if (SENIOR_ROLE.test(r)) return "CEO";
  if (CFO_ROLE.test(r)) return "CFO";
  if (CHAIR_ROLE.test(r)) return "Chair";
  if (COO_ROLE.test(r)) return "COO";
  return null;
}

/** The production nudge for one filing — same arithmetic the live engine runs. */
export function eventNudge(e: ReplayEvent): number {
  return insiderScoreBreakdown({
    direction: e.direction,
    flavour: e.flavour,
    role: normaliseRole(e.role),
    value: e.value,
  }).sentiment_nudge;
}

/**
 * Net nudge for one symbol on one day: every filing inside the active window,
 * decayed by age, summed, then clamped to the same bounds as live so a cluster
 * of filings cannot compound into a large signal.
 */
export function activeNudge(
  events: readonly ReplayEvent[],
  ageDaysOf: (eventDate: string) => number,
  p: Pick<ReplayParams, "activeDays" | "halfLifeDays">,
): number {
  let sum = 0;
  for (const e of events) {
    const age = ageDaysOf(e.date);
    if (age < 0 || age > p.activeDays) continue;
    const decay = Math.pow(0.5, age / Math.max(0.5, p.halfLifeDays));
    sum += eventNudge(e) * decay;
  }
  return Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, sum));
}

// ------------------------------------------------------------------ scoring

function sma(closes: readonly number[], end: number, n: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i] as number;
  return s / n;
}

/**
 * Baseline trend score in 0..1: how far the fast average sits above the slow
 * one, saturating at +/-5%. Deliberately plain — the point of the experiment is
 * the nudge, not the alpha model.
 */
export function trendScore(closes: readonly number[], i: number): number | null {
  const fast = sma(closes, i, 20);
  const slow = sma(closes, i, 50);
  if (fast == null || slow == null || slow <= 0) return null;
  const spread = fast / slow - 1;
  return Math.max(0, Math.min(1, 0.5 + spread * 10));
}

// ------------------------------------------------------------------- engine

export type ArmDay = {
  date: string;
  equity: number;
  /** Friction charged that day, in equity units. */
  cost: number;
  positions: number;
};

export type ArmResult = {
  label: string;
  curve: ArmDay[];
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  /** Sum of friction charged, in equity units. */
  totalCost: number;
  /** Count of weight changes big enough to be a ticket. */
  trades: number;
  avgPositions: number;
  /** Average deployed gross exposure as a fraction of equity. */
  avgGross: number;
  /** Historical 1-day 95% VaR / expected shortfall, positive % losses. */
  var95Pct: number;
  cvar95Pct: number;
  volAnnPct: number;
};


export type NudgeAttribution = {
  /** Symbol-days where the nudge kept an otherwise-eligible name out. */
  suppressedDays: number;
  /** Distinct symbols suppressed at least once. */
  suppressedSymbols: number;
  /** Symbol-days where a positive nudge pulled a name in. */
  promotedDays: number;
  /**
   * Mean forward 21-day return of names on the day they were suppressed.
   * Negative = the nudge dodged weakness (the nudge earned its keep).
   */
  suppressedForward21Pct: number | null;
  promotedForward21Pct: number | null;
  eventsInWindow: number;
  sellEvents: number;
  buyEvents: number;
};

export type ReplayVerdict = "helps" | "neutral" | "hurts";

export type NudgeReplayResult = {
  from: string;
  to: string;
  symbols: string[];
  tradingDays: number;
  params: ReplayParams;
  baseline: ArmResult;
  nudged: ArmResult;
  delta: {
    returnPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    costPct: number;
    trades: number;
    /** Change in 1-day 95% VaR (negative = the nudge arm risks less). */
    var95Pct: number;
    cvar95Pct: number;
  };
  confidence: {
    iterations: number;
    blockDays: number;
    /** 95% interval on the return delta in percentage points. */
    returnDeltaLo: number;
    returnDeltaHi: number;
    probPositive: number;
  };
  attribution: NudgeAttribution;
  /** The live risk-dial preset both arms sized through. */
  sizing: RiskSizing;
  verdict: ReplayVerdict;
  summary: string;
};

export type ReplayInput = {
  prices: ReadonlyMap<string, readonly Candlelike[]>;
  events: readonly ReplayEvent[];
  params?: Partial<ReplayParams>;
  startingEquity?: number;
  iterations?: number;
  seed?: number;
};

type Prepared = {
  symbol: string;
  closes: number[];
  index: Map<string, number>;
  events: ReplayEvent[];
};

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

function drawdownPct(equity: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, (v - peak) / peak);
  }
  return Number((worst * 100).toFixed(3));
}

function sharpeOf(rets: readonly number[]): number {
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? Number(((m / sd) * Math.sqrt(252)).toFixed(2)) : 0;
}

/** Mulberry32 — deterministic, so a rerun reports the same interval. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))));
  return sorted[idx] as number;
}

/**
 * Run both arms bar-by-bar over the union of trading dates. Weights are formed
 * on the close of day t and earn day t+1's return, so no look-ahead.
 */
export function runNudgeReplay(input: ReplayInput): NudgeReplayResult {
  const params: ReplayParams = { ...DEFAULT_REPLAY_PARAMS, ...(input.params ?? {}) };
  const sizing = riskSizingFor(params.riskLevel);
  const startEquity = input.startingEquity && input.startingEquity > 0 ? input.startingEquity : 10_000;

  const prepared: Prepared[] = [];
  for (const [symbol, series] of input.prices) {
    if (!series || series.length < 60) continue;
    const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
    const index = new Map<string, number>();
    sorted.forEach((c, i) => index.set(c.date, i));
    prepared.push({
      symbol,
      closes: sorted.map((c) => c.close),
      index,
      events: input.events.filter((e) => e.symbol === symbol),
    });
  }

  const allDates = [...new Set(prepared.flatMap((p) => [...p.index.keys()]))].sort();
  const symbols = prepared.map((p) => p.symbol);

  const emptyArm = (label: string): ArmResult => ({
    label,
    curve: [],
    finalEquity: startEquity,
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    totalCost: 0,
    trades: 0,
    avgPositions: 0,
    avgGross: 0,
    var95Pct: 0,
    cvar95Pct: 0,
    volAnnPct: 0,
  });

  const attribution: NudgeAttribution = {
    suppressedDays: 0,
    suppressedSymbols: 0,
    promotedDays: 0,
    suppressedForward21Pct: null,
    promotedForward21Pct: null,
    eventsInWindow: input.events.length,
    sellEvents: input.events.filter((e) => e.direction === "sell").length,
    buyEvents: input.events.filter((e) => e.direction === "buy").length,
  };

  if (prepared.length === 0 || allDates.length < 60) {
    return {
      from: allDates[0] ?? "",
      to: allDates[allDates.length - 1] ?? "",
      symbols,
      tradingDays: allDates.length,
      params,
      baseline: emptyArm("Baseline (no nudge)"),
      nudged: emptyArm("With insider nudge"),
      delta: { returnPct: 0, maxDrawdownPct: 0, sharpe: 0, costPct: 0, trades: 0, var95Pct: 0, cvar95Pct: 0 },
      confidence: { iterations: 0, blockDays: 0, returnDeltaLo: 0, returnDeltaHi: 0, probPositive: 0 },
      attribution,
      sizing,
      verdict: "neutral",
      summary: "Not enough tape to replay — load a longer history for this universe.",
    };
  }

  type ArmState = {
    weights: Map<string, number>;
    equity: number;
    cost: number;
    trades: number;
    positions: number[];
    gross: number[];
  };
  const mk = (): ArmState => ({
    weights: new Map(),
    equity: startEquity,
    cost: 0,
    trades: 0,
    positions: [],
    gross: [],
  });
  const base = mk();
  const nud = mk();
  const baseCurve: ArmDay[] = [];
  const nudCurve: ArmDay[] = [];
  const baseRets: number[] = [];
  const nudRets: number[] = [];

  const suppressedSyms = new Set<string>();
  const suppressedFwd: number[] = [];
  const promotedFwd: number[] = [];

  const forward21 = (p: Prepared, i: number): number | null => {
    const a = p.closes[i];
    const b = p.closes[i + 21];
    return a && b && a > 0 ? ((b - a) / a) * 100 : null;
  };

  /**
   * Selection picks the names; the risk dial decides how much of the book they
   * get. Sizing runs through the same preset-driven primitives as the live AI
   * (per-symbol cap, vol targeting, size multiplier, gross ceiling) and the
   * move toward target is paced by the dial's buy/sell aggressiveness.
   */
  const select = (
    state: ArmState,
    scores: Array<{ symbol: string; score: number; vol: number | null }>,
  ): Map<string, number> => {
    const eligible = scores
      .filter((s) => s.score >= params.entryThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, params.maxPositions);
    const desired = targetWeights(eligible, sizing);
    return stepWeights(state.weights, desired, sizing);
  };

  const applyDay = (
    state: ArmState,
    target: Map<string, number>,
    dayReturn: (symbol: string) => number | null,
  ) => {
    // Friction on the weight change, then the portfolio earns the next bar.
    let turnover = 0;
    const keys = new Set([...state.weights.keys(), ...target.keys()]);
    for (const k of keys) {
      const d = Math.abs((target.get(k) ?? 0) - (state.weights.get(k) ?? 0));
      if (d > 1e-9) turnover += d;
      if (d > 0.01) state.trades += 1;
    }
    const cost = state.equity * turnover * (params.costBps / 10_000);
    state.equity -= cost;
    state.cost += cost;

    let port = 0;
    let gross = 0;
    for (const [sym, w] of target) {
      gross += w;
      const r = dayReturn(sym);
      if (r != null) port += w * r;
    }
    state.equity *= 1 + port;
    state.weights = target;
    state.positions.push(target.size);
    state.gross.push(gross);
    return { cost, port };
  };


  for (let d = 0; d < allDates.length - 1; d++) {
    const date = allDates[d] as string;
    const next = allDates[d + 1] as string;

    const baseScores: Array<{ symbol: string; score: number; vol: number | null }> = [];
    const nudScores: Array<{ symbol: string; score: number; vol: number | null }> = [];

    for (const p of prepared) {
      const i = p.index.get(date);
      if (i == null) continue;
      const s = trendScore(p.closes, i);
      if (s == null) continue;
      const vol = realisedVol(p.closes, i, 20);
      baseScores.push({ symbol: p.symbol, score: s, vol });

      const n = params.nudgeScale === 0
        ? 0
        : activeNudge(p.events, (ed) => dayDiff(date, ed), params) * params.nudgeScale;
      const adj = Math.max(0, Math.min(1, s + n));
      nudScores.push({ symbol: p.symbol, score: adj, vol });


      if (n < 0 && s >= params.entryThreshold && adj < params.entryThreshold) {
        attribution.suppressedDays += 1;
        suppressedSyms.add(p.symbol);
        const f = forward21(p, i);
        if (f != null) suppressedFwd.push(f);
      } else if (n > 0 && s < params.entryThreshold && adj >= params.entryThreshold) {
        attribution.promotedDays += 1;
        const f = forward21(p, i);
        if (f != null) promotedFwd.push(f);
      }
    }

    const dayReturn = (symbol: string): number | null => {
      const p = prepared.find((x) => x.symbol === symbol);
      if (!p) return null;
      const i = p.index.get(date);
      const j = p.index.get(next);
      if (i == null || j == null) return null;
      const a = p.closes[i];
      const b = p.closes[j];
      return a && b && a > 0 ? b / a - 1 : null;
    };

    const beforeBase = base.equity;
    const beforeNud = nud.equity;
    const rb = applyDay(base, select(base, baseScores), dayReturn);
    const rn = applyDay(nud, select(nud, nudScores), dayReturn);

    baseCurve.push({ date: next, equity: Number(base.equity.toFixed(2)), cost: Number(rb.cost.toFixed(4)), positions: base.weights.size });
    nudCurve.push({ date: next, equity: Number(nud.equity.toFixed(2)), cost: Number(rn.cost.toFixed(4)), positions: nud.weights.size });
    baseRets.push(beforeBase > 0 ? base.equity / beforeBase - 1 : 0);
    nudRets.push(beforeNud > 0 ? nud.equity / beforeNud - 1 : 0);
  }

  const arm = (label: string, state: ArmState, curve: ArmDay[], rets: number[]): ArmResult => {
    const t = tailRisk(rets);
    return {
      label,
      curve,
      finalEquity: Number(state.equity.toFixed(2)),
      totalReturnPct: Number(((state.equity / startEquity - 1) * 100).toFixed(3)),
      maxDrawdownPct: drawdownPct(curve.map((c) => c.equity)),
      sharpe: sharpeOf(rets),
      totalCost: Number(state.cost.toFixed(2)),
      trades: state.trades,
      avgPositions: Number(
        (state.positions.reduce((a, b) => a + b, 0) / Math.max(1, state.positions.length)).toFixed(2),
      ),
      avgGross: Number(
        (state.gross.reduce((a, b) => a + b, 0) / Math.max(1, state.gross.length)).toFixed(4),
      ),
      var95Pct: t.var95Pct,
      cvar95Pct: t.cvar95Pct,
      volAnnPct: t.volAnnPct,
    };
  };


  const baseline = arm("Baseline (no nudge)", base, baseCurve, baseRets);
  const nudged = arm("With insider nudge", nud, nudCurve, nudRets);

  // Paired moving-block bootstrap on the daily return difference.
  const n = Math.min(baseRets.length, nudRets.length);
  const iterations = Math.max(200, Math.min(4000, input.iterations ?? 1000));
  const blockDays = Math.max(1, Math.min(n || 1, Math.round(Math.cbrt(Math.max(n, 1))) + 4));
  const rng = makeRng(input.seed ?? 20260812);
  const samples: number[] = [];
  if (n >= 30) {
    const blocks = Math.ceil(n / blockDays);
    for (let it = 0; it < iterations; it++) {
      let bAcc = 1;
      let nAcc = 1;
      for (let b = 0; b < blocks; b++) {
        const start = Math.floor(rng() * Math.max(1, n - blockDays));
        for (let k = 0; k < blockDays; k++) {
          const idx = start + k;
          if (idx >= n) break;
          bAcc *= 1 + (baseRets[idx] as number);
          nAcc *= 1 + (nudRets[idx] as number);
        }
      }
      samples.push((nAcc - bAcc) * 100);
    }
  }
  samples.sort((a, b) => a - b);
  const lo = Number(quantile(samples, 0.025).toFixed(3));
  const hi = Number(quantile(samples, 0.975).toFixed(3));
  const probPositive = samples.length
    ? Number((samples.filter((s) => s > 0).length / samples.length).toFixed(3))
    : 0;

  const delta = {
    returnPct: Number((nudged.totalReturnPct - baseline.totalReturnPct).toFixed(3)),
    maxDrawdownPct: Number((nudged.maxDrawdownPct - baseline.maxDrawdownPct).toFixed(3)),
    sharpe: Number((nudged.sharpe - baseline.sharpe).toFixed(2)),
    costPct: Number((((nudged.totalCost - baseline.totalCost) / startEquity) * 100).toFixed(3)),
    trades: nudged.trades - baseline.trades,
    var95Pct: Number((nudged.var95Pct - baseline.var95Pct).toFixed(3)),
    cvar95Pct: Number((nudged.cvar95Pct - baseline.cvar95Pct).toFixed(3)),
  };

  const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);
  attribution.suppressedSymbols = suppressedSyms.size;
  attribution.suppressedForward21Pct = mean(suppressedFwd);
  attribution.promotedForward21Pct = mean(promotedFwd);

  const significant = samples.length > 0 && (lo > 0 || hi < 0);
  const ddBetter = delta.maxDrawdownPct >= -0.001 ? delta.maxDrawdownPct <= 0.5 : true;
  let verdict: ReplayVerdict = "neutral";
  if (significant && delta.returnPct > 0 && ddBetter) verdict = "helps";
  else if (significant && delta.returnPct < 0) verdict = "hurts";
  else if (!significant && Math.abs(delta.returnPct) < 0.5) verdict = "neutral";
  else verdict = delta.returnPct < 0 ? "hurts" : "neutral";

  const summary =
    samples.length === 0
      ? "Too few bars for a confidence band — the replay result is a single path."
      : verdict === "helps"
        ? `The bounded nudge added ${delta.returnPct.toFixed(2)}pp over ${baseline.totalReturnPct.toFixed(2)}% baseline (95% CI ${lo}..${hi}pp), with drawdown ${delta.maxDrawdownPct.toFixed(2)}pp different.`
        : verdict === "hurts"
          ? `The bounded nudge cost ${Math.abs(delta.returnPct).toFixed(2)}pp versus baseline (95% CI ${lo}..${hi}pp) — on this tape it filtered out names that went on to work.`
          : `No measurable edge: return delta ${delta.returnPct.toFixed(2)}pp with a 95% CI of ${lo}..${hi}pp straddling zero. The nudge is bounded tightly enough to be close to harmless either way.`;

  const sized = ` Both arms sized through the ${sizing.name} dial (level ${sizing.level}, ${(sizing.perSymbolCap * 100).toFixed(0)}% per-symbol cap, ×${sizing.aggressiveness.sizeMult} size): 95% 1-day VaR ${baseline.var95Pct.toFixed(2)}% baseline vs ${nudged.var95Pct.toFixed(2)}% nudged.`;

  return {
    from: allDates[0] as string,
    to: allDates[allDates.length - 1] as string,
    symbols,
    tradingDays: allDates.length,
    params,
    baseline,
    nudged,
    delta,
    confidence: { iterations: samples.length ? iterations : 0, blockDays, returnDeltaLo: lo, returnDeltaHi: hi, probPositive },
    attribution,
    sizing,
    verdict,
    summary: summary + sized,
  };
}
