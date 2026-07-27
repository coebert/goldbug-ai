// Simulation performance report builder.
//
// Given a fixed decision stream (each decision tagged with a date) and a
// matrix of `SimulateOptions` scenarios, run every scenario through
// `simulateBrokerExecution` and produce, per scenario:
//   • equity curve   — end-of-day totalValue points
//   • drawdown curve — % below running peak, always <= 0
//   • summary stats  — CAGR, Sharpe-like, max drawdown, win rate,
//                      trades, fill ratio, ending equity, total return %
//
// Pure: no I/O. Reuses `computeBacktestMetrics` so Sharpe/DD/win-rate
// semantics stay in lock-step with the rest of the app.

import {
  simulateBrokerExecution,
  type SimDecision,
  type SimState,
  type SimSnapshot,
  type SimulateOptions,
  type SimulateResult,
} from "./broker-simulator";
import {
  computeBacktestMetrics,
  type EquityPoint,
  type TradeRow,
  type BacktestMetrics,
} from "./backtest-metrics";

/** Broker decision annotated with the trading date it is applied on. */
export type DatedDecision = SimDecision & {
  /** ISO date (YYYY-MM-DD) the decision executes on. */
  date: string;
};

export type ScenarioSpec = {
  /** Stable identifier — used as a legend/table key. */
  id: string;
  /** Human-facing label. */
  label: string;
  /** Optional per-scenario opening state (defaults to `defaultInitial`). */
  initial?: SimState;
  /** Broker-simulator options describing frictions/liquidity/etc. */
  options: SimulateOptions;
};

export type EquityCurvePoint = { date: string; equity: number };
export type DrawdownPoint = { date: string; drawdown: number };

export type ScenarioSummary = {
  id: string;
  label: string;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  /** Annualised, calendar-days based. `null` when < 2 days of data. */
  cagrPct: number | null;
  /** Annualised Sharpe (rf=0), from daily returns; from computeBacktestMetrics. */
  sharpe: number;
  /** Negative percentage (-12.5 = 12.5% peak-to-trough drop). */
  maxDrawdownPct: number;
  /** Percentage of closed round-trips with realized PnL > 0. `null` when no round-trips. */
  winRatePct: number | null;
  trades: number;
  /** Fill ratio from executionQuality (0..1). */
  fillRatio: number;
  days: number;
};

export type ScenarioReport = {
  id: string;
  label: string;
  equityCurve: EquityCurvePoint[];
  drawdownCurve: DrawdownPoint[];
  summary: ScenarioSummary;
  metrics: BacktestMetrics;
  raw: SimulateResult;
};

export type BuildScenarioReportInput = {
  /** Dated decision stream. Order preserved within each date. */
  decisions: DatedDecision[];
  /** Default opening state for scenarios that don't override it. */
  defaultInitial: SimState;
  /** Scenarios to evaluate — reported in the order supplied. */
  scenarios: ScenarioSpec[];
};

/**
 * Compute Compound Annual Growth Rate over the supplied equity curve.
 * Uses calendar days between the first and last snapshot date so short
 * windows aren't over-annualised via a bar count. Returns `null` when
 * fewer than 2 distinct dates or a non-positive start value.
 */
export function computeCagrPct(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 2) return null;
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!(first.equity > 0)) return null;
  const t0 = Date.parse(first.date + "T00:00:00Z");
  const t1 = Date.parse(last.date + "T00:00:00Z");
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  const years = (t1 - t0) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return null;
  const ratio = last.equity / first.equity;
  if (!(ratio > 0)) return null;
  return (Math.pow(ratio, 1 / years) - 1) * 100;
}

/**
 * Reduce the per-decision snapshot stream to one end-of-day equity
 * point per unique date, using the last snapshot on that date. Dates
 * with no snapshots simply do not appear (the caller can insert an
 * opening point via `openingDate`/`openingEquity` if desired).
 */
export function reduceSnapshotsToDaily(
  snapshots: SimSnapshot[],
  dateFor: (s: SimSnapshot) => string,
  opening?: { date: string; equity: number },
): EquityCurvePoint[] {
  const byDate = new Map<string, number>();
  if (opening) byDate.set(opening.date, opening.equity);
  for (const s of snapshots) {
    byDate.set(dateFor(s), s.totalValue);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, equity]) => ({ date, equity }));
}

/** Peak-to-current drawdown as a NEGATIVE percentage, per curve point. */
export function drawdownFromCurve(curve: EquityCurvePoint[]): DrawdownPoint[] {
  let peak = -Infinity;
  return curve.map((p) => {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((p.equity - peak) / peak) * 100 : 0;
    return { date: p.date, drawdown: Number(dd.toFixed(6)) };
  });
}

