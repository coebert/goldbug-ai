// Friction scenarios for the out-of-sample backtest.
//
// The OOS coupling test already pays calibrated execution costs (Saxo
// commission + Corwin-Schultz half-spread + sqrt-law impact) and draws random
// slippage. What it did NOT do is ask the obvious follow-up: does the finding
// that the tail is insensitive to the coupling assumption survive when trading
// frictions get worse than the calibration says?
//
// A friction scenario is a multiplicative overlay on the calibrated cost model
// plus a scaling of the random slippage draw. Nothing here re-estimates
// anything — it deliberately re-prices the SAME tape and the SAME random draws
// under harsher (or zero) frictions, so any change in the arm-to-arm spread is
// attributable to frictions alone.

import {
  executionCostFor,
  type SymbolExecutionCalibration,
} from "./execution-calibration-from-bars";
import type { OrderUrgency } from "./spread-slippage";

export type FrictionScenario = {
  /** Short label used in report rows. */
  label: string;
  /** Multiplier on the calibrated half-spread leg. */
  spreadMult: number;
  /** Multiplier on the market-impact / latency leg. */
  impactMult: number;
  /** Multiplier on venue commission (including its min-ticket floor). */
  commissionMult: number;
  /** Flat extra cost charged on every filled notional, bps of notional. */
  extraBps: number;
  /** Multiplier on the lognormal slippage sigma of the shock sampler. */
  slippageSigmaMult: number;
  /** Multiplier on the stress-regime slippage amplifier. */
  stressSlippageMult: number;
  /** Urgency profile handed to the calibrated cost model. */
  urgency: OrderUrgency;
  /** One-line plain-English description for the report header. */
  note: string;
};

const base = {
  spreadMult: 1,
  impactMult: 1,
  commissionMult: 1,
  extraBps: 0,
  slippageSigmaMult: 1,
  stressSlippageMult: 1,
  urgency: "normal" as OrderUrgency,
};

/**
 * The default ladder. `calibrated` is the run's own cost model untouched, so it
 * reproduces the existing OOS numbers exactly and acts as the control row.
 */
export const FRICTION_LADDER: readonly FrictionScenario[] = [
  {
    ...base,
    label: "frictionless",
    spreadMult: 0,
    impactMult: 0,
    commissionMult: 0,
    slippageSigmaMult: 0,
    stressSlippageMult: 1,
    note: "no costs, no slippage — upper bound, not a tradeable world",
  },
  {
    ...base,
    label: "calibrated",
    note: "fitted spread + Saxo commission + sqrt impact (the control)",
  },
  {
    ...base,
    label: "stressed",
    spreadMult: 2,
    impactMult: 2,
    slippageSigmaMult: 1.5,
    stressSlippageMult: 1.35,
    urgency: "urgent",
    note: "spread and impact doubled, slippage draw 1.5x wider, urgent fills",
  },
  {
    ...base,
    label: "punitive",
    spreadMult: 3,
    impactMult: 4,
    commissionMult: 1.5,
    extraBps: 5,
    slippageSigmaMult: 2,
    stressSlippageMult: 1.6,
    urgency: "urgent",
    note: "crisis liquidity: 3x spread, 4x impact, +5bps fee drag",
  },
];

export function frictionScenarioByLabel(label: string): FrictionScenario | null {
  return FRICTION_LADDER.find((s) => s.label === label) ?? null;
}

/**
 * Resolve a comma-separated CLI list into scenarios, preserving ladder order
 * and rejecting unknown names loudly (a silent skip would make a friction run
 * look insensitive for the wrong reason).
 */
export function parseFrictionLadder(spec: string | null | undefined): FrictionScenario[] {
  if (!spec || !spec.trim()) return [...FRICTION_LADDER];
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const out: FrictionScenario[] = [];
  for (const name of wanted) {
    const found = frictionScenarioByLabel(name);
    if (!found) {
      throw new Error(
        `Unknown friction scenario "${name}". Known: ${FRICTION_LADDER.map((s) => s.label).join(", ")}`,
      );
    }
    if (!out.some((s) => s.label === found.label)) out.push(found);
  }
  return out;
}

/**
 * Build the `costFor(symbol, notional, slipMult)` closure the simulator wants,
 * with the scenario's overlay applied leg by leg. The `slipMult` from the shock
 * sampler still scales the spread/impact legs, so a stressed draw and a
 * stressed scenario compound the way they would in real life.
 */
export function makeFrictionCostFn(
  calibs: ReadonlyMap<string, SymbolExecutionCalibration>,
  fallback: SymbolExecutionCalibration,
  scenario: FrictionScenario,
): (symbol: string, notional: number, slipMult: number) => number {
  return (symbol, notional, slipMult) => {
    const n = Math.max(0, Number(notional) || 0);
    if (n === 0) return 0;
    const c = executionCostFor(
      calibs.get(symbol) ?? fallback,
      n,
      scenario.urgency,
      Math.max(0, slipMult),
    );
    const total = c.commission * scenario.commissionMult
      + c.spread * scenario.spreadMult
      + c.impact * scenario.impactMult
      + (n * scenario.extraBps) / 10_000;
    return Math.max(0, total);
  };
}

