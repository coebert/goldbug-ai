// Alternative correlation structures for execution shocks.
//
// `execution-correlated-shocks.ts` couples every symbol through a single global
// factor: one ρ, applied uniformly. That is a strong assumption and, in a
// portfolio built from clusters (UK large-cap, US tech, gold, inverse hedges),
// usually the wrong one. Liquidity dries up by venue and by sector well before
// it dries up everywhere, and hedges are supposed to decouple precisely when
// everything else does not.
//
// This module makes the coupling assumption an explicit, swappable object so a
// joint drawdown tail can be re-estimated under each one:
//
//   independent  ρ = 0 everywhere — the naive baseline.
//   global       one ρ for every pair (the previous behaviour).
//   blocks       ρ_within inside a sector cluster, ρ_across between clusters.
//   contagion    blocks in calm, but correlations converge upward in stress —
//                the "diversification fails when you need it" assumption.
//
// All of them are the same three-term decomposition of log-slippage
//
//     Z_sym = a · Z_market + b · Z_group(sym) + c · Z_idio(sym)
//
// with a² = ρ_across, b² = ρ_within − ρ_across, c² = 1 − ρ_within, so the
// implied pairwise correlation is exactly ρ_within for same-cluster pairs and
// ρ_across otherwise. Keeping one decomposition means every structure consumes
// the same random numbers in the same order, so structures stay comparable
// path-by-path rather than only in distribution.

export type CorrelationStructureKind = "independent" | "global" | "blocks" | "contagion";

export type CorrelationStructure = {
  kind: CorrelationStructureKind;
  /** Correlation between two symbols in the same cluster. */
  withinRho: number;
  /** Correlation between symbols in different clusters. */
  acrossRho: number;
  /** Same-cluster correlation while the stress regime is on. */
  stressWithinRho: number;
  /** Cross-cluster correlation while the stress regime is on. */
  stressAcrossRho: number;
  /** symbol → cluster label. Unlisted symbols fall into "other". */
  groups: ReadonlyMap<string, string>;
};

export const UNGROUPED = "other";

/** Clamp to a valid correlation and keep across ≤ within (a block model needs it). */
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export type CorrelationStructureSpec = {
  kind: CorrelationStructureKind;
  rho?: number;
  withinRho?: number;
  acrossRho?: number;
  stressWithinRho?: number;
  stressAcrossRho?: number;
  groups?: ReadonlyMap<string, string> | Record<string, string>;
};

/**
 * Builds a fully specified structure from a partial spec, filling in the
 * defaults that make each `kind` mean what its name says.
 */
export function makeCorrelationStructure(spec: CorrelationStructureSpec): CorrelationStructure {
  const groups = spec.groups instanceof Map
    ? spec.groups
    : new Map(Object.entries((spec.groups ?? {}) as Record<string, string>));

  const rho = clamp01(spec.rho ?? 0.5);
  let within: number;
  let across: number;
  switch (spec.kind) {
    case "independent":
      within = 0;
      across = 0;
      break;
    case "global":
      within = rho;
      across = rho;
      break;
    case "blocks":
    case "contagion":
    default:
      within = clamp01(spec.withinRho ?? Math.min(1, rho * 1.5));
      across = clamp01(spec.acrossRho ?? rho * 0.4);
      break;
  }
  across = Math.min(across, within);

  // In stress, "independent" and "global" stay flat unless told otherwise;
  // "contagion" pulls both correlations toward 1.
  const stressDefault = spec.kind === "contagion"
    ? { w: Math.min(1, within + (1 - within) * 0.6), a: Math.min(1, across + (1 - across) * 0.7) }
    : { w: within, a: across };
  const stressWithin = clamp01(spec.stressWithinRho ?? stressDefault.w);
  const stressAcross = Math.min(clamp01(spec.stressAcrossRho ?? stressDefault.a), stressWithin);

  return {
    kind: spec.kind,
    withinRho: within,
    acrossRho: across,
    stressWithinRho: stressWithin,
    stressAcrossRho: stressAcross,
    groups,
  };
}

