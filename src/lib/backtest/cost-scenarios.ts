// Fee / spread / stamp-duty scenario backtest.
//
// Every cost number the engine uses is an estimate: the Saxo commission tier,
// the half-spread we assume we cross, and whether a name attracts the 0.5% UK
// stamp duty. Those estimates flatter the strategy if they are optimistic —
// and a strategy that only makes money under optimistic friction is a strategy
// that loses money in production.
//
// This module replays the SAME signals over the SAME bars once per cost
// scenario (best / base / worst), and reports not just the headline return but
// how OFTEN the strategy avoided losses: the share of calendar months and of
// rolling windows that finished flat-or-up. A strategy whose profit survives
// the worst case only in one lucky month is not robust, and the frequency
// columns make that visible in a way a single return number never does.
//
// Pure and deterministic: no I/O, no clock, no randomness.

import type { BacktestBar } from "../backtest-runner";
import {
  runBatchingArm,
  type BatchingAbArm,
  type BatchingArmResult,
  type BatchingSignal,
  type OrderBatchingAbInput,
} from "./order-batching-ab";
import { estimateTradeCosts } from "../trade-viability-gate";

export type CostScenarioId = "best" | "base" | "worst";

export type CostScenario = {
  id: CostScenarioId;
  label: string;
  /** Plain-language statement of what this case assumes. */
  assumption: string;
  /** Multiplier on modelled Saxo commission (and its floor). */
  commissionMult: number;
  /** Full quoted spread in bps; we pay half of it per side. */
  spreadBps: number;
  /** Multiplier on UK stamp duty — 0 models an exemption-heavy book. */
  stampMult: number;
  /** Extra one-way slippage, bps of notional, on top of the half-spread. */
  extraSlippageBps: number;
};

/**
 * The three cases. `base` reproduces the live estimator exactly (10bps quoted
 * spread, full commission, full stamp), so it is directly comparable with the
 * order-batching A/B and the friction KPI.
 */
export const COST_SCENARIOS: Record<CostScenarioId, CostScenario> = {
  best: {
    id: "best",
    label: "Best case",
    assumption:
      "Tight 4bps spreads, no extra slippage, and a stamp-exempt book (ETFs/ETCs only).",
    commissionMult: 1,
    spreadBps: 4,
    stampMult: 0,
    extraSlippageBps: 0,
  },
  base: {
    id: "base",
    label: "Base case",
    assumption:
      "The live model: Saxo tiered commission with its floor, 10bps quoted spread, full 0.5% UK stamp duty.",
    commissionMult: 1,
    spreadBps: 10,
    stampMult: 1,
    extraSlippageBps: 0,
  },
  worst: {
    id: "worst",
    label: "Worst case",
    assumption:
      "Wide 30bps spreads, 8bps of adverse slippage per side, 1.25x commission, full stamp duty.",
    commissionMult: 1.25,
    spreadBps: 30,
    stampMult: 1,
    extraSlippageBps: 8,
  },
};

export const COST_SCENARIO_ORDER: CostScenarioId[] = ["best", "base", "worst"];

/**
 * Re-price one ticket under a scenario. Built by decomposing the live
 * estimator, so commission tiers, the fixed floor and the PTM levy keep their
 * real (non-linear) shape instead of being crudely scaled.
 */
export function scenarioTradeCost(
  o: {
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    assetClass?: string | null;
  },
  scenario: CostScenario,
): number {
  const c = estimateTradeCosts({
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    assetClass: o.assetClass ?? null,
    spreadBps: scenario.spreadBps,
  });
  const notional = Math.max(0, o.quantity * o.price);
  const cost =
    c.commission * scenario.commissionMult +
    c.stampDuty * scenario.stampMult +
    c.ptmLevy +
    c.halfSpread +
    (notional * scenario.extraSlippageBps) / 10_000;
  return Number.isFinite(cost) ? cost : 0;
}

export type PeriodOutcome = {
  /** Period key: `YYYY-MM` for months, window end date for rolling windows. */
  period: string;
  returnPct: number;
  avoidedLoss: boolean;
};