/** Convert simulator snapshots into the `TradeRow` shape used by metrics. */
function snapshotsToTradeRows(
  snapshots: SimSnapshot[],
  dateFor: (s: SimSnapshot) => string,
): TradeRow[] {
  return snapshots
    .filter((s) => s.fillQuantity > 0)
    .map((s) => ({
      trade_date: dateFor(s),
      side: s.side === "BUY" ? "buy" : "sell",
      symbol: s.symbol,
      quantity: s.fillQuantity,
      price: s.fillPrice,
    }));
}

/**
 * Run one scenario end-to-end. Returned curves always include the
 * opening equity point (dated to the earliest decision date, or the
 * fallback `openingDate` when no decisions exist).
 */
export function runScenario(
  spec: ScenarioSpec,
  decisions: DatedDecision[],
  defaultInitial: SimState,
): ScenarioReport {
  const initial = spec.initial ?? defaultInitial;
  const startEquity = initial.cash + initial.holdings.reduce(
    (a, h) => a + h.quantity * h.avgCost, 0,
  );
  const openingDate = decisions[0]?.date ?? "1970-01-01";

  const raw = simulateBrokerExecution(initial, decisions, spec.options);
  const dateFor = (s: SimSnapshot) =>
    decisions.find((d) => d.id === (s.sliceOf ?? s.decisionId))?.date
      ?? openingDate;

  const equityCurve = reduceSnapshotsToDaily(
    raw.snapshots, dateFor, { date: openingDate, equity: startEquity },
  );
  const drawdownCurve = drawdownFromCurve(equityCurve);
  const trades = snapshotsToTradeRows(raw.snapshots, dateFor);

  const equityPoints: EquityPoint[] = equityCurve.map((p) => ({
    snapshot_date: p.date, total_value: p.equity,
  }));
  const metrics = computeBacktestMetrics(equityPoints, trades, startEquity);

  const endEquity = equityCurve[equityCurve.length - 1]?.equity ?? startEquity;
  const totalReturnPct = startEquity > 0
    ? ((endEquity - startEquity) / startEquity) * 100 : 0;

  const summary: ScenarioSummary = {
    id: spec.id,
    label: spec.label,
    startEquity,
    endEquity,
    totalReturnPct,
    cagrPct: computeCagrPct(equityCurve),
    sharpe: metrics.sharpe,
    maxDrawdownPct: metrics.maxDrawdownPct,
    winRatePct: metrics.winRatePct,
    trades: metrics.trades,
    fillRatio: raw.executionQuality.fillRatio,
    days: equityCurve.length,
  };

  return {
    id: spec.id, label: spec.label,
    equityCurve, drawdownCurve, summary, metrics, raw,
  };
}

/** Build a full report across every scenario. */
export function buildScenarioReport(
  input: BuildScenarioReportInput,
): ScenarioReport[] {
  return input.scenarios.map((s) =>
    runScenario(s, input.decisions, input.defaultInitial),
  );
}

// ---------------------------------------------------------------------------
// Default liquidity × frictions matrix used by the in-app report.
// Kept alongside the runner so tests and UI stay in sync.

export type MatrixPresetKey =
  | "frictionless_deep"
  | "frictionless_thin"
  | "realistic_deep"
  | "realistic_thin"
  | "harsh_thin";

export const SCENARIO_MATRIX: Record<MatrixPresetKey, {
  label: string;
  options: SimulateOptions;
}> = {
  frictionless_deep: {
    label: "Frictionless · Deep book",
    options: {},
  },
  frictionless_thin: {
    label: "Frictionless · Thin book (5% ADV)",
    options: {
      liquidity: { maxParticipationRate: 0.05 },
      timeSliceUnfilled: true,
      timeSliceMaxAttempts: 5,
    },
  },
  realistic_deep: {
    label: "Realistic frictions · Deep book",
    options: {
      frictions: {
        commissionPerShare: 0.005,
        minCommission: 1,
        slippageBps: 5,
      },
    },
  },
  realistic_thin: {
    label: "Realistic frictions · Thin book (5% ADV)",
    options: {
      frictions: {
        commissionPerShare: 0.005,
        minCommission: 1,
        slippageBps: 5,
      },
      liquidity: { maxParticipationRate: 0.05 },
      timeSliceUnfilled: true,
      timeSliceMaxAttempts: 5,
    },
  },
  harsh_thin: {
    label: "Harsh frictions · Thin book (2% ADV)",
    options: {
      frictions: {
        commissionPerShare: 0.01,
        minCommission: 2,
        slippageBps: 15,
      },
      liquidity: { maxParticipationRate: 0.02 },
      timeSliceUnfilled: true,
      timeSliceMaxAttempts: 5,
    },
  },
};

export function defaultScenarioSpecs(): ScenarioSpec[] {
  return (Object.keys(SCENARIO_MATRIX) as MatrixPresetKey[]).map((id) => ({
    id, label: SCENARIO_MATRIX[id].label, options: SCENARIO_MATRIX[id].options,
  }));
}
