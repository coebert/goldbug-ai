// Correlated execution shocks: what happens when fills go wrong *together*.
//
// `execution-monte-carlo.ts` draws every fill independently. That understates
// joint risk badly: in a real stress bar (gap open, index-level vol spike,
// liquidity withdrawal) every symbol widens at once and every order struggles
// to complete at once, so a portfolio-wide rebalance pays the bad tail on all
// legs simultaneously instead of averaging it away across names.
//
// This module adds two coupling mechanisms on top of the same lognormal /
// fill-ratio primitives:
//
//   1. A per-bar common factor. Each symbol's log-slippage is
//        sqrt(rho) * Z_market + sqrt(1 - rho) * Z_symbol
//      so `rho` is literally the pairwise correlation of log slippage across
//      symbols on the same bar. rho = 0 reproduces the independent sampler.
//
//   2. A persistent stress regime (2-state Markov chain, so stress arrives in
//      clusters rather than as isolated bars) that widens slippage, raises
//      the no-fill probability, and cuts the full-fill probability for *every*
//      symbol on the bar. Realised volatility can force the regime on, so the
//      shock lands where the tape is actually violent rather than at random.
//
// Everything stays pure and seeded: same seed and same bar sequence produce
// the same shocks, so joint worst-case numbers are reproducible.

import {
  factorWeights,
  makeCorrelationStructure,
  type CorrelationStructure,
} from "./execution-correlation-structures";
import {
  DEFAULT_EXECUTION_SIM,
  mulberry32,
  standardNormal,
  type ExecutionDraw,
  type ExecutionSimConfig,
} from "./execution-monte-carlo";


export type CorrelatedExecutionConfig = ExecutionSimConfig & {
  /** Pairwise correlation of log-slippage across symbols on the same bar, 0…1. */
  rho: number;
  /**
   * Optional alternative coupling assumption (sector blocks, contagion, …).
   * When set it fully replaces the single global `rho`; see
   * `execution-correlation-structures.ts`.
   */
  structure?: CorrelationStructure;

  /** Probability a calm bar turns stressed (before the volatility override). */
  stressEnterProb: number;
  /** Probability a stressed bar returns to calm — 1/this is the mean stress length. */
  stressExitProb: number;
  /** Slippage multiplier applied to every symbol on a stressed bar. */
  stressSlippageMult: number;
  /** Extra log-slippage dispersion during stress (regimes are wilder, not just worse). */
  stressSigmaMult: number;
  /** No-fill probability multiplier during stress. */
  stressNoFillMult: number;
  /** Full-fill probability multiplier during stress (liquidity is thinner). */
  stressFullFillMult: number;
  /**
   * Realised-volatility z-score at or above which the bar is forced stressed,
   * regardless of the Markov draw. Set to Infinity to disable.
   */
  volStressZ: number;
  /** Extra slippage per unit of volatility z-score above `volStressZ`. */
  volSlippageBeta: number;
};

export const DEFAULT_CORRELATED_EXECUTION: CorrelatedExecutionConfig = {
  ...DEFAULT_EXECUTION_SIM,
  rho: 0.5,
  stressEnterProb: 0.03,
  stressExitProb: 0.2,
  stressSlippageMult: 2.5,
  stressSigmaMult: 1.6,
  stressNoFillMult: 4,
  stressFullFillMult: 0.6,
  volStressZ: 1.5,
  volSlippageBeta: 0.35,
};

export type BarRegime = {
  stressed: boolean;
  /** Volatility z-score supplied for the bar (0 when not provided). */
  volZ: number;
  /** Common slippage factor draw for the bar, in log space. */
  commonZ: number;
  /** Deterministic slippage multiplier applied to every symbol on this bar. */
  regimeMult: number;
};

export type CorrelatedExecutionSampler = {
  /**
   * Opens a new bar: rolls the regime transition and the common factor.
   * Call once per bar, before drawing any orders for that bar.
   * `volZ` is the cross-sectional realised-volatility z-score of the tape.
   */
  beginBar: (volZ?: number) => BarRegime;
  /** Draws one order's execution on the current bar. */
  draw: () => ExecutionDraw;
  /** The current bar's regime (before `beginBar`, a calm placeholder). */
  regime: () => BarRegime;
  /** Fraction of bars so far that were stressed. */
  stressShare: () => number;
};

