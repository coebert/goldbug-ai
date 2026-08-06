// Explicit cash-allocation policy.
//
// Historically the engine only ever had CEILINGS on exposure: a cash floor, a
// gross-exposure cap and roughly a dozen multiplicative sizing haircuts. There
// was nothing telling it how much of the book SHOULD be invested, so in a
// benign bull tape a run of small haircuts could leave the portfolio nearly
// flat (90%+ cash) while the index compounded — the single biggest source of
// return leakage in the walk-forward study.
//
// This module adds the missing side of the constraint: a target invested %
// per macro regime, with an explicit floor (`minInvestedPct`) and ceiling
// (`maxInvestedPct`). The target is then de-risked against the drawdown
// budget, so respecting the drawdown ceiling always wins over hitting the
// target. Output is advisory sizing information plus a hard ceiling — it can
// scale buys UP toward the target, but it never permits borrowing, never
// overrides the drawdown halt, and never pushes past the configured caps.

import type { RegimeLabel } from "./regime-detector.server";

export type RiskLevelName = "conservative" | "balanced" | "aggressive";

export type InvestedBand = {
  /** Below this we are under-deployed for the regime. */
  min: number;
  /** Where the policy wants the book to sit. */
  target: number;
  /** Hard ceiling on invested share of NAV for the regime. */
  max: number;
};

/**
 * Regime → invested-share band (fraction of NAV held in positions).
 *
 * Bull tapes demand a high floor: the cost of sitting in cash through a
 * quiet uptrend dwarfs the cost of a normal pullback. Correction/bear/crisis
 * ratchet the whole band down, and crisis keeps a genuine floor of zero so
 * the engine may go fully defensive.
 */
export const REGIME_INVESTED_BANDS: Record<RegimeLabel, InvestedBand> = {
  bull_quiet: { min: 0.70, target: 0.90, max: 0.98 },
  bull_volatile: { min: 0.50, target: 0.75, max: 0.90 },
  recovery: { min: 0.55, target: 0.80, max: 0.95 },
  correction: { min: 0.30, target: 0.55, max: 0.75 },
  bear: { min: 0.10, target: 0.35, max: 0.55 },
  crisis: { min: 0.00, target: 0.15, max: 0.35 },
};

/** Risk dial scaler applied to the regime band. */
export const RISK_LEVEL_SCALE: Record<RiskLevelName, number> = {
  conservative: 0.75,
  balanced: 1,
  aggressive: 1.12,
};

/** Never relax a user's cash floor below this, whatever the target says. */
export const ABSOLUTE_MIN_CASH_PCT = 0.02;

/** Most a single tick may scale a buy up toward the target. */
export const MAX_DEPLOYMENT_SCALE = 1.5;

export type CashAllocationInput = {
  regime: RegimeLabel;
  riskLevel: RiskLevelName;
  /** Total portfolio value (cash + holdings), base currency. */
  totalValue: number;
  /** Market value of holdings, base currency. */
  holdingsValue: number;
  /** Configured cash floor as a fraction of NAV (0..1). */
  cashFloorPct: number;
  /** Current portfolio drawdown from its recent peak, 0..1 positive. */
  portfolioDrawdownPct?: number | null;
  /** Configured max-drawdown halt level, 0..1. Zero/absent = no budget cap. */
  maxDrawdownHaltPct?: number | null;
  /** Index drawdown from its 1y high (negative, e.g. -0.12). */
  indexDrawdownPct?: number | null;
  /** Optional explicit user target (0..1) replacing the regime target. */
  targetOverridePct?: number | null;
  /** When false the policy reports but never changes sizing or the floor. */
  enabled?: boolean;
};

