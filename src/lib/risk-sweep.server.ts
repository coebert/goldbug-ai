// Risk-dial sweep: run the same long-horizon backtest once per dial position
// so the user can see, on one chart, how position sizing and buy/sell
// aggressiveness change the equity curve.
//
// Each leg uses the shared preset from `risk-presets.ts` — the exact config
// the dial would write to the portfolio — so the preview is faithful.

import type { Database } from "@/integrations/supabase/types";
import { RISK_LEVELS, riskPresetConfig, riskPresetName } from "./risk-presets";
import { resolveAggressiveness } from "./risk-aggressiveness";
import {
  runLongHorizonBacktest,
  LONG_HORIZON_UNIVERSE,
  type CurvePoint,
  type Metrics,
} from "./long-horizon.server";

export type RiskSweepLeg = {
  level: number;
  name: string;
  /** Effective knobs for this leg, echoed for the UI legend. */
  sizeMult: number;
  buy: number;
  sell: number;
  /** Equity curve indexed to 100 at inception so legs are comparable. */
  curve: CurvePoint[];
  metrics: Metrics | null;
  tradeCount: number;
  costsPaid: number;
};

export type RiskSweepResult = {
  from: string;
  to: string;
  currency: string;
  starting_cash: number;
  current_level: number;
  legs: RiskSweepLeg[];
};

const ENUM_BY_LEVEL: Record<number, Database["public"]["Enums"]["risk_level"]> = {
  1: "conservative",
  2: "conservative",
  3: "balanced",
  4: "aggressive",
  5: "aggressive",
};

function indexTo100(curve: CurvePoint[]): CurvePoint[] {
  const base = curve.find((p) => p.value > 0)?.value ?? 0;
  if (!(base > 0)) return curve;
  return curve.map((p) => ({ date: p.date, value: (p.value / base) * 100 }));
}

export async function runRiskLevelSweep(opts: {
  from: string;
  to: string;
  startingCash: number;
  currency: string;
  currentLevel: number;
  rebalance?: "monthly" | "quarterly";
  topK?: number;
}): Promise<RiskSweepResult> {
  const legs: RiskSweepLeg[] = [];

  for (const level of RISK_LEVELS) {
    const cfg = riskPresetConfig(level);
    const a = resolveAggressiveness(cfg);
    const res = await runLongHorizonBacktest({
      from: opts.from,
      to: opts.to,
      startingCash: opts.startingCash,
      currency: opts.currency,
      riskLevel: ENUM_BY_LEVEL[level],
      riskConfig: cfg,
      universe: LONG_HORIZON_UNIVERSE,
      rebalance: opts.rebalance ?? "monthly",
      topK: opts.topK ?? 6,
    });
    // The strategy leg is the first series; benchmarks follow.
    const strat = res.series[0];
    legs.push({
      level,
      name: riskPresetName(level),
      sizeMult: a.sizeMult,
      buy: a.buy,
      sell: a.sell,
      curve: indexTo100(strat?.curve ?? []),
      metrics: strat?.metrics ?? null,
      tradeCount: res.tradeCount,
      costsPaid: res.totalCostsPaid,
    });
  }

  return {
    from: opts.from,
    to: opts.to,
    currency: opts.currency,
    starting_cash: opts.startingCash,
    current_level: opts.currentLevel,
    legs,
  };
}
