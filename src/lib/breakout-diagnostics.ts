// Per-symbol and per-signal diagnostics for the breakout signal backtest.
//
// The headline report answers "did confirmed breakouts beat failed ones?".
// This module answers the follow-up: *where* did that gap come from. Two
// cuts, both pure functions over the trades the backtest already produced:
//
//   symbolDiagnostics()      — one row per symbol, confirmed vs failed, plus
//                              each symbol's share of the cohort's total P&L
//                              so a single name carrying (or sinking) the
//                              result is impossible to miss.
//   signalStateDiagnostics() — one block per breakout state, split by trade
//                              direction, exit reason and evidence-quality
//                              bucket, so a state that only works on, say,
//                              downside breaks that hit their target shows up.
//
// No I/O, no clock, no randomness — same trades in, same rows out.

import type { SignalCohort, SignalTrade } from "@/lib/breakout-backtest";
import type { RegimeLabel } from "@/lib/regime-walk-forward";
import {
  DEFAULT_BREAKOUT_REGIME_POLICY,
  type BreakoutRegimePolicyConfig,
} from "@/lib/alpha/breakout-regime-policy";

export type SignalSlice = {
  trades: number;
  wins: number;
  winRatePct: number;
  avgReturnPct: number;
  medianReturnPct: number;
  /** Sum of net returns at 1 unit per signal — the P&L contribution. */
  sumReturnPct: number;
  bestPct: number;
  worstPct: number;
  avgBarsHeld: number;
};

