// Single-name concentration breach detection and trim sizing.
//
// The cost governor stops the engine *adding* to a name past the cap, but a
// position can drift through the cap on price alone — and nothing then tells
// the user their book has quietly become a one-stock bet. This module turns a
// set of valued positions into an actionable prompt: which names breach, how
// much to sell to get back inside the cap, and what that does to risk.
//
// Pure: no IO, no React. All money figures are already in base currency.

import { DEFAULT_MAX_POSITION_PCT_OF_NAV } from "@/lib/cost-governor";

export const DEFAULT_CONCENTRATION_CAP = DEFAULT_MAX_POSITION_PCT_OF_NAV;

/**
 * Trim past the cap by this much so a 0.1% tick doesn't immediately re-breach
 * and prompt a second round-trip of costs.
 */
export const TRIM_BUFFER_PCT = 0.01; // 1pp of NAV

/** A single position, valued in the portfolio's base currency. */
export type ConcentrationPosition = {
  /** Holding row id, so the UI can open the sell dialog directly. */
  holdingId: string;
  symbol: string;
  /** Units held. */
  quantity: number;
  /** Market value in base currency. Rows we cannot value must be omitted. */
  valueBase: number;
  /** Crypto/FX can be sold fractionally; equities and ETFs cannot. */
  fractional?: boolean;
};

export type ConcentrationBreach = {
  holdingId: string;
  symbol: string;
  quantity: number;
  valueBase: number;
  /** Current share of NAV, 0-1. */
  weight: number;
  /** The cap that was breached, 0-1. */
  capPct: number;
  /** Value above the cap, base currency. */
  excessBase: number;
  /** Suggested sale as a percentage of the position, 1-100 (whole percent). */
  trimPercent: number;
  /** Base-currency proceeds the suggested trim would raise. */
  trimBase: number;
  /** Units the suggested trim would sell (whole units unless fractional). */
  trimQuantity: number;
  /** Weight after the suggested trim, 0-1. */
  weightAfter: number;
};

export type ConcentrationRiskImpact = {
  /** Herfindahl index of position weights (cash excluded) before/after. */
  hhiBefore: number;
  hhiAfter: number;
  /** Largest single-name weight before/after, 0-1. */
  topWeightBefore: number;
  topWeightAfter: number;
  /**
   * NAV hit if every breaching name fell 10% — the plain-English version of
   * "how much does this concentration actually cost you on a bad day".
   */
  shockLossBefore: number;
  shockLossAfter: number;
  /** Total proceeds moved to cash by acting on every suggestion. */
  totalTrimBase: number;
};

export type ConcentrationAlert = {
  capPct: number;
  nav: number;
  breaches: ConcentrationBreach[];
  impact: ConcentrationRiskImpact;
};

/** The down-move used to express concentration risk in money terms. */
export const SHOCK_MOVE = 0.1;

function hhi(values: number[], denom: number): number {
  if (denom <= 0) return 0;
  return values.reduce((s, v) => s + (v / denom) ** 2, 0);
}

/**
 * Build the concentration prompt. Returns `null` when nothing breaches, so
 * callers can render nothing without extra checks.
 */
export function buildConcentrationAlert(input: {
  positions: ConcentrationPosition[];
  /** Total portfolio value including cash, base currency. */
  nav: number;
  /** Cap as a fraction of NAV. Defaults to the engine's 15%. */
  capPct?: number;
}): ConcentrationAlert | null {
  const capPct = input.capPct ?? DEFAULT_CONCENTRATION_CAP;
  const nav = Number(input.nav);
  if (!Number.isFinite(nav) || nav <= 0 || capPct <= 0) return null;

  const positions = input.positions.filter(
    (p) => Number.isFinite(p.valueBase) && p.valueBase > 0 && p.quantity > 0,
  );
  if (!positions.length) return null;

  // Trim target sits a buffer inside the cap, but never below zero and never
  // above the cap itself.
  const targetPct = Math.max(0, Math.min(capPct, capPct - TRIM_BUFFER_PCT));

  const breaches: ConcentrationBreach[] = [];
  for (const p of positions) {
    const weight = p.valueBase / nav;
    if (weight <= capPct) continue;

    const targetValue = targetPct * nav;
    const trimBaseRaw = Math.max(0, p.valueBase - targetValue);
    // Whole percent, rounded up: a 23.4% trim rounds to 24% so the sale is
    // guaranteed to clear the cap rather than land a hair inside it.
    const trimPercent = Math.min(100, Math.max(1, Math.ceil((trimBaseRaw / p.valueBase) * 100)));

    const rawQty = p.quantity * (trimPercent / 100);
    const trimQuantity = p.fractional
      ? Math.floor(rawQty * 1e6) / 1e6
      : Math.floor(rawQty);
    // Report the impact of the sale that can actually be executed: for a
    // small position, whole-share rounding can move the achievable trim well
    // away from the ideal percentage.
    const executableFraction = p.quantity > 0 ? trimQuantity / p.quantity : 0;
    const trimBase = p.valueBase * executableFraction;

    breaches.push({
      holdingId: p.holdingId,
      symbol: p.symbol,
      quantity: p.quantity,
      valueBase: p.valueBase,
      weight,
      capPct,
      excessBase: p.valueBase - capPct * nav,
      trimPercent,
      trimBase,
      trimQuantity,
      weightAfter: (p.valueBase - trimBase) / nav,
    });
  }

  if (!breaches.length) return null;
  breaches.sort((a, b) => b.weight - a.weight);

  const trimBySymbol = new Map(breaches.map((b) => [b.holdingId, b.trimBase]));
  const valuesBefore = positions.map((p) => p.valueBase);
  const valuesAfter = positions.map(
    (p) => p.valueBase - (trimBySymbol.get(p.holdingId) ?? 0),
  );
  const investedBefore = valuesBefore.reduce((s, v) => s + v, 0);
  const investedAfter = valuesAfter.reduce((s, v) => s + v, 0);

  const totalTrimBase = breaches.reduce((s, b) => s + b.trimBase, 0);
  const shockLossBefore = breaches.reduce((s, b) => s + b.valueBase * SHOCK_MOVE, 0);
  const shockLossAfter = breaches.reduce(
    (s, b) => s + (b.valueBase - b.trimBase) * SHOCK_MOVE,
    0,
  );

  return {
    capPct,
    nav,
    breaches,
    impact: {
      hhiBefore: hhi(valuesBefore, investedBefore),
      hhiAfter: hhi(valuesAfter, investedAfter),
      topWeightBefore: Math.max(...valuesBefore) / nav,
      topWeightAfter: Math.max(...valuesAfter) / nav,
      shockLossBefore,
      shockLossAfter,
      totalTrimBase,
    },
  };
}

/** "23% of the position (~£712)" style summary for a breach. */
export function describeTrim(b: ConcentrationBreach): string {
  if (b.trimQuantity <= 0) {
    return `Position is ${(b.weight * 100).toFixed(1)}% of the portfolio but too small to trim in whole units.`;
  }
  return `Sell ${b.trimPercent}% (${b.trimQuantity} unit${b.trimQuantity === 1 ? "" : "s"}) to bring ${b.symbol} from ${(b.weight * 100).toFixed(1)}% back to about ${(b.weightAfter * 100).toFixed(1)}% of the portfolio.`;
}