const CALM: BarRegime = { stressed: false, volZ: 0, commonZ: 0, regimeMult: 1 };

export function makeCorrelatedExecutionSampler(
  cfg: Partial<CorrelatedExecutionConfig>,
  seed: number,
): CorrelatedExecutionSampler {
  const c = { ...DEFAULT_CORRELATED_EXECUTION, ...cfg };
  const rho = Math.min(1, Math.max(0, c.rho));
  const wCommon = Math.sqrt(rho);
  const wIdio = Math.sqrt(1 - rho);
  const rng = mulberry32(seed);

  let bar: BarRegime = CALM;
  let bars = 0;
  let stressedBars = 0;

  const beginBar = (volZ = 0): BarRegime => {
    const z = Number.isFinite(volZ) ? volZ : 0;
    // Markov persistence: stress clusters instead of flickering bar to bar.
    const roll = rng();
    let stressed = bar.stressed ? roll >= c.stressExitProb : roll < c.stressEnterProb;
    // A violent tape forces the stressed regime on regardless of the draw.
    if (z >= c.volStressZ) stressed = true;

    const volExcess = Math.max(0, z - c.volStressZ);
    const regimeMult = (stressed ? c.stressSlippageMult : 1) * (1 + c.volSlippageBeta * volExcess);

    bar = { stressed, volZ: z, commonZ: standardNormal(rng), regimeMult };
    bars++;
    if (stressed) stressedBars++;
    return bar;
  };

  const draw = (): ExecutionDraw => {
    const sigma = c.slippageSigma * (bar.stressed ? c.stressSigmaMult : 1);
    // Common + idiosyncratic decomposition: rho is the cross-symbol correlation.
    const z = wCommon * bar.commonZ + wIdio * standardNormal(rng);
    let mult = Math.exp(z * sigma) * bar.regimeMult;
    if (rng() < c.tailProb) mult *= c.tailMult;
    mult = Math.min(c.maxSlippageMult, Math.max(0, mult));

    const noFill = Math.min(1, c.noFillProb * (bar.stressed ? c.stressNoFillMult : 1));
    const fullFill = Math.max(0, Math.min(1 - noFill, c.fullFillProb * (bar.stressed ? c.stressFullFillMult : 1)));
    const partial = Math.max(0, 1 - noFill - fullFill);

    let fillRatio = 1;
    const u = rng();
    if (u < noFill) fillRatio = 0;
    else if (u < noFill + partial) fillRatio = c.minFillRatio + rng() * (1 - c.minFillRatio);
    return { slippageMult: mult, fillRatio };
  };

  return {
    beginBar,
    draw,
    regime: () => bar,
    stressShare: () => (bars ? stressedBars / bars : 0),
  };
}

// ------------------------------------------------ realised-volatility z-score

/**
 * Cross-sectional realised-volatility z-score per bar for a set of price
 * series: average trailing `window`-bar return stdev across symbols, expressed
 * in standard deviations of its own history. Used to point the stress regime
 * at the bars where the tape was genuinely violent.
 */
export function marketVolZScores(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  window = 20,
): number[] {
  const series = [...seriesBySymbol.values()].filter((s) => s.length > 1);
  if (!series.length) return [];
  const n = Math.min(...series.map((s) => s.length));

  const avgVol: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (const s of series) {
      const start = Math.max(1, i - window + 1);
      if (i - start < 2) continue;
      const rets: number[] = [];
      for (let k = start; k <= i; k++) {
        const prev = s[k - 1]!;
        if (prev > 0) rets.push(s[k]! / prev - 1);
      }
      if (rets.length < 3) continue;
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
      sum += Math.sqrt(v);
      count++;
    }
    avgVol[i] = count ? sum / count : 0;
  }

  const usable = avgVol.filter((v) => v > 0);
  if (usable.length < 2) return new Array(n).fill(0);
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const sd = Math.sqrt(
    usable.reduce((a, b) => a + (b - mean) ** 2, 0) / (usable.length - 1),
  );
  if (!(sd > 0)) return new Array(n).fill(0);
  return avgVol.map((v) => (v > 0 ? (v - mean) / sd : 0));
}