export const EMPTY_SLICE: SignalSlice = {
  trades: 0,
  wins: 0,
  winRatePct: 0,
  avgReturnPct: 0,
  medianReturnPct: 0,
  sumReturnPct: 0,
  bestPct: 0,
  worstPct: 0,
  avgBarsHeld: 0,
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarizeSlice(trades: readonly SignalTrade[]): SignalSlice {
  if (!trades.length) return { ...EMPTY_SLICE };
  const rets = trades.map((t) => t.returnPct);
  const sum = rets.reduce((a, b) => a + b, 0);
  const wins = rets.filter((r) => r > 0).length;
  return {
    trades: trades.length,
    wins,
    winRatePct: (wins / trades.length) * 100,
    avgReturnPct: sum / trades.length,
    medianReturnPct: median(rets),
    sumReturnPct: sum,
    bestPct: Math.max(...rets),
    worstPct: Math.min(...rets),
    avgBarsHeld: trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length,
  };
}

// ---------------------------------------------------------------------------
// Regime + volatility context
//
// A diagnostic group's headline number ("confirmed lose 0.8% here") is not
// actionable on its own: the same number is produced by three very different
// causes, and the live gate treats each one differently.
//
//   * regime gating      — the cell itself has measured negative expectancy
//                          on an adequate sample, so the gate vetoes.
//   * sideways tape      — chop, hostile by construction, size is capped.
//   * high-vol downsize  — realised vol clears the gate's threshold, size is
//                          capped regardless of what the cell says.
//
// So every group carries the regime cells behind it, the volatility actually
// measured at signal time, and what the live gate would do with that cell.
// ---------------------------------------------------------------------------

export const REGIME_ORDER: readonly RegimeLabel[] = ["bull", "bear", "sideways"] as const;

export type RegimeGateVerdict = {
  action: "trade" | "downsize" | "skip";
  /** Size multiplier cap the gate would apply (1 = untouched, 0 = vetoed). */
  mult: number;
  /** Which layer bound: what the user is trying to attribute the gap to. */
  driver: "regime gating" | "sideways tape" | "high-vol downsize" | "unproven sample" | "none";
  reason: string;
};

/**
 * Replay the live gate's *cell-level* logic against a measured slice. This is
 * deliberately the same ordering as `breakoutRegimeAction`: veto on measured
 * negative expectancy first, then hostile tape, then thin sample.
 */
export function regimeGateVerdict(
  input: { regime: RegimeLabel; highVol: boolean; trades: number; expectancyPct: number },
  config: Partial<BreakoutRegimePolicyConfig> = {},
): RegimeGateVerdict {
  const cfg = { ...DEFAULT_BREAKOUT_REGIME_POLICY, ...config };
  const proven = input.trades >= cfg.minTrades;
  const ev = `${input.expectancyPct >= 0 ? "+" : ""}${input.expectancyPct.toFixed(2)}%/trade on n=${input.trades}`;
  if (proven && input.expectancyPct <= cfg.minExpectancyPct) {
    return {
      action: "skip",
      mult: 0,
      driver: "regime gating",
      reason: `${input.regime} expectancy ${ev} — gate vetoes chases in this cell`,
    };
  }
  if (input.regime === "sideways" || input.highVol) {
    const cap = input.highVol ? cfg.highVolMult : cfg.sidewaysMult;
    return {
      action: "downsize",
      mult: cap,
      driver: input.highVol ? "high-vol downsize" : "sideways tape",
      reason: `${input.highVol ? "high-vol tape" : "sideways tape"} caps size at x${cap.toFixed(2)}; ${ev}`,
    };
  }
  if (!proven) {
    return {
      action: "downsize",
      mult: cfg.unprovenMult,
      driver: "unproven sample",
      reason: `only ${input.trades} trades in the ${input.regime} cell — unproven, x${cfg.unprovenMult.toFixed(2)}`,
    };
  }
  return { action: "trade", mult: 1, driver: "none", reason: `${input.regime} expectancy ${ev} — full size` };
}

export type RegimeVolCell = {
  regime: RegimeLabel;
  slice: SignalSlice;
  /** Share of this group's signals that fell in this regime. */
  sharePct: number;
  /** Mean 20d realised daily stdev at signal time (0.012 = 1.2%/day). */
  avgRealisedVol20d: number | null;
  /** Share of the cell's signals that cleared the gate's high-vol threshold. */
  highVolSharePct: number;
  /** Mean ATR(14) as a share of price. */
  avgAtrPct: number | null;
  gate: RegimeGateVerdict;
};

export type RegimeVolContext = {
  cells: RegimeVolCell[];
  avgRealisedVol20d: number | null;
  highVolSharePct: number;
  sidewaysSharePct: number;
  /** The layer that explains most of this group's gated signals. */
  dominantDriver: RegimeGateVerdict["driver"] | "mixed";
  /** One-line plain-language attribution for the UI. */
  summary: string;
};

function avgOrNull(xs: (number | null | undefined)[]): number | null {
  const vals = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function isHighVolTrade(t: SignalTrade, cfg: BreakoutRegimePolicyConfig): boolean {
  return t.realisedVol20d != null && t.realisedVol20d >= cfg.realisedVolHigh;
}

/**
 * Regime cells + volatility measurements behind an arbitrary set of trades.
 * Used to annotate both the per-symbol rows and the per-signal-state blocks.
 */
export function regimeVolContext(
  trades: readonly SignalTrade[],
  config: Partial<BreakoutRegimePolicyConfig> = {},
): RegimeVolContext {
  const cfg = { ...DEFAULT_BREAKOUT_REGIME_POLICY, ...config };
  const total = trades.length;
  const cells: RegimeVolCell[] = [];
  for (const regime of REGIME_ORDER) {
    const ts = trades.filter((t) => t.regime === regime);
    if (!ts.length) continue;
    const slice = summarizeSlice(ts);
    const highVolShare = (ts.filter((t) => isHighVolTrade(t, cfg)).length / ts.length) * 100;
    cells.push({
      regime,
      slice,
      sharePct: total ? (ts.length / total) * 100 : 0,
      avgRealisedVol20d: avgOrNull(ts.map((t) => t.realisedVol20d)),
      highVolSharePct: highVolShare,
      avgAtrPct: avgOrNull(ts.map((t) => t.atrPct)),
      gate: regimeGateVerdict(
        {
          regime,
          // A cell counts as high-vol tape when most of its signals fired
          // above the gate's realised-vol threshold.
          highVol: highVolShare >= 50,
          trades: slice.trades,
          expectancyPct: slice.avgReturnPct,
        },
        cfg,
      ),
    });
  }

  const highVolSharePct = total
    ? (trades.filter((t) => isHighVolTrade(t, cfg)).length / total) * 100
    : 0;
  const sidewaysSharePct = total
    ? (trades.filter((t) => t.regime === "sideways").length / total) * 100
    : 0;

  // Attribute by how many signals sit under each binding layer.
  const weight = new Map<RegimeGateVerdict["driver"], number>();
  for (const c of cells) {
    weight.set(c.gate.driver, (weight.get(c.gate.driver) ?? 0) + c.slice.trades);
  }
  const ranked = [...weight.entries()]
    .filter(([driver]) => driver !== "none")
    .sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const dominantDriver: RegimeVolContext["dominantDriver"] = !top
    ? "none"
    : ranked.length > 1 && ranked[1]![1] === top[1]
      ? "mixed"
      : top[0];

  const volTxt =
    avgOrNull(trades.map((t) => t.realisedVol20d)) == null
      ? "vol not measured"
      : `vol ${(avgOrNull(trades.map((t) => t.realisedVol20d))! * 100).toFixed(2)}%/day, ${highVolSharePct.toFixed(0)}% above the high-vol line`;
  const summary = !total
    ? "No signals."
    : `${sidewaysSharePct.toFixed(0)}% sideways · ${volTxt} · mostly bound by ${dominantDriver === "none" ? "nothing (full size)" : dominantDriver}`;

  return {
    cells,
    avgRealisedVol20d: avgOrNull(trades.map((t) => t.realisedVol20d)),
    highVolSharePct,
    sidewaysSharePct,
    dominantDriver,
    summary,
  };
}


export type SymbolDiagnostic = {
  symbol: string;
  all: SignalSlice;
  confirmed: SignalSlice;
  failed: SignalSlice;
  /** confirmed − failed win rate, in percentage points. */
  winRateGapPp: number;
  /** confirmed − failed average return, in percentage points. */
  avgReturnGapPct: number;
  /**
   * Share of the confirmed cohort's *total absolute* P&L this symbol accounts
   * for, signed by its own contribution. +40 = this name produced 40% of the
   * cohort's gross movement and it was profitable.
   */
  confirmedContributionPct: number;
  /** Plain-language role of this symbol in the confirmed result. */
  role: "driver" | "drag" | "neutral" | "thin";
  /** Regime cells + vol measurements behind every signal on this symbol. */
  regimeVol: RegimeVolContext;
  /** Same cut restricted to the confirmed cohort (what the live gate sees). */
  confirmedRegimeVol: RegimeVolContext;
};

export type SymbolDiagnosticsOptions = {
  /** Minimum confirmed+failed signals before a symbol is judged. */
  minTrades?: number;
  /** Keep at most this many rows (highest absolute contribution first). */
  limit?: number;
};

export function symbolDiagnostics(
  trades: readonly SignalTrade[],
  options: SymbolDiagnosticsOptions = {},
): SymbolDiagnostic[] {
  const minTrades = options.minTrades ?? 3;
  const bySymbol = new Map<string, SignalTrade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.symbol);
    if (arr) arr.push(t);
    else bySymbol.set(t.symbol, [t]);
  }

  const confirmedGross = trades
    .filter((t) => t.cohort === "confirmed")
    .reduce((a, t) => a + Math.abs(t.returnPct), 0);

  const rows: SymbolDiagnostic[] = [];
  for (const [symbol, ts] of bySymbol) {
    const confirmed = summarizeSlice(ts.filter((t) => t.cohort === "confirmed"));
    const failed = summarizeSlice(ts.filter((t) => t.cohort === "failed"));
    const contribution =
      confirmedGross > 0 ? (confirmed.sumReturnPct / confirmedGross) * 100 : 0;
    const judged = confirmed.trades + failed.trades >= minTrades && confirmed.trades > 0;
    const role: SymbolDiagnostic["role"] = !judged
      ? "thin"
      : contribution >= 5
        ? "driver"
        : contribution <= -5
          ? "drag"
          : "neutral";
    rows.push({
      symbol,
      all: summarizeSlice(ts),
      confirmed,
      failed,
      winRateGapPp: confirmed.winRatePct - failed.winRatePct,
      avgReturnGapPct: confirmed.avgReturnPct - failed.avgReturnPct,
      confirmedContributionPct: contribution,
      role,
      regimeVol: regimeVolContext(ts),
      confirmedRegimeVol: regimeVolContext(ts.filter((t) => t.cohort === "confirmed")),
    });
  }

  rows.sort(
    (a, b) =>
      Math.abs(b.confirmedContributionPct) - Math.abs(a.confirmedContributionPct) ||
      b.all.trades - a.all.trades ||
      (a.symbol < b.symbol ? -1 : 1),
  );
  return options.limit ? rows.slice(0, options.limit) : rows;
}

