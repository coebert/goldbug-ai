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
  regimeRamp,
  regimeRhos,
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

  /**
   * How the coupling parameters move between the calm and stress structures.
   *   "binary" — a bar is either calm or stressed (the original behaviour).
   *   "ramp"   — the structure blends continuously with realised volatility
   *              between `regimeRampLoZ` and `regimeRampHiZ`, so correlation
   *              drifts up as the tape heats and back down as it cools.
   */
  regimeBlend: "binary" | "ramp";
  /** Volatility z-score at which the ramp starts leaving the calm structure. */
  regimeRampLoZ: number;
  /** Volatility z-score at which the ramp reaches the full stress structure. */
  regimeRampHiZ: number;
  /** Minimum blend applied once the Markov chain says the bar is stressed. */
  stressBlendFloor: number;

  /**
   * Symbols exempted from the shock process: they draw purely idiosyncratic
   * slippage at calm parameters, ignoring the market/cluster factors and the
   * stress regime. The regime still rolls and the same random numbers are
   * consumed in the same order, so a decoupled run stays perfectly paired with
   * the base run — which is what makes leave-one-cluster-out tail attribution
   * (`execution-cluster-spillover.ts`) an apples-to-apples comparison.
   */
  decoupledSymbols?: ReadonlySet<string>;
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
  regimeBlend: "binary",
  regimeRampLoZ: 0.5,
  regimeRampHiZ: 2,
  stressBlendFloor: 1,
};

export type BarRegime = {
  stressed: boolean;
  /** Volatility z-score supplied for the bar (0 when not provided). */
  volZ: number;
  /** Common slippage factor draw for the bar, in log space. */
  commonZ: number;
  /** Per-cluster factor draws for the bar, in log space (empty for a global rho). */
  clusterZ: ReadonlyMap<string, number>;
  /** Deterministic slippage multiplier applied to every symbol on this bar. */
  regimeMult: number;
  /** Blend between the calm (0) and stress (1) coupling structures. */
  stressT: number;
  /** Same-cluster correlation actually in force on this bar. */
  withinRho: number;
  /** Cross-cluster correlation actually in force on this bar. */
  acrossRho: number;
};

export type CorrelatedExecutionSampler = {
  /**
   * Opens a new bar: rolls the regime transition and the common factor.
   * Call once per bar, before drawing any orders for that bar.
   * `volZ` is the cross-sectional realised-volatility z-score of the tape.
   */
  beginBar: (volZ?: number) => BarRegime;
  /**
   * Draws one order's execution on the current bar. Pass the symbol when a
   * clustered structure is configured so the right cluster factor is used;
   * omitting it treats the order as unclustered.
   */
  draw: (symbol?: string) => ExecutionDraw;
  /** The current bar's regime (before `beginBar`, a calm placeholder). */
  regime: () => BarRegime;
  /** Fraction of bars so far that were stressed. */
  stressShare: () => number;
  /**
   * Per-bar history of the regime blend and the coupling it implied, so tail
   * sensitivity can be tracked over time rather than assumed constant.
   */
  regimePath: () => readonly BarRegime[];
};

const CALM: BarRegime = {
  stressed: false,
  volZ: 0,
  commonZ: 0,
  clusterZ: new Map(),
  regimeMult: 1,
  stressT: 0,
  withinRho: 0,
  acrossRho: 0,
};