export const groupOf = (structure: CorrelationStructure, symbol: string): string =>
  structure.groups.get(symbol) ?? UNGROUPED;

/** Correlation the structure implies for a pair of symbols in a given regime. */
export function impliedCorrelation(
  structure: CorrelationStructure,
  a: string,
  b: string,
  stressed = false,
): number {
  if (a === b) return 1;
  const within = stressed ? structure.stressWithinRho : structure.withinRho;
  const across = stressed ? structure.stressAcrossRho : structure.acrossRho;
  return groupOf(structure, a) === groupOf(structure, b) ? within : across;
}

export type FactorWeights = {
  group: string;
  /** Loading on the market-wide factor. */
  market: number;
  /** Loading on the symbol's cluster factor. */
  cluster: number;
  /** Loading on the symbol's own noise. */
  idio: number;
};

/**
 * Factor loadings for one symbol. `market² = ρ_across`, `cluster² = ρ_within −
 * ρ_across`, `idio² = 1 − ρ_within`, so the three weights are unit-norm and the
 * implied pairwise correlations come out exactly as specified.
 */
export function factorWeights(
  structure: CorrelationStructure,
  symbol: string,
  stressed = false,
): FactorWeights {
  const within = stressed ? structure.stressWithinRho : structure.withinRho;
  const across = Math.min(stressed ? structure.stressAcrossRho : structure.acrossRho, within);
  return {
    group: groupOf(structure, symbol),
    market: Math.sqrt(across),
    cluster: Math.sqrt(Math.max(0, within - across)),
    idio: Math.sqrt(Math.max(0, 1 - within)),
  };
}

/** Full implied correlation matrix — handy for tests and for printing the assumption. */
export function correlationMatrix(
  structure: CorrelationStructure,
  symbols: readonly string[],
  stressed = false,
): number[][] {
  return symbols.map((a) => symbols.map((b) => impliedCorrelation(structure, a, b, stressed)));
}

/** One-line description for report headers. */
export function describeStructure(structure: CorrelationStructure): string {
  const clusters = new Set([...structure.groups.values()]);
  const base = `${structure.kind} (within ρ=${structure.withinRho.toFixed(2)}, `
    + `across ρ=${structure.acrossRho.toFixed(2)}`;
  const stressPart = structure.stressWithinRho !== structure.withinRho
    || structure.stressAcrossRho !== structure.acrossRho
    ? `; in stress ${structure.stressWithinRho.toFixed(2)}/${structure.stressAcrossRho.toFixed(2)}`
    : "";
  const clusterPart = clusters.size ? `, ${clusters.size} clusters` : "";
  return `${base}${stressPart}${clusterPart})`;
}

// ------------------------------------------------------------ sector mapping

/**
 * Cheap cluster labels for the backtest universe. Grouping is by what actually
 * shares a liquidity pool — venue and asset type — not by GICS sector: an LSE
 * tracker and a US mega-cap do not widen together just because both are equity.
 */
export function defaultCluster(symbol: string): string {
  const s = symbol.toUpperCase();
  if (/(GLD|SGLN|IAU|SLV|GOLD|PHAU)/.test(s)) return "metals";
  if (/(BTC|ETH|CRYPTO)/.test(s)) return "crypto";
  if (/^(XUKS|XSPS|SH|PSQ|IDBT)/.test(s)) return "inverse";
  if (/\.L$|:XLON|^(ISF|VUKE|VMID|EQQQ)/.test(s)) return "uk-equity";
  if (/^(SPY|VOO|IVV|QQQ|VTI|VWRL|IWM)/.test(s)) return "us-index";
  if (/^(AAPL|MSFT|NVDA|GOOGL|GOOG|AMZN|META|TSLA|AVGO|AMD)/.test(s)) return "us-tech";
  return "us-equity";
}

export function clusterMap(symbols: readonly string[]): Map<string, string> {
  return new Map(symbols.map((s) => [s, defaultCluster(s)]));
}