export type QualityBucket = "low" | "medium" | "high";
export const QUALITY_BUCKETS: readonly QualityBucket[] = ["low", "medium", "high"] as const;

export function qualityBucket(quality: number): QualityBucket {
  if (quality < 0.4) return "low";
  if (quality < 0.7) return "medium";
  return "high";
}

export type SignalStateDiagnostic = {
  cohort: SignalCohort;
  overall: SignalSlice;
  byDirection: { direction: "up" | "down"; slice: SignalSlice }[];
  byExitReason: { reason: SignalTrade["exitReason"]; slice: SignalSlice }[];
  byQuality: { bucket: QualityBucket; slice: SignalSlice }[];
  /** Average worst adverse excursion while open, in % (<= 0). */
  avgMaxAdversePct: number;
  /** Share of trades stopped out before the horizon. */
  stopRatePct: number;
  /** Share of trades that reached their profit target. */
  targetRatePct: number;
  /** Regime cells + vol measurements behind this cohort's signals. */
  regimeVol: RegimeVolContext;
};

export function signalStateDiagnostics(
  trades: readonly SignalTrade[],
): SignalStateDiagnostic[] {
  const byCohort = new Map<SignalCohort, SignalTrade[]>();
  for (const t of trades) {
    const arr = byCohort.get(t.cohort);
    if (arr) arr.push(t);
    else byCohort.set(t.cohort, [t]);
  }

  const out: SignalStateDiagnostic[] = [];
  for (const [cohort, ts] of byCohort) {
    const reasons = Array.from(new Set(ts.map((t) => t.exitReason)));
    out.push({
      cohort,
      overall: summarizeSlice(ts),
      regimeVol: regimeVolContext(ts),
      byDirection: (["up", "down"] as const)
        .map((direction) => ({
          direction,
          slice: summarizeSlice(ts.filter((t) => t.direction === direction)),
        }))
        .filter((d) => d.slice.trades > 0),
      byExitReason: reasons
        .map((reason) => ({
          reason,
          slice: summarizeSlice(ts.filter((t) => t.exitReason === reason)),
        }))
        .sort((a, b) => b.slice.trades - a.slice.trades),
      byQuality: QUALITY_BUCKETS.map((bucket) => ({
        bucket,
        slice: summarizeSlice(ts.filter((t) => qualityBucket(t.quality) === bucket)),
      })).filter((q) => q.slice.trades > 0),
      avgMaxAdversePct: ts.reduce((a, t) => a + t.maxAdversePct, 0) / ts.length,
      stopRatePct: (ts.filter((t) => t.exitReason === "stop").length / ts.length) * 100,
      targetRatePct: (ts.filter((t) => t.exitReason === "target").length / ts.length) * 100,
    });
  }

  const order: SignalCohort[] = ["confirmed", "pending", "extended", "failed"];
  out.sort((a, b) => order.indexOf(a.cohort) - order.indexOf(b.cohort));
  return out;
}