export function makeCorrelatedExecutionSampler(
  cfg: Partial<CorrelatedExecutionConfig>,
  seed: number,
): CorrelatedExecutionSampler {
  const c = { ...DEFAULT_CORRELATED_EXECUTION, ...cfg };
  // A bare `rho` is just the single-factor special case of a structure.
  const structure = c.structure
    ?? makeCorrelationStructure({ kind: "global", rho: c.rho });
  const clusters = [...new Set([...structure.groups.values(), "other"])].sort();
  const rng = mulberry32(seed);
  // Cluster factors come off their own stream so that swapping the structure
  // does not shift the main stream: paths stay comparable across assumptions.
  const clusterRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const weightCache = new Map<string, ReturnType<typeof factorWeights>>();
  // Quantise the blend so the cache stays small; 1% of correlation is far
  // below the resolution of anything this simulation claims to measure.
  const weightsFor = (symbol: string, stressT: number) => {
    const q = Math.round(stressT * 100) / 100;
    const key = `${q}|${symbol}`;
    let w = weightCache.get(key);
    if (!w) {
      w = factorWeights(structure, symbol, q);
      weightCache.set(key, w);
    }
    return w;
  };

  let bar: BarRegime = { ...CALM, ...regimeRhos(structure, 0) };
  let bars = 0;
  let stressedBars = 0;
  const path: BarRegime[] = [];

  const beginBar = (volZ = 0): BarRegime => {
    const z = Number.isFinite(volZ) ? volZ : 0;
    // Markov persistence: stress clusters instead of flickering bar to bar.
    const roll = rng();
    let stressed = bar.stressed ? roll >= c.stressExitProb : roll < c.stressEnterProb;
    // A violent tape forces the stressed regime on regardless of the draw.
    if (z >= c.volStressZ) stressed = true;

    const volExcess = Math.max(0, z - c.volStressZ);
    const regimeMult = (stressed ? c.stressSlippageMult : 1) * (1 + c.volSlippageBeta * volExcess);

    const clusterZ = new Map<string, number>();
    for (const g of clusters) clusterZ.set(g, standardNormal(clusterRng));

    // Regime-dependent coupling: binary keeps the hard calm/stress switch,
    // ramp lets the structure migrate with realised volatility and floors the
    // blend once the Markov chain has declared the bar stressed.
    const stressT = c.regimeBlend === "ramp"
      ? Math.max(
          regimeRamp(z, c.regimeRampLoZ, c.regimeRampHiZ),
          stressed ? Math.min(1, Math.max(0, c.stressBlendFloor)) : 0,
        )
      : (stressed ? 1 : 0);
    const { withinRho, acrossRho } = regimeRhos(structure, stressT);

    bar = {
      stressed,
      volZ: z,
      commonZ: standardNormal(rng),
      clusterZ,
      regimeMult,
      stressT,
      withinRho,
      acrossRho,
    };
    bars++;
    if (stressed) stressedBars++;
    path.push(bar);
    return bar;
  };

  const decoupled = c.decoupledSymbols;
  // Decoupled symbols draw their (calm, idiosyncratic) outcome off a side
  // stream while still consuming exactly the numbers the coupled run would
  // have consumed from the main stream. That keeps every *other* symbol on
  // the path bit-identical, which is what makes leave-one-cluster-out
  // attribution a like-for-like comparison instead of a reshuffle.
  const offRng = mulberry32((seed ^ 0x2545f491) >>> 0);
  const draw = (symbol?: string): ExecutionDraw => {
    const off = decoupled ? decoupled.has(symbol ?? "") : false;
    const stressed = bar.stressed;
    const sigma = c.slippageSigma * (stressed ? c.stressSigmaMult : 1);
    // Market + cluster + idiosyncratic decomposition. With a global structure
    // the cluster loading is zero and this reduces to the original two terms.
    const w = weightsFor(symbol ?? "", bar.stressT);
    const gz = bar.clusterZ.get(w.group) ?? 0;
    const idioZ = standardNormal(rng);
    const z = w.market * bar.commonZ + w.cluster * gz + w.idio * idioZ;
    let mult = Math.exp(z * sigma) * bar.regimeMult;
    if (rng() < c.tailProb) mult *= c.tailMult;
    mult = Math.min(c.maxSlippageMult, Math.max(0, mult));

    const noFill = Math.min(1, c.noFillProb * (stressed ? c.stressNoFillMult : 1));
    const fullFill = Math.max(0, Math.min(1 - noFill, c.fullFillProb * (stressed ? c.stressFullFillMult : 1)));
    const partial = Math.max(0, 1 - noFill - fullFill);

    let fillRatio = 1;
    const u = rng();
    if (u < noFill) fillRatio = 0;
    else if (u < noFill + partial) fillRatio = c.minFillRatio + rng() * (1 - c.minFillRatio);
    if (!off) return { slippageMult: mult, fillRatio };

    // Same order, no shared factors, no stress amplification.
    let offMult = Math.exp(standardNormal(offRng) * c.slippageSigma);
    if (offRng() < c.tailProb) offMult *= c.tailMult;
    offMult = Math.min(c.maxSlippageMult, Math.max(0, offMult));
    const offNoFill = Math.min(1, c.noFillProb);
    const offFull = Math.max(0, Math.min(1 - offNoFill, c.fullFillProb));
    const offPartial = Math.max(0, 1 - offNoFill - offFull);
    let offRatio = 1;
    const ou = offRng();
    if (ou < offNoFill) offRatio = 0;
    else if (ou < offNoFill + offPartial) offRatio = c.minFillRatio + offRng() * (1 - c.minFillRatio);
    return { slippageMult: offMult, fillRatio: offRatio };
  };


  return {
    beginBar,
    draw,
    regime: () => bar,
    stressShare: () => (bars ? stressedBars / bars : 0),
    regimePath: () => path,
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
