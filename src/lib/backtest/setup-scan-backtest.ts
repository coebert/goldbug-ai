/**
 * Historical study of the post-reclaim archetype.
 *
 * Replays the same rules the live scanner uses (`evaluateSetup`) across a
 * symbol's history, then measures what actually happened next under two
 * policies:
 *
 *  - chase:    buy the signal close (what the AI used to do)
 *  - discipline: wait for a pullback into the reclaimed averages, buy only if
 *                the zone is tagged and the invalidation level holds
 *
 * Purpose: quantify how often the pattern is a profitable entry versus froth.
 * All returns are net of a round-trip friction assumption in bps.
 */

import { evaluateSetup, type ScanCandle, type SetupScanRules } from "@/lib/setup-scan";

export type BacktestConfig = {
  /** Forward horizons, in sessions, measured from the entry bar. */
  horizons: number[];
  /** Sessions allowed for the pullback entry to trigger. */
  pullbackWindow: number;
  /** Round-trip friction (commission + spread + stamp) in basis points. */
  frictionBps: number;
  /** Ignore a new signal within this many sessions of the previous one. */
  cooldownDays: number;
  rules?: SetupScanRules;
};

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  horizons: [5, 10, 20],
  pullbackWindow: 10,
  frictionBps: 40,
  cooldownDays: 20,
};

/** What the simulated trade actually did over one forward horizon. */
export type HorizonOutcome = {
  horizon: number;
  exitDate: string;
  exitPrice: number;
  grossPct: number;
  /** Gross less the round-trip friction assumption. */
  netPct: number;
  /** Worst close-to-close excursion from entry within this horizon, %. */
  maxAdversePct: number;
  /** Best close-to-close excursion from entry within this horizon, %. */
  maxFavourablePct: number;
  /** True when a close broke the invalidation level before the horizon ended. */
  invalidated: boolean;
  /** First close below the invalidation level, when it happened. */
  invalidationDate: string | null;
  /** Sessions actually held (equals the horizon unless data ran out). */
  barsHeld: number;
};

export type TradeOutcome = {
  policy: "chase" | "discipline";
  symbol: string;
  signalDate: string;
  signalPrice: number;
  score: number;
  relVolume: number;
  annualVolPct: number;
  /** Rule-derived level that voids the thesis. */
  invalidationBelow: number;
  /** Pullback zone the disciplined policy waits for. */
  zoneLow: number;
  zoneHigh: number;
  /** Entry price under this policy, or null when no entry triggered. */
  entryPrice: number | null;
  entryDate: string | null;
  /** Why no entry happened (discipline only). */
  noEntryReason: string | null;
  /** Net return per horizon, in percent. Missing when data runs out. */
  netReturnPct: Record<number, number | null>;
  /** Full exit detail per horizon: dates, prices, excursions, invalidation. */
  exits: Record<number, HorizonOutcome | null>;
  /** Worst close-to-close drawdown from entry over the longest horizon, %. */
  maxAdversePct: number | null;
  /** True when a close broke the rule-derived invalidation level. */
  stoppedOut: boolean;
  /** Date of the first invalidating close over the longest horizon. */
  invalidationDate: string | null;
};


export type PolicyStats = {
  policy: "chase" | "discipline";
  entries: number;
  /** Signals that never produced an entry (discipline only). */
  skipped: number;
  /** Per-horizon aggregates. */
  horizons: {
    horizon: number;
    samples: number;
    winRatePct: number;
    avgNetPct: number;
    medianNetPct: number;
    bestPct: number;
    worstPct: number;
    /** Average of losers / average of winners, as a payoff ratio. */
    payoff: number | null;
    expectancyPct: number;
  }[];
  avgMaxAdversePct: number | null;
  stopRatePct: number;
};