export type CashAllocationPolicy = {
  enabled: boolean;
  regime: RegimeLabel;
  /** Current holdings / NAV. */
  investedPct: number;
  minInvestedPct: number;
  targetInvestedPct: number;
  maxInvestedPct: number;
  /** target − invested; positive means under-deployed. */
  gapPct: number;
  state: "underinvested" | "on_target" | "overinvested";
  /** Cash floor after the policy may relax an over-tight configured floor. */
  effectiveCashFloorPct: number;
  /** Multiplier applied to a proposed buy. >1 deploys faster, <1 slows down. */
  deploymentScale: number;
  /** Base-currency value that may still be deployed before hitting the max. */
  deployableValue: number;
  /** Base-currency value above the ceiling that should be trimmed (0 if none). */
  trimValue: number;
  /** Multiplier that the drawdown budget applied to the regime band (0..1). */
  drawdownTaper: number;
  note: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/**
 * Drawdown taper: how much of the regime band survives the drawdown budget.
 * Untouched while the portfolio uses less than 40% of its drawdown budget,
 * then falls linearly to 0.25 as it approaches the halt level. This is what
 * keeps "don't go flat in a bull" from ever overriding "respect the ceiling".
 */
export function drawdownTaper(
  portfolioDrawdownPct: number | null | undefined,
  maxDrawdownHaltPct: number | null | undefined,
): number {
  const dd = Math.abs(num(portfolioDrawdownPct));
  const budget = num(maxDrawdownHaltPct);
  if (!(dd > 0) || !(budget > 0)) return 1;
  const used = clamp(dd / budget, 0, 1);
  if (used <= 0.4) return 1;
  return clamp(1 - ((used - 0.4) / 0.6) * 0.75, 0.25, 1);
}

/** Extra tilt from how deep the broad index sits below its 1y high. */
function indexTilt(indexDrawdownPct: number | null | undefined): number {
  const dd = num(indexDrawdownPct);
  if (!(dd < 0)) return 1;
  // Shallow dips are buyable; deep index holes reduce the target even when
  // the regime label has not flipped yet.
  if (dd > -0.05) return 1;
  if (dd > -0.1) return 0.95;
  if (dd > -0.15) return 0.85;
  return 0.75;
}

export function resolveCashAllocationPolicy(
  input: CashAllocationInput,
): CashAllocationPolicy {
  const enabled = input.enabled !== false;
  const totalValue = Math.max(0, num(input.totalValue));
  const holdingsValue = Math.max(0, num(input.holdingsValue));
  const investedPct = totalValue > 0 ? clamp(holdingsValue / totalValue, 0, 1) : 0;
  const configuredFloor = clamp(num(input.cashFloorPct), 0, 1);

  const band = REGIME_INVESTED_BANDS[input.regime] ?? REGIME_INVESTED_BANDS.correction;
  const scale = RISK_LEVEL_SCALE[input.riskLevel] ?? 1;
  const taper = drawdownTaper(input.portfolioDrawdownPct, input.maxDrawdownHaltPct);
  const tilt = indexTilt(input.indexDrawdownPct);
  const shaped = scale * taper * tilt;

  const override = input.targetOverridePct;
  const hasOverride = override != null && Number.isFinite(Number(override));
  // A user target is still de-risked by the drawdown budget — the ceiling is
  // never negotiable — but it is not re-scaled by the risk dial or index tilt.
  const rawTarget = hasOverride
    ? clamp(Number(override), 0, 1) * taper
    : clamp(band.target * shaped, 0, 1);

  // The invested ceiling can never exceed what the cash floor leaves free.
  let maxInvested = clamp(Math.min(band.max * Math.min(1, shaped), 1 - ABSOLUTE_MIN_CASH_PCT), 0, 1);
  let targetInvested = clamp(Math.min(rawTarget, maxInvested), 0, maxInvested);
  let minInvested = clamp(Math.min(band.min * shaped, targetInvested), 0, targetInvested);

  // Cash floor. A configured floor that is tighter than the target would make
  // the target unreachable, so the policy may relax it — but only down to the
  // level the target actually needs, never below the absolute minimum, and
  // never while the drawdown budget is being consumed.
  let effectiveFloor = configuredFloor;
  if (enabled && taper >= 1 && configuredFloor > 1 - targetInvested) {
    effectiveFloor = Math.max(ABSOLUTE_MIN_CASH_PCT, 1 - targetInvested);
  }
  // If the floor still binds tighter than the target (drawdown taper active,
  // or floor already at the absolute minimum), the achievable exposure drops
  // to whatever the floor leaves.
  const floorCeiling = clamp(1 - effectiveFloor, 0, 1);
  maxInvested = Math.min(maxInvested, floorCeiling);
  targetInvested = Math.min(targetInvested, maxInvested);
  minInvested = Math.min(minInvested, targetInvested);

  const gapPct = targetInvested - investedPct;
  const state: CashAllocationPolicy["state"] =
    investedPct > maxInvested + 1e-9
      ? "overinvested"
      : investedPct < minInvested - 1e-9
        ? "underinvested"
        : "on_target";

  // Deployment scale. Under the floor we push buys up toward the target;
  // between target and ceiling we throttle down; above the ceiling we stop
  // opening risk entirely and surface a trim amount instead.
  let deploymentScale = 1;
  if (!enabled) {
    deploymentScale = 1;
  } else if (investedPct >= maxInvested) {
    deploymentScale = 0;
  } else if (investedPct >= targetInvested) {
    const room = Math.max(1e-9, maxInvested - targetInvested);
    deploymentScale = clamp(1 - 0.75 * ((investedPct - targetInvested) / room), 0.25, 1);
  } else if (targetInvested > 0) {
    const shortfall = clamp(gapPct / targetInvested, 0, 1);
    deploymentScale = clamp(1 + (MAX_DEPLOYMENT_SCALE - 1) * shortfall, 1, MAX_DEPLOYMENT_SCALE);
  }

  const deployableValue = Math.max(0, totalValue * maxInvested - holdingsValue);
  const trimValue = Math.max(0, holdingsValue - totalValue * maxInvested);

  const parts: string[] = [
    `${input.regime} target ${pct(targetInvested)} invested (band ${pct(minInvested)}–${pct(maxInvested)}), currently ${pct(investedPct)}`,
  ];
  if (taper < 1) parts.push(`drawdown budget taper ×${taper.toFixed(2)}`);
  if (tilt < 1) parts.push(`index-drawdown tilt ×${tilt.toFixed(2)}`);
  if (effectiveFloor < configuredFloor) {
    parts.push(`cash floor relaxed ${pct(configuredFloor)}→${pct(effectiveFloor)} to make the target reachable`);
  }
  if (!enabled) parts.push("policy reporting only (disabled)");
  else if (state === "underinvested") parts.push(`under-deployed — buys ×${deploymentScale.toFixed(2)}`);
  else if (state === "overinvested") parts.push(`above ceiling — new buys blocked, trim ${trimValue.toFixed(0)}`);

  return {
    enabled,
    regime: input.regime,
    investedPct,
    minInvestedPct: minInvested,
    targetInvestedPct: targetInvested,
    maxInvestedPct: maxInvested,
    gapPct,
    state,
    effectiveCashFloorPct: effectiveFloor,
    deploymentScale,
    deployableValue,
    trimValue,
    drawdownTaper: taper,
    note: parts.join("; "),
  };
}

/** Compact prompt block so the model sizes toward the same target. */
export function formatCashAllocationBlock(
  policy: CashAllocationPolicy,
  currency: string,
): string {
  const lines = [
    "CASH-ALLOCATION POLICY (explicit target exposure — read before sizing):",
    `- Regime ${policy.regime}: target ${pct(policy.targetInvestedPct)} of NAV invested, allowed band ${pct(policy.minInvestedPct)}–${pct(policy.maxInvestedPct)}.`,
    `- Currently invested: ${pct(policy.investedPct)} (${policy.state.replace("_", " ")}).`,
    `- Deployable before the ceiling: ${policy.deployableValue.toFixed(0)} ${currency}. Minimum cash kept: ${pct(policy.effectiveCashFloorPct)}.`,
  ];
  if (policy.drawdownTaper < 1) {
    lines.push(
      `- The target has ALREADY been cut ×${policy.drawdownTaper.toFixed(2)} because the portfolio is using its drawdown budget. Do not try to size back up.`,
    );
  }
  if (policy.state === "underinvested") {
    lines.push(
      `- Sitting this far below target is itself a risk: in this regime cash has historically cost more than a normal pullback. Prefer deploying into your best-ranked candidates rather than returning an empty order list, unless the candidates genuinely fail your criteria.`,
    );
  } else if (policy.state === "overinvested") {
    lines.push(
      `- Exposure is ABOVE the ceiling: propose no new buys and consider trimming about ${policy.trimValue.toFixed(0)} ${currency} of the weakest positions.`,
    );
  } else {
    lines.push("- Exposure is inside the target band: trade only on genuine conviction, size normally.");
  }
  return lines.join("\n");
}