/**
 * A single name ranked by how much it moves the confirmed cohort's result.
 *
 * Two independent signals are blended into one score:
 *   - signed P&L share  — how much of the cohort's gross movement this name
 *                         accounts for, signed by its own contribution.
 *   - expectancy gap    — confirmed minus failed average return, i.e. how much
 *                         edge the *signal itself* adds on this name.
 * A name can carry P&L purely because it traded a lot (share high, gap ~0), or
 * show real signal edge on a handful of trades (gap high, share small). The
 * blend surfaces both, and both components are kept on the row so the UI can
 * show which one is doing the work.
 */
export type DriverConfidenceLabel = "high" | "medium" | "low";

/**
 * How much weight to put on a driver row. Blends three independent doubts:
 *   - sample     — few confirmed signals means the score is noise-dominated.
 *   - breadth    — a name whose P&L share dwarfs its share of cohort trades is
 *                  carried by a couple of outlier moves, not a repeatable edge.
 *   - basis      — expectancy-gap-led rows lean on the failed cohort as a
 *                  control, which is a weaker basis than realised P&L share.
 */
export type DriverConfidence = {
  score: number;
  label: DriverConfidenceLabel;
  sampleScore: number;
  breadthScore: number;
  reasons: string[];
};

export type TopDriver = {
  symbol: string;
  /** Signed share of the confirmed cohort's gross P&L, in percent. */
  contributionPct: number;
  /** confirmed − failed average return, in percentage points. */
  expectancyGapPct: number;
  /** confirmed − failed win rate, in percentage points. */
  winRateGapPp: number;
  confirmedTrades: number;
  confirmedAvgReturnPct: number;
  /** This name's share of all confirmed signals in the sample, in percent. */
  tradeSharePct: number;
  /** Blended rank score; positive = helps the cohort, negative = hurts it. */
  score: number;
  /** Which component dominates the score. */
  lead: "P&L share" | "expectancy gap";
  /** Gate layer binding this name's confirmed signals, for context. */
  gateDriver: RegimeGateVerdict["driver"] | "mixed";
  /** How trustworthy this row is, for badging in the UI. */
  confidence: DriverConfidence;
};

