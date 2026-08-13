// Replay of the bounded policy-maker nudge against an identical baseline.
//
// The engine blends `policySentimentNudge()` into a symbol's news score every
// run. This module answers the operational question that follows: over the last
// 1-2 years, would listening to Powell/Bailey/Lagarde et al. have made or lost
// money versus running the exact same strategy deaf to them?
//
// Both arms trade the same universe, tape, selection rule, risk dial and cost
// model. The ONLY difference is `score + policyNudge` in the nudge arm, where
// the nudge comes from the production scorer (`computePolicySignals` +
// `policySentimentNudge`) evaluated as of that bar's close — no look-ahead:
// only headlines dated on or before the decision day are visible.
//
// Pure: no network, no database. Prices and headlines are injected.

import {
  computePolicySignals,
  policySentimentNudge,
  POLICY_MAX_NUDGE,
  type PolicyRow,
  type PolicySignal,
} from "@/lib/policy-makers";
import { trendScore, type ArmDay, type ArmResult, type Candlelike } from "./insider-nudge-replay";
import {
  riskSizingFor,
  realisedVol,
  targetWeights,
  stepWeights,
  tailRisk,
  type RiskSizing,
} from "./replay-risk-sizing";

export type { Candlelike } from "./insider-nudge-replay";

export type PolicyReplayParams = {
  /** Score at or above which a symbol is eligible to be held (0..1). */
  entryThreshold: number;
  /** Maximum simultaneous positions. */
  maxPositions: number;
  /** Half-life of the policy signal, in hours (48 = live behaviour). */
  halfLifeHours: number;
  /** Round-trip friction charged on weight changes, bps of traded notional. */
  costBps: number;
  /** Multiplier on the production nudge; 1 = live behaviour, 0 = baseline. */
  nudgeScale: number;
  /** Live risk dial (1..5) both arms size through. */
  riskLevel: number;
};

export const DEFAULT_POLICY_REPLAY_PARAMS: PolicyReplayParams = {
  entryThreshold: 0.55,
  maxPositions: 6,
  halfLifeHours: 48,
  costBps: 25,
  nudgeScale: 1,
  riskLevel: 3,
};

/** How much of the tape the policy signal actually reached, and what it did. */
export type PolicyAttribution = {
  /** Headlines classified as tracked policy-maker remarks inside the window. */
  statements: number;
  /** Bars on which at least one symbol carried a non-zero nudge. */
  activeDays: number;
  /** Share of replayed bars with any policy signal at all (0..1). */
  coverage: number;
  /** Distinct symbols the signal ever touched. */
  touchedSymbols: number;
  hawkishDays: number;
  dovishDays: number;
  /** Symbol-days where a hawkish nudge kept an eligible name out. */
  suppressedDays: number;
  suppressedSymbols: number;
  /** Symbol-days where a dovish nudge pulled a name in. */
  promotedDays: number;
  /** Mean forward 21-day return on suppression days (negative = dodged pain). */
  suppressedForward21Pct: number | null;
  promotedForward21Pct: number | null;
  /** Strongest absolute nudge seen, and where. */
  peakNudge: number;
  peakNudgeSymbol: string | null;
  peakNudgeDate: string | null;
};

export type PolicyReplayVerdict = "helps" | "neutral" | "hurts";

export type PolicyNudgeReplayResult = {
  from: string;
  to: string;
  symbols: string[];
  tradingDays: number;
  params: PolicyReplayParams;
  maxNudge: number;
  baseline: ArmResult;
  nudged: ArmResult;
  delta: {
    returnPct: number;
    /** Positive = the nudge arm drew down more (drawdowns are negative %). */
    maxDrawdownPct: number;
    sharpe: number;
    costPct: number;
    trades: number;
    var95Pct: number;
    cvar95Pct: number;
    volAnnPct: number;
  };
  confidence: {
    iterations: number;
    blockDays: number;
    /** 95% interval on the return delta, percentage points. */
    returnDeltaLo: number;
    returnDeltaHi: number;
    /** 95% interval on the max-drawdown delta, percentage points. */
    drawdownDeltaLo: number;
    drawdownDeltaHi: number;
    probPositive: number;
    /** Probability the nudge arm's drawdown is no worse than baseline. */
    probDrawdownBetter: number;
  };
  attribution: PolicyAttribution;
  sizing: RiskSizing;
  verdict: PolicyReplayVerdict;
  summary: string;
};

export type PolicyReplayInput = {
  prices: ReadonlyMap<string, readonly Candlelike[]>;
  /** Headlines across the replay window; classification happens internally. */
  news: readonly PolicyRow[];
  params?: Partial<PolicyReplayParams>;
  startingEquity?: number;
  iterations?: number;
  seed?: number;
};