/** Apply the scenario's slippage scaling to a shock-sampler config. */
export function applyFrictionToShocks<
  T extends { slippageSigma: number; stressSlippageMult: number },
>(cfg: T, scenario: FrictionScenario): T {
  return {
    ...cfg,
    slippageSigma: Math.max(0, cfg.slippageSigma * scenario.slippageSigmaMult),
    stressSlippageMult: Math.max(1, cfg.stressSlippageMult * scenario.stressSlippageMult),
  };
}

// ------------------------------------------------------------------ verdicts

export type ArmMetricRow = {
  arm: string;
  /** Median return over paths, %. */
  medianReturnPct: number;
  /** Worst drawdown seen across paths, %ncan be negative. */
  worstDrawdownPct: number;
  /** Conditional CVaR of return in the worst-stress bucket, %. */
  condCvarPct: number;
  /** Mean execution cost per path, currency. */
  costPerPath: number;
};

export type FrictionSensitivityRow = {
  scenario: string;
  /** max − min across arms of the median return, in percentage points. */
  returnSpreadPp: number;
  /** max − min across arms of the worst drawdown, in percentage points. */
  drawdownSpreadPp: number;
  /** max − min across arms of the conditional stress CVaR, in pp. */
  condCvarSpreadPp: number;
  /** Mean cost per path across arms, currency. */
  meanCostPerPath: number;
  /** Best-median arm under this scenario. */
  bestArm: string;
  /** Worst-median arm under this scenario. */
  worstArm: string;
  /**
   * True when the arm-to-arm spread on every tail metric stays under the
   * tolerance — i.e. the coupling assumption still does not matter here.
   */
  tailInsensitive: boolean;
};

const spread = (xs: readonly number[]) =>
  xs.length ? Math.max(...xs) - Math.min(...xs) : 0;

/**
 * Summarise one scenario's arm table into a single sensitivity verdict.
 * `tolerancePp` is the size of an arm-to-arm difference that would be worth
 * acting on; anything smaller is noise given the path count.
 */
export function summariseFrictionSensitivity(
  scenario: string,
  rows: readonly ArmMetricRow[],
  tolerancePp = 1,
): FrictionSensitivityRow {
  const byMedian = [...rows].sort((a, b) => b.medianReturnPct - a.medianReturnPct);
  const returnSpreadPp = spread(rows.map((r) => r.medianReturnPct));
  const drawdownSpreadPp = spread(rows.map((r) => r.worstDrawdownPct));
  const condCvarSpreadPp = spread(rows.map((r) => r.condCvarPct));
  const meanCostPerPath = rows.length
    ? rows.reduce((a, r) => a + r.costPerPath, 0) / rows.length
    : 0;
  return {
    scenario,
    returnSpreadPp,
    drawdownSpreadPp,
    condCvarSpreadPp,
    meanCostPerPath,
    bestArm: byMedian[0]?.arm ?? "n/a",
    worstArm: byMedian[byMedian.length - 1]?.arm ?? "n/a",
    tailInsensitive: returnSpreadPp <= tolerancePp
      && drawdownSpreadPp <= tolerancePp
      && condCvarSpreadPp <= tolerancePp,
  };
}

export function formatFrictionSensitivity(
  rows: readonly FrictionSensitivityRow[],
): string {
  const header = [
    "scenario".padEnd(14),
    "Δret pp".padStart(9),
    "ΔworstDD".padStart(9),
    "ΔcCVaR".padStart(9),
    "cost£".padStart(9),
    "best arm".padEnd(18),
    "verdict".padEnd(16),
  ].join(" ");
  const lines = [header, "-".repeat(header.length)];
  for (const r of rows) {
    lines.push([
      r.scenario.padEnd(14),
      r.returnSpreadPp.toFixed(2).padStart(9),
      r.drawdownSpreadPp.toFixed(2).padStart(9),
      r.condCvarSpreadPp.toFixed(2).padStart(9),
      r.meanCostPerPath.toFixed(0).padStart(9),
      r.bestArm.padEnd(18),
      (r.tailInsensitive ? "insensitive" : "COUPLING MATTERS").padEnd(16),
    ].join(" "));
  }
  return lines.join("\n");
}

/**
 * Cost elasticity of the strategy itself: how much median return is lost per
 * unit of extra friction, measured against the frictionless row when present.
 */
export function frictionCostDrag(
  rows: readonly { scenario: string; medianReturnPct: number; meanCostPerPath: number }[],
): Array<{ scenario: string; returnGivenUpPp: number; extraCost: number }> {
  const ref = rows.find((r) => r.scenario === "frictionless") ?? rows[0];
  if (!ref) return [];
  return rows.map((r) => ({
    scenario: r.scenario,
    returnGivenUpPp: ref.medianReturnPct - r.medianReturnPct,
    extraCost: r.meanCostPerPath - ref.meanCostPerPath,
  }));
}