export type ScenarioOutcome = {
  scenario: CostScenario;
  arm: BatchingArmResult;
  /** Share (0..1) of calendar months that finished flat or up. */
  monthsProfitablePct: number;
  monthsTotal: number;
  months: PeriodOutcome[];
  /** Share (0..1) of rolling windows that finished flat or up. */
  rollingProfitablePct: number;
  rollingWindows: number;
  /** Share (0..1) of days the book was at or above its starting equity. */
  daysAboveStartPct: number;
  /** Cost drag in bps of starting equity. */
  costBpsOfEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  /** True if the whole replay finished flat or up. */
  profitable: boolean;
};

export type CostScenarioVerdict =
  | "robust"
  | "fragile"
  | "unprofitable"
  | "inconclusive";

export type CostScenarioSweepResult = {
  scenarios: ScenarioOutcome[];
  verdict: CostScenarioVerdict;
  summary: string;
  /** Return give-up (pp) from best case to worst case. */
  costSensitivityPct: number;
  /** Loss-avoidance give-up (pp of months) from best case to worst case. */
  frequencySensitivityPct: number;
  /** Extra friction (bps of equity) the worst case pays over the best case. */
  frictionSpreadBps: number;
  bars: number;
  signals: number;
  minTicketBase: number;
  rollingWindowDays: number;
};

export type CostScenarioSweepInput = {
  bars: BacktestBar[];
  signals: BatchingSignal[];
  startingCash: number;
  minTicketBase: number;
  /** Which routing arm to price. Defaults to the live behaviour (batched). */
  arm?: BatchingAbArm;
  windowHours?: number;
  maxPriceDriftPct?: number;
  /** Length of the rolling profitability window, in bars. */
  rollingWindowDays?: number;
  /** Which scenarios to run. Defaults to best/base/worst. */
  scenarioIds?: CostScenarioId[];
  /**
   * Market-impact / slippage model applied on top of the scenario's fee and
   * spread assumptions, so bigger tickets pay for the liquidity they take.
   */
  execution?: OrderBatchingAbInput["execution"];
};

export const DEFAULT_ROLLING_WINDOW_DAYS = 21;

function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Calendar-month returns from an equity curve, first bar of the month as base. */
export function monthlyOutcomes(
  curve: ReadonlyArray<{ date: string; totalValue: number }>,
): PeriodOutcome[] {
  const out: PeriodOutcome[] = [];
  let key: string | null = null;
  let open = 0;
  let last = 0;
  for (const p of curve) {
    const k = monthKey(p.date);
    if (k !== key) {
      if (key != null && open > 0) {
        const r = ((last - open) / open) * 100;
        out.push({ period: key, returnPct: r, avoidedLoss: r >= 0 });
      }
      key = k;
      // The month opens at the previous close, so a month is not credited with
      // a gain that actually happened on the last bar of the month before.
      open = last > 0 ? last : p.totalValue;
    }
    last = p.totalValue;
  }
  if (key != null && open > 0) {
    const r = ((last - open) / open) * 100;
    out.push({ period: key, returnPct: r, avoidedLoss: r >= 0 });
  }
  return out;
}

/** Overlapping N-bar windows: the honest read on "would I have been down?". */
export function rollingOutcomes(
  curve: ReadonlyArray<{ date: string; totalValue: number }>,
  windowDays: number,
): PeriodOutcome[] {
  const n = Math.max(2, Math.floor(windowDays));
  const out: PeriodOutcome[] = [];
  for (let i = n; i < curve.length; i += 1) {
    const start = curve[i - n]!.totalValue;
    const end = curve[i]!.totalValue;
    if (!(start > 0)) continue;
    const r = ((end - start) / start) * 100;
    out.push({ period: curve[i]!.date, returnPct: r, avoidedLoss: r >= 0 });
  }
  return out;
}