// ------------------------------------------------------------------ helpers

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

function ddOfReturns(rets: readonly number[]): number {
  let eq = 1;
  let peak = 1;
  let worst = 0;
  for (const r of rets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    worst = Math.min(worst, eq / peak - 1);
  }
  return worst * 100;
}

const DAY = 86_400_000;

/**
 * Policy signals as of a given bar, using only headlines dated on or before it.
 * The 7-day relevance window lives inside `computePolicySignals`, so we only
 * need to hand it the trailing slice — same arithmetic, far less work per bar.
 */
export function signalsAsOf(
  byDate: ReadonlyMap<string, PolicyRow[]>,
  date: string,
  halfLifeHours: number,
): PolicySignal[] {
  const end = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const window: PolicyRow[] = [];
  for (let back = 0; back <= 8; back++) {
    const d = new Date(end - back * DAY).toISOString().slice(0, 10);
    const rows = byDate.get(d);
    if (rows) window.push(...rows);
  }
  if (window.length === 0) return [];
  return computePolicySignals(window, date, { halfLifeHours });
}

// ------------------------------------------------------------------- engine

type Prepared = {
  symbol: string;
  closes: number[];
  index: Map<string, number>;
};

export function runPolicyNudgeReplay(input: PolicyReplayInput): PolicyNudgeReplayResult {
  const params: PolicyReplayParams = {
    ...DEFAULT_POLICY_REPLAY_PARAMS,
    ...(input.params ?? {}),
  };
  const sizing = riskSizingFor(params.riskLevel);
  const startEquity =
    input.startingEquity && input.startingEquity > 0 ? input.startingEquity : 10_000;

  const prepared: Prepared[] = [];
  for (const [symbol, series] of input.prices) {
    if (!series || series.length < 60) continue;
    const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
    const index = new Map<string, number>();
    sorted.forEach((c, i) => index.set(c.date, i));
    prepared.push({ symbol, closes: sorted.map((c) => c.close), index });
  }
  const bySymbol = new Map(prepared.map((p) => [p.symbol, p]));
  const allDates = [...new Set(prepared.flatMap((p) => [...p.index.keys()]))].sort();
  const symbols = prepared.map((p) => p.symbol);

  const byDate = new Map<string, PolicyRow[]>();
  for (const r of input.news) {
    const d = (r.date ?? "").slice(0, 10);
    if (!d) continue;
    const list = byDate.get(d);
    if (list) list.push(r);
    else byDate.set(d, [r]);
  }

  const attribution: PolicyAttribution = {
    statements: 0,
    activeDays: 0,
    coverage: 0,
    touchedSymbols: 0,
    hawkishDays: 0,
    dovishDays: 0,
    suppressedDays: 0,
    suppressedSymbols: 0,
    promotedDays: 0,
    suppressedForward21Pct: null,
    promotedForward21Pct: null,
    peakNudge: 0,
    peakNudgeSymbol: null,
    peakNudgeDate: null,
  };

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

  if (prepared.length === 0 || allDates.length < 60) {
    return {
      from: allDates[0] ?? "",
      to: allDates[allDates.length - 1] ?? "",
      symbols,
      tradingDays: allDates.length,
      params,
      maxNudge: POLICY_MAX_NUDGE,
      baseline: emptyArm("Baseline (policy muted)"),
      nudged: emptyArm("With policy nudge"),
      delta: {
        returnPct: 0,
        maxDrawdownPct: 0,
        sharpe: 0,
        costPct: 0,
        trades: 0,
        var95Pct: 0,
        cvar95Pct: 0,
        volAnnPct: 0,
      },
      confidence: {
        iterations: 0,
        blockDays: 0,
        returnDeltaLo: 0,
        returnDeltaHi: 0,
        drawdownDeltaLo: 0,
        drawdownDeltaHi: 0,
        probPositive: 0,
        probDrawdownBetter: 0,
      },
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

  const touched = new Set<string>();
  const suppressedSyms = new Set<string>();
  const suppressedFwd: number[] = [];
  const promotedFwd: number[] = [];

  const forward21 = (p: Prepared, i: number): number | null => {
    const a = p.closes[i];
    const b = p.closes[i + 21];
    return a && b && a > 0 ? ((b - a) / a) * 100 : null;
  };

  const select = (
    state: ArmState,
    scores: Array<{ symbol: string; score: number; vol: number | null }>,
  ): Map<string, number> => {
    const eligible = scores
      .filter((s) => s.score >= params.entryThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, params.maxPositions);
    return stepWeights(state.weights, targetWeights(eligible, sizing), sizing);
  };

  const applyDay = (
    state: ArmState,
    target: Map<string, number>,
    dayReturn: (symbol: string) => number | null,
  ) => {
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
    return { cost };
  };

  for (let d = 0; d < allDates.length - 1; d++) {
    const date = allDates[d] as string;
    const next = allDates[d + 1] as string;

    const signals = params.nudgeScale === 0 ? [] : signalsAsOf(byDate, date, params.halfLifeHours);
    let dayActive = false;
    let dayTone = 0;

    const baseScores: Array<{ symbol: string; score: number; vol: number | null }> = [];
    const nudScores: Array<{ symbol: string; score: number; vol: number | null }> = [];

    for (const p of prepared) {
      const i = p.index.get(date);
      if (i == null) continue;
      const s = trendScore(p.closes, i);
      if (s == null) continue;
      const vol = realisedVol(p.closes, i, 20);
      baseScores.push({ symbol: p.symbol, score: s, vol });

      const n = signals.length ? policySentimentNudge(p.symbol, signals) * params.nudgeScale : 0;
      const adj = Math.max(0, Math.min(1, s + n));
      nudScores.push({ symbol: p.symbol, score: adj, vol });

      if (n !== 0) {
        dayActive = true;
        dayTone += n;
        touched.add(p.symbol);
        if (Math.abs(n) > Math.abs(attribution.peakNudge)) {
          attribution.peakNudge = Number(n.toFixed(4));
          attribution.peakNudgeSymbol = p.symbol;
          attribution.peakNudgeDate = date;
        }
      }

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

    if (dayActive) {
      attribution.activeDays += 1;
      if (dayTone < 0) attribution.hawkishDays += 1;
      else if (dayTone > 0) attribution.dovishDays += 1;
    }

    const dayReturn = (symbol: string): number | null => {
      const p = bySymbol.get(symbol);
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

    baseCurve.push({
      date: next,
      equity: Number(base.equity.toFixed(2)),
      cost: Number(rb.cost.toFixed(4)),
      positions: base.weights.size,
    });
    nudCurve.push({
      date: next,
      equity: Number(nud.equity.toFixed(2)),
      cost: Number(rn.cost.toFixed(4)),
      positions: nud.weights.size,
    });
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

  const baseline = arm("Baseline (policy muted)", base, baseCurve, baseRets);
  const nudged = arm("With policy nudge", nud, nudCurve, nudRets);

  // Paired moving-block bootstrap: resample the SAME day indices in both arms so
  // the interval measures the nudge, not the market.
  const n = Math.min(baseRets.length, nudRets.length);
  const iterations = Math.max(200, Math.min(4000, input.iterations ?? 1000));
  const blockDays = Math.max(1, Math.min(n || 1, Math.round(Math.cbrt(Math.max(n, 1))) + 4));
  const rng = makeRng(input.seed ?? 20260813);
  const retSamples: number[] = [];
  const ddSamples: number[] = [];
  if (n >= 30) {
    const blocks = Math.ceil(n / blockDays);
    for (let it = 0; it < iterations; it++) {
      let bAcc = 1;
      let nAcc = 1;
      const bPath: number[] = [];
      const nPath: number[] = [];
      for (let b = 0; b < blocks; b++) {
        const start = Math.floor(rng() * Math.max(1, n - blockDays));
        for (let k = 0; k < blockDays; k++) {
          const idx = start + k;
          if (idx >= n) break;
          const br = baseRets[idx] as number;
          const nr = nudRets[idx] as number;
          bAcc *= 1 + br;
          nAcc *= 1 + nr;
          bPath.push(br);
          nPath.push(nr);
        }
      }
      retSamples.push((nAcc - bAcc) * 100);
      ddSamples.push(ddOfReturns(nPath) - ddOfReturns(bPath));
    }
  }
  const sortedRet = [...retSamples].sort((a, b) => a - b);
  const sortedDd = [...ddSamples].sort((a, b) => a - b);
  const lo = Number(quantile(sortedRet, 0.025).toFixed(3));
  const hi = Number(quantile(sortedRet, 0.975).toFixed(3));
  const ddLo = Number(quantile(sortedDd, 0.025).toFixed(3));
  const ddHi = Number(quantile(sortedDd, 0.975).toFixed(3));
  const probPositive = retSamples.length
    ? Number((retSamples.filter((s) => s > 0).length / retSamples.length).toFixed(3))
    : 0;
  // Drawdowns are negative numbers; "better" means less negative or equal.
  const probDrawdownBetter = ddSamples.length
    ? Number((ddSamples.filter((s) => s >= 0).length / ddSamples.length).toFixed(3))
    : 0;

  const delta = {
    returnPct: Number((nudged.totalReturnPct - baseline.totalReturnPct).toFixed(3)),
    maxDrawdownPct: Number((nudged.maxDrawdownPct - baseline.maxDrawdownPct).toFixed(3)),
    sharpe: Number((nudged.sharpe - baseline.sharpe).toFixed(2)),
    costPct: Number((((nudged.totalCost - baseline.totalCost) / startEquity) * 100).toFixed(3)),
    trades: nudged.trades - baseline.trades,
    var95Pct: Number((nudged.var95Pct - baseline.var95Pct).toFixed(3)),
    cvar95Pct: Number((nudged.cvar95Pct - baseline.cvar95Pct).toFixed(3)),
    volAnnPct: Number((nudged.volAnnPct - baseline.volAnnPct).toFixed(3)),
  };

  const mean = (xs: number[]) =>
    xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null;
  attribution.suppressedSymbols = suppressedSyms.size;
  attribution.touchedSymbols = touched.size;
  attribution.suppressedForward21Pct = mean(suppressedFwd);
  attribution.promotedForward21Pct = mean(promotedFwd);
  attribution.coverage = Number(
    (attribution.activeDays / Math.max(1, allDates.length - 1)).toFixed(3),
  );
  attribution.statements = new Set(
    [...byDate.values()].flat().map((r) => `${r.date}|${r.headline}`),
  ).size;

  const significant = retSamples.length > 0 && (lo > 0 || hi < 0);
  let verdict: PolicyReplayVerdict = "neutral";
  if (significant && delta.returnPct > 0 && delta.maxDrawdownPct >= -0.5) verdict = "helps";
  else if (significant && delta.returnPct < 0) verdict = "hurts";
  else if (!significant && Math.abs(delta.returnPct) < 0.5) verdict = "neutral";
  else verdict = delta.returnPct < 0 ? "hurts" : "neutral";

  const coveragePct = (attribution.coverage * 100).toFixed(0);
  const summary =
    attribution.activeDays === 0
      ? "No tracked policy remarks landed on this tape, so both arms are identical — widen the window or backfill the news cache before reading anything into this."
      : retSamples.length === 0
        ? "Too few bars for a confidence band — treat this as a single path, not evidence."
        : verdict === "helps"
          ? `Listening to policy makers added ${delta.returnPct.toFixed(2)}pp over a ${baseline.totalReturnPct.toFixed(2)}% baseline (95% CI ${lo}..${hi}pp), with max drawdown ${delta.maxDrawdownPct >= 0 ? "shallower" : "deeper"} by ${Math.abs(delta.maxDrawdownPct).toFixed(2)}pp.`
          : verdict === "hurts"
            ? `The policy nudge cost ${Math.abs(delta.returnPct).toFixed(2)}pp versus baseline (95% CI ${lo}..${hi}pp) — on this tape it faded moves that kept running.`
            : `No measurable edge: return delta ${delta.returnPct.toFixed(2)}pp, 95% CI ${lo}..${hi}pp straddling zero. The ±${(POLICY_MAX_NUDGE * 100).toFixed(0)}pt cap keeps it close to harmless either way.`;

  const detail = ` Policy signal was live on ${coveragePct}% of bars (${attribution.activeDays}/${allDates.length - 1}), touching ${attribution.touchedSymbols} symbol${attribution.touchedSymbols === 1 ? "" : "s"}. Drawdown ${baseline.maxDrawdownPct.toFixed(2)}% baseline vs ${nudged.maxDrawdownPct.toFixed(2)}% nudged (95% CI on the difference ${ddLo}..${ddHi}pp); 95% 1-day CVaR ${baseline.cvar95Pct.toFixed(2)}% vs ${nudged.cvar95Pct.toFixed(2)}%.`;

  return {
    from: allDates[0] as string,
    to: allDates[allDates.length - 1] as string,
    symbols,
    tradingDays: allDates.length,
    params,
    maxNudge: POLICY_MAX_NUDGE,
    baseline,
    nudged,
    delta,
    confidence: {
      iterations: retSamples.length ? iterations : 0,
      blockDays,
      returnDeltaLo: lo,
      returnDeltaHi: hi,
      drawdownDeltaLo: ddLo,
      drawdownDeltaHi: ddHi,
      probPositive,
      probDrawdownBetter,
    },
    attribution,
    sizing,
    verdict,
    summary: summary + detail,
  };
}