export type TopDrivers = {
  positive: TopDriver[];
  negative: TopDriver[];
  /** Weight applied to the expectancy gap when blending the score. */
  gapWeight: number;
  summary: string;
};

export type TopDriversOptions = {
  /** Rows per side. Default 5. */
  limit?: number;
  /** Minimum confirmed signals before a name can be ranked. Default 3. */
  minConfirmed?: number;
  /** Weight on the expectancy gap relative to P&L share. Default 2. */
  gapWeight?: number;
  /** Confirmed signals at which the sample is treated as fully trustworthy. Default 20. */
  fullSampleAt?: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function driverConfidence(input: {
  confirmedTrades: number;
  minConfirmed: number;
  fullSampleAt: number;
  tradeSharePct: number;
  contributionPct: number;
  lead: TopDriver["lead"];
}): DriverConfidence {
  const span = Math.max(1, input.fullSampleAt - input.minConfirmed);
  const sampleScore = clamp01((input.confirmedTrades - input.minConfirmed) / span);

  const absContribution = Math.abs(input.contributionPct);
  const breadthScore =
    absContribution <= 0.0001
      ? 1
      : clamp01(input.tradeSharePct / absContribution);

  const basisFactor = input.lead === "expectancy gap" ? 0.85 : 1;
  // Multiplicative so a thin sample alone can drag the row to "low" even when
  // its P&L is perfectly broad-based, and vice versa.
  const score = clamp01((0.35 + 0.65 * sampleScore) * (0.4 + 0.6 * breadthScore) * basisFactor);
  const label: DriverConfidenceLabel = score >= 0.66 ? "high" : score >= 0.4 ? "medium" : "low";

  const reasons: string[] = [];
  reasons.push(
    sampleScore >= 0.66
      ? `${input.confirmedTrades} confirmed signals`
      : `only ${input.confirmedTrades} confirmed signals`,
  );
  if (breadthScore < 0.6) {
    reasons.push(
      `P&L share (${absContribution.toFixed(0)}%) far exceeds its ${input.tradeSharePct.toFixed(0)}% share of trades — outlier-driven`,
    );
  } else {
    reasons.push("P&L spread in line with its trade count");
  }
  if (input.lead === "expectancy gap") {
    reasons.push("score led by the expectancy gap, which leans on the failed cohort as control");
  }

  return { score, label, sampleScore, breadthScore, reasons };
}


export function topDrivers(
  symbols: readonly SymbolDiagnostic[],
  options: TopDriversOptions = {},
): TopDrivers {
  const limit = options.limit ?? 5;
  const minConfirmed = options.minConfirmed ?? 3;
  const gapWeight = options.gapWeight ?? 2;
  const fullSampleAt = options.fullSampleAt ?? 20;
  const totalConfirmed = symbols.reduce((a, s) => a + s.confirmed.trades, 0);

  const rows: TopDriver[] = symbols
    .filter((s) => s.confirmed.trades >= minConfirmed)
    .map((s) => {
      const shareTerm = s.confirmedContributionPct;
      const gapTerm = s.avgReturnGapPct * gapWeight;
      const lead: TopDriver["lead"] =
        Math.abs(gapTerm) > Math.abs(shareTerm) ? "expectancy gap" : "P&L share";
      const tradeSharePct = totalConfirmed ? (s.confirmed.trades / totalConfirmed) * 100 : 0;
      return {
        symbol: s.symbol,
        contributionPct: s.confirmedContributionPct,
        expectancyGapPct: s.avgReturnGapPct,
        winRateGapPp: s.winRateGapPp,
        confirmedTrades: s.confirmed.trades,
        confirmedAvgReturnPct: s.confirmed.avgReturnPct,
        tradeSharePct,
        score: shareTerm + gapTerm,
        lead,
        gateDriver: s.confirmedRegimeVol.dominantDriver,
        confidence: driverConfidence({
          confirmedTrades: s.confirmed.trades,
          minConfirmed,
          fullSampleAt,
          tradeSharePct,
          contributionPct: s.confirmedContributionPct,
          lead,
        }),
      } satisfies TopDriver;
    });


  const positive = rows
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.confirmedTrades - a.confirmedTrades)
    .slice(0, limit);
  const negative = rows
    .filter((r) => r.score < 0)
    .sort((a, b) => a.score - b.score || b.confirmedTrades - a.confirmedTrades)
    .slice(0, limit);

  const fmt = (r: TopDriver) => `${r.symbol} (${r.score >= 0 ? "+" : ""}${r.score.toFixed(1)})`;
  const summary = !rows.length
    ? "Not enough confirmed signals to rank contributors."
    : `Top up: ${positive.length ? positive.slice(0, 3).map(fmt).join(", ") : "none"} · top down: ${
        negative.length ? negative.slice(0, 3).map(fmt).join(", ") : "none"
      }.`;

  return { positive, negative, gapWeight, summary };
}