export type SetupBacktestReport = {
  symbolsTested: number;
  signals: number;
  bySymbol: { symbol: string; signals: number; entries: number }[];
  chase: PolicyStats;
  discipline: PolicyStats;
  trades: TradeOutcome[];
  config: BacktestConfig;
  verdict: string;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Locate every historical bar where the archetype fired for one symbol. */
export function findSignals(
  symbol: string,
  candles: ScanCandle[],
  cfg: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): { index: number; match: NonNullable<ReturnType<typeof evaluateSetup>["match"]> }[] {
  const out: { index: number; match: NonNullable<ReturnType<typeof evaluateSetup>["match"]> }[] = [];
  let lastSignal = -Infinity;
  for (let i = 209; i < candles.length; i += 1) {
    if (i - lastSignal < cfg.cooldownDays) continue;
    const verdict = evaluateSetup(symbol, candles.slice(0, i + 1), { rules: cfg.rules });
    if (verdict.match) {
      out.push({ index: i, match: verdict.match });
      lastSignal = i;
    }
  }
  return out;
}

function measure(
  symbol: string,
  candles: ScanCandle[],
  signalIndex: number,
  match: NonNullable<ReturnType<typeof evaluateSetup>["match"]>,
  entryIndex: number | null,
  cfg: BacktestConfig,
): TradeOutcome {
  const netReturnPct: Record<number, number | null> = {};
  for (const h of cfg.horizons) netReturnPct[h] = null;

  if (entryIndex == null) {
    return {
      symbol,
      signalDate: candles[signalIndex].date,
      signalPrice: match.price,
      score: match.score,
      relVolume: match.relVolume,
      annualVolPct: match.annualVolPct,
      entryPrice: null,
      entryDate: null,
      netReturnPct,
      maxAdversePct: null,
      stoppedOut: false,
    };
  }

  const entry = candles[entryIndex].close;
  const maxH = Math.max(...cfg.horizons);
  for (const h of cfg.horizons) {
    const exitIdx = entryIndex + h;
    if (exitIdx >= candles.length) continue;
    const gross = (candles[exitIdx].close / entry - 1) * 100;
    netReturnPct[h] = gross - cfg.frictionBps / 100;
  }

  let worst = 0;
  let stoppedOut = false;
  for (let i = entryIndex + 1; i <= Math.min(entryIndex + maxH, candles.length - 1); i += 1) {
    const dd = (candles[i].close / entry - 1) * 100;
    if (dd < worst) worst = dd;
    if (candles[i].close < match.invalidationBelow) stoppedOut = true;
  }

  return {
    symbol,
    signalDate: candles[signalIndex].date,
    signalPrice: match.price,
    score: match.score,
    relVolume: match.relVolume,
    annualVolPct: match.annualVolPct,
    entryPrice: entry,
    entryDate: candles[entryIndex].date,
    netReturnPct,
    maxAdversePct: worst,
    stoppedOut,
  };
}

/** Pullback entry: first bar whose low tags the zone while the close holds above invalidation. */
function pullbackEntryIndex(
  candles: ScanCandle[],
  signalIndex: number,
  match: NonNullable<ReturnType<typeof evaluateSetup>["match"]>,
  cfg: BacktestConfig,
): number | null {
  const end = Math.min(signalIndex + cfg.pullbackWindow, candles.length - 1);
  for (let i = signalIndex + 1; i <= end; i += 1) {
    const c = candles[i];
    if (c.close < match.invalidationBelow) return null; // thesis broke before entry
    if (c.low <= match.zoneHigh && c.close >= match.zoneLow) return i;
  }
  return null;
}

function summarise(policy: "chase" | "discipline", trades: TradeOutcome[], cfg: BacktestConfig): PolicyStats {
  const entered = trades.filter((t) => t.entryPrice != null);
  const horizons = cfg.horizons.map((h) => {
    const rs = entered.map((t) => t.netReturnPct[h]).filter((r): r is number => r != null);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const avgWin = mean(wins);
    const avgLoss = Math.abs(mean(losses));
    const winRate = rs.length === 0 ? 0 : (wins.length / rs.length) * 100;
    return {
      horizon: h,
      samples: rs.length,
      winRatePct: winRate,
      avgNetPct: mean(rs),
      medianNetPct: median(rs),
      bestPct: rs.length === 0 ? 0 : Math.max(...rs),
      worstPct: rs.length === 0 ? 0 : Math.min(...rs),
      payoff: avgLoss > 0 ? avgWin / avgLoss : null,
      expectancyPct: (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss,
    };
  });
  const adverse = entered.map((t) => t.maxAdversePct).filter((n): n is number => n != null);
  return {
    policy,
    entries: entered.length,
    skipped: trades.length - entered.length,
    horizons,
    avgMaxAdversePct: adverse.length === 0 ? null : mean(adverse),
    stopRatePct: entered.length === 0 ? 0 : (entered.filter((t) => t.stoppedOut).length / entered.length) * 100,
  };
}

export function buildVerdict(chase: PolicyStats, discipline: PolicyStats, horizon: number): string {
  const c = chase.horizons.find((h) => h.horizon === horizon);
  const d = discipline.horizons.find((h) => h.horizon === horizon);
  if (!c || c.samples < 5) return "Not enough historical signals to judge the pattern.";
  const chaseLine = `Chasing the signal close won ${c.winRatePct.toFixed(0)}% of the time over ${horizon} sessions, expectancy ${c.expectancyPct >= 0 ? "+" : ""}${c.expectancyPct.toFixed(2)}% net.`;
  if (!d || d.samples < 5) {
    return `${chaseLine} Too few disciplined pullback entries to compare — the zone rarely gets tagged.`;
  }
  const better = d.expectancyPct > c.expectancyPct;
  const froth = c.expectancyPct <= 0;
  return [
    chaseLine,
    `Waiting for the pullback traded ${discipline.entries} of ${discipline.entries + discipline.skipped} signals and won ${d.winRatePct.toFixed(0)}%, expectancy ${d.expectancyPct >= 0 ? "+" : ""}${d.expectancyPct.toFixed(2)}% net.`,
    froth
      ? "Verdict: the raw pattern is froth — do not buy the surge bar."
      : "Verdict: the raw pattern carries a positive net edge, but a thin one.",
    better
      ? "Discipline (pullback entry) beats chasing, which is the rule the scanner enforces."
      : "Discipline did not beat chasing on this sample — treat the setup as monitoring only.",
  ].join(" ");
}

/** Run the study across pre-loaded candle histories. */
export function runSetupBacktest(
  histories: { symbol: string; candles: ScanCandle[] }[],
  cfg: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): SetupBacktestReport {
  const chaseTrades: TradeOutcome[] = [];
  const disciplineTrades: TradeOutcome[] = [];
  const bySymbol: { symbol: string; signals: number; entries: number }[] = [];

  for (const { symbol, candles } of histories) {
    const clean = candles.filter((c) => Number.isFinite(c.close) && c.close > 0);
    if (clean.length < 215) continue;
    const signals = findSignals(symbol, clean, cfg);
    let entries = 0;
    for (const s of signals) {
      chaseTrades.push(measure(symbol, clean, s.index, s.match, s.index, cfg));
      const pb = pullbackEntryIndex(clean, s.index, s.match, cfg);
      if (pb != null) entries += 1;
      disciplineTrades.push(measure(symbol, clean, s.index, s.match, pb, cfg));
    }
    bySymbol.push({ symbol, signals: signals.length, entries });
  }

  const chase = summarise("chase", chaseTrades, cfg);
  const discipline = summarise("discipline", disciplineTrades, cfg);
  const primary = cfg.horizons.includes(10) ? 10 : cfg.horizons[0];

  return {
    symbolsTested: bySymbol.length,
    signals: chaseTrades.length,
    bySymbol: bySymbol.sort((a, b) => b.signals - a.signals),
    chase,
    discipline,
    trades: disciplineTrades,
    config: cfg,
    verdict: buildVerdict(chase, discipline, primary),
  };
}