function share(rows: PeriodOutcome[]): number {
  if (rows.length === 0) return 0;
  return rows.filter((r) => r.avoidedLoss).length / rows.length;
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

function pctText(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Replay the strategy under each cost scenario and score how robust its
 * profitability is to friction assumptions.
 */
export async function runCostScenarioSweep(
  input: CostScenarioSweepInput,
): Promise<CostScenarioSweepResult> {
  const ids = input.scenarioIds?.length ? input.scenarioIds : COST_SCENARIO_ORDER;
  const arm: BatchingAbArm = input.arm ?? "batched";
  const rollingWindowDays = input.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;

  const scenarios = await Promise.all(
    ids.map(async (id): Promise<ScenarioOutcome> => {
      const scenario = COST_SCENARIOS[id];
      const armInput: OrderBatchingAbInput = {
        bars: input.bars,
        signals: input.signals,
        startingCash: input.startingCash,
        minTicketBase: input.minTicketBase,
        windowHours: input.windowHours,
        maxPriceDriftPct: input.maxPriceDriftPct,
        costModel: (o) => scenarioTradeCost(o, scenario),
        execution: input.execution,
      };
      const result = await runBatchingArm(arm, armInput);
      const curve = result.equityCurve;
      const months = monthlyOutcomes(curve);
      const rolling = rollingOutcomes(curve, rollingWindowDays);
      const start = result.startingValue;
      const daysAbove =
        curve.length > 0 && start > 0
          ? curve.filter((p) => p.totalValue >= start).length / curve.length
          : 0;

      return {
        scenario,
        arm: result,
        months,
        monthsTotal: months.length,
        monthsProfitablePct: share(months),
        rollingProfitablePct: share(rolling),
        rollingWindows: rolling.length,
        daysAboveStartPct: daysAbove,
        costBpsOfEquity: result.costBpsOfEquity,
        returnPct: result.returnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        sharpe: result.sharpe,
        profitable: result.returnPct >= 0,
      };
    }),
  );

  const byId = new Map(scenarios.map((s) => [s.scenario.id, s]));
  const best = byId.get("best") ?? scenarios[0]!;
  const worst = byId.get("worst") ?? scenarios[scenarios.length - 1]!;
  const base = byId.get("base") ?? best;

  const costSensitivityPct = best.returnPct - worst.returnPct;
  const frequencySensitivityPct =
    (best.monthsProfitablePct - worst.monthsProfitablePct) * 100;
  const frictionSpreadBps = worst.costBpsOfEquity - best.costBpsOfEquity;

  const tickets = scenarios.reduce((a, s) => a + s.arm.tickets, 0);

  let verdict: CostScenarioVerdict;
  if (tickets === 0 || base.monthsTotal < 3) {
    verdict = "inconclusive";
  } else if (!best.profitable) {
    verdict = "unprofitable";
  } else if (worst.profitable && worst.monthsProfitablePct >= 0.5) {
    verdict = "robust";
  } else {
    verdict = "fragile";
  }

  const summary =
    verdict === "robust"
      ? `Profitable in every cost case: ${fmt(worst.returnPct, 2)}% even on worst-case friction (${fmt(worst.costBpsOfEquity)}bps of equity), avoiding losses in ${pctText(worst.monthsProfitablePct)} of months. The edge is bigger than the friction uncertainty.`
      : verdict === "fragile"
        ? `The edge depends on friction assumptions: ${fmt(best.returnPct, 2)}% best case but ${fmt(worst.returnPct, 2)}% worst case, and the share of loss-free months falls from ${pctText(best.monthsProfitablePct)} to ${pctText(worst.monthsProfitablePct)}. Treat the base-case profit as optimistic until spreads are measured on real fills.`
        : verdict === "unprofitable"
          ? `Loss-making even under best-case costs (${fmt(best.returnPct, 2)}%, ${pctText(best.monthsProfitablePct)} of months loss-free). The problem is the signal, not the friction — cutting costs will not rescue it.`
          : `Not enough trading to judge: ${tickets} tickets across ${base.monthsTotal} months. Lengthen the sample before reading the scenario table.`;

  return {
    scenarios,
    verdict,
    summary,
    costSensitivityPct,
    frequencySensitivityPct,
    frictionSpreadBps,
    bars: input.bars.length,
    signals: input.signals.length,
    minTicketBase: input.minTicketBase,
    rollingWindowDays,
  };
}