export type BreakoutDiagnostics = {
  symbols: SymbolDiagnostic[];
  states: SignalStateDiagnostic[];
  /** Regime cells + vol measurements across the whole sample. */
  regimeVol: RegimeVolContext;
  /** Biggest positive/negative contributors, ranked. */
  topDrivers: TopDrivers;
  /** One-line takeaways for the UI, already ranked by usefulness. */
  notes: string[];
};


export function buildBreakoutDiagnostics(
  trades: readonly SignalTrade[],
  options: SymbolDiagnosticsOptions = {},
): BreakoutDiagnostics {
  const symbols = symbolDiagnostics(trades, options);
  const states = signalStateDiagnostics(trades);
  const regimeVol = regimeVolContext(trades);
  const drivers2 = topDrivers(symbols);
  const notes: string[] = [];
  if (trades.length) {
    notes.push(`Gate context: ${regimeVol.summary}.`);
  }


  const drivers = symbols.filter((s) => s.role === "driver");
  const drags = symbols.filter((s) => s.role === "drag");
  if (drivers.length) {
    notes.push(
      `${drivers
        .slice(0, 3)
        .map((s) => `${s.symbol} (${s.confirmedContributionPct >= 0 ? "+" : ""}${s.confirmedContributionPct.toFixed(0)}%)`)
        .join(", ")} carry the confirmed cohort's P&L.`,
    );
  }
  if (drags.length) {
    notes.push(
      `${drags
        .slice(0, 3)
        .map((s) => `${s.symbol} (${s.confirmedContributionPct.toFixed(0)}%)`)
        .join(", ")} drag it down the hardest.`,
    );
  }
  const confirmed = states.find((s) => s.cohort === "confirmed");
  if (confirmed) {
    notes.push(
      `Confirmed signals stop out ${confirmed.stopRatePct.toFixed(0)}% of the time and reach target ${confirmed.targetRatePct.toFixed(0)}%.`,
    );
    const bestQ = [...confirmed.byQuality]
      .filter((q) => q.slice.trades >= 5)
      .sort((a, b) => b.slice.avgReturnPct - a.slice.avgReturnPct)[0];
    if (bestQ) {
      notes.push(
        `${bestQ.bucket} evidence-quality confirmations return ${bestQ.slice.avgReturnPct.toFixed(2)}% on average over ${bestQ.slice.trades} signals.`,
      );
    }
    const bestDir = [...confirmed.byDirection]
      .filter((d) => d.slice.trades >= 5)
      .sort((a, b) => b.slice.avgReturnPct - a.slice.avgReturnPct)[0];
    if (bestDir) {
      notes.push(
        `${bestDir.direction === "up" ? "Upside" : "Downside"} confirmations are the better side (${bestDir.slice.avgReturnPct.toFixed(2)}% avg over ${bestDir.slice.trades}).`,
      );
    }
  }

  return { symbols, states, regimeVol, topDrivers: drivers2, notes };
}
