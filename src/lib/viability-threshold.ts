// Viability threshold: flag configurations that fall below the breakeven point
// at each risk level.
//
// Breakeven is where the fitted net-CAGR line crosses zero as turnover rises —
// past it, every extra trade costs more in commission, spread and tax than the
// edge it captures. A configuration is viable at a risk level when it clears
// that turnover breakeven *and* still earns a minimum net return after costs.
//
// Pure functions only: no IO, no clock, no randomness.

import { slope, type ParamSet } from "./turnover-attribution";

export type ViabilityRiskLevel = string;

export type ViabilityMetrics = {
  tradesPerYear: number;
  cagrPct: number;
  feeDragPct: number;
  maxDrawdownPct?: number;
  sharpe?: number;
};

export type ViabilityRow = {
  /** Stable label for the configuration (usually formatParams). */
  id: string;
  riskLevel: ViabilityRiskLevel;
  params: ParamSet;
  metrics: ViabilityMetrics;
  check?: { feasible: boolean; disqualified: boolean };
};

export type ViabilityOptions = {
  /** Minimum acceptable net CAGR after costs (pp). Default 0. */
  minCagrPct?: number;
  /**
   * Explicit turnover breakeven per risk level. When absent it is fitted from
   * that level's own candidates.
   */
  breakevenOverride?: Record<ViabilityRiskLevel, number>;
  /**
   * Width of the "marginal" band around a threshold, as a fraction of the
   * breakeven turnover. Default 0.1 (±10%).
   */
  marginalBand?: number;
  /** Minimum candidates needed to fit a breakeven. Default 3. */
  minSampleToFit?: number;
  /** Include disqualified candidates (borrow/short/leverage). Default false. */
  includeDisqualified?: boolean;
};

export const VIABILITY_DEFAULTS = {
  minCagrPct: 0,
  marginalBand: 0.1,
  minSampleToFit: 3,
} as const;

export type ViabilityThreshold = {
  riskLevel: ViabilityRiskLevel;
  /** Turnover at which net CAGR is fitted to hit zero. null when unfittable. */
  breakevenTradesPerYear: number | null;
  /** Where the threshold came from. */
  source: "override" | "fitted" | "none";
  /** Net CAGR change (pp) per extra trade/yr at this risk level. */
  cagrPerTrade: number;
  minCagrPct: number;
  /** Candidates used to fit. */
  n: number;
};

export type ViabilityVerdict = "viable" | "marginal" | "below_breakeven" | "unknown";

export type ViabilityAssessment = {
  id: string;
  riskLevel: ViabilityRiskLevel;
  params: ParamSet;
  metrics: ViabilityMetrics;
  verdict: ViabilityVerdict;
  /** breakeven − turnover: positive means room to trade more. */
  turnoverHeadroom: number | null;
  /** Net CAGR above the minimum acceptable return (pp). */
  returnMarginPct: number;
  reasons: string[];
};

export type RiskLevelViability = {
  riskLevel: ViabilityRiskLevel;
  threshold: ViabilityThreshold;
  assessments: ViabilityAssessment[];
  flagged: ViabilityAssessment[];
  viableCount: number;
  marginalCount: number;
  belowCount: number;
  /** Share of assessed configurations that are viable (0..1). */
  viableShare: number;
  /** Best viable configuration by net CAGR, if any. */
  bestViable: ViabilityAssessment | null;
};

export type ViabilityReport = {
  levels: RiskLevelViability[];
  totalFlagged: number;
  totalAssessed: number;
  /** Configurations that fail at every risk level where they were evaluated. */
  universallyBelow: string[];
};

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function poolFor(rows: readonly ViabilityRow[], opts: ViabilityOptions): ViabilityRow[] {
  return opts.includeDisqualified ? [...rows] : rows.filter((r) => !r.check?.disqualified);
}

/**
 * Fit the turnover breakeven for one risk level, or take the override. The fit
 * is the zero crossing of net CAGR regressed on trades/yr; with too few points
 * or a flat/positive-forever line there is no crossing and the threshold is
 * reported as `none` rather than guessed.
 */
export function deriveThreshold(
  rows: readonly ViabilityRow[],
  riskLevel: ViabilityRiskLevel,
  opts: ViabilityOptions = {},
): ViabilityThreshold {
  const minCagrPct = opts.minCagrPct ?? VIABILITY_DEFAULTS.minCagrPct;
  const minSample = opts.minSampleToFit ?? VIABILITY_DEFAULTS.minSampleToFit;
  const pool = poolFor(rows, opts).filter((r) => r.riskLevel === riskLevel);

  const override = opts.breakevenOverride?.[riskLevel];
  const x = pool.map((r) => r.metrics.tradesPerYear);
  const y = pool.map((r) => r.metrics.cagrPct);
  const cagrPerTrade = pool.length >= 2 ? slope(x, y) : 0;

  if (typeof override === "number" && Number.isFinite(override)) {
    return {
      riskLevel,
      breakevenTradesPerYear: override,
      source: "override",
      cagrPerTrade,
      minCagrPct,
      n: pool.length,
    };
  }

  if (pool.length < minSample || Math.abs(cagrPerTrade) < 1e-9) {
    return {
      riskLevel,
      breakevenTradesPerYear: null,
      source: "none",
      cagrPerTrade,
      minCagrPct,
      n: pool.length,
    };
  }

  // Solve cagr(x) = minCagrPct for x.
  const intercept = mean(y) - cagrPerTrade * mean(x);
  const crossing = (minCagrPct - intercept) / cagrPerTrade;
  if (!Number.isFinite(crossing) || crossing < 0) {
    return {
      riskLevel,
      breakevenTradesPerYear: null,
      source: "none",
      cagrPerTrade,
      minCagrPct,
      n: pool.length,
    };
  }

  return {
    riskLevel,
    breakevenTradesPerYear: crossing,
    source: "fitted",
    cagrPerTrade,
    minCagrPct,
    n: pool.length,
  };
}

/**
 * Assess a single configuration against a risk level's threshold. A config is
 * flagged when it earns less than the minimum net return, or when it trades
 * past the breakeven turnover on a tape where churn is value-destroying.
 */
export function assessViability(
  row: ViabilityRow,
  threshold: ViabilityThreshold,
  opts: ViabilityOptions = {},
): ViabilityAssessment {
  const band = opts.marginalBand ?? VIABILITY_DEFAULTS.marginalBand;
  const minCagr = threshold.minCagrPct;
  const returnMarginPct = row.metrics.cagrPct - minCagr;
  const be = threshold.breakevenTradesPerYear;
  const headroom = be === null ? null : be - row.metrics.tradesPerYear;
  const reasons: string[] = [];

  if (row.check?.disqualified) {
    reasons.push("disqualified by the simulator audit (borrow/short/leverage)");
  }

  let verdict: ViabilityVerdict = "viable";

  // Churn only matters when extra trades cost money on this tape.
  const churnCostly = threshold.cagrPerTrade < 0;
  if (be !== null && churnCostly && headroom !== null) {
    const tolerance = Math.abs(be) * band;
    if (headroom < -tolerance) {
      verdict = "below_breakeven";
      reasons.push(
        `turnover ${row.metrics.tradesPerYear.toFixed(0)}/yr exceeds the ` +
          `${be.toFixed(0)}/yr breakeven by ${Math.abs(headroom).toFixed(0)}`,
      );
    } else if (headroom < tolerance) {
      verdict = "marginal";
      reasons.push(`turnover sits within ${(band * 100).toFixed(0)}% of the breakeven`);
    }
  }

  if (returnMarginPct < 0) {
    verdict = "below_breakeven";
    reasons.push(
      `net CAGR ${row.metrics.cagrPct.toFixed(2)}% is below the ${minCagr.toFixed(2)}% floor`,
    );
  } else if (verdict === "viable" && returnMarginPct < Math.abs(minCagr) * band) {
    verdict = "marginal";
    reasons.push("net return only just clears the floor");
  }

  if (row.check?.disqualified) verdict = "below_breakeven";

  if (be === null && threshold.source === "none" && returnMarginPct >= 0) {
    verdict = "unknown";
    reasons.push("no breakeven could be fitted at this risk level");
  }

  return {
    id: row.id,
    riskLevel: row.riskLevel,
    params: row.params,
    metrics: row.metrics,
    verdict,
    turnoverHeadroom: headroom,
    returnMarginPct,
    reasons,
  };
}

/** Assess every configuration at one risk level. */
export function assessRiskLevel(
  rows: readonly ViabilityRow[],
  riskLevel: ViabilityRiskLevel,
  opts: ViabilityOptions = {},
): RiskLevelViability {
  const threshold = deriveThreshold(rows, riskLevel, opts);
  const pool = poolFor(rows, opts).filter((r) => r.riskLevel === riskLevel);
  const assessments = pool
    .map((r) => assessViability(r, threshold, opts))
    .sort((a, b) => b.metrics.cagrPct - a.metrics.cagrPct);

  const flagged = assessments.filter(
    (a) => a.verdict === "below_breakeven" || a.verdict === "marginal",
  );
  const viable = assessments.filter((a) => a.verdict === "viable");

  return {
    riskLevel,
    threshold,
    assessments,
    flagged,
    viableCount: viable.length,
    marginalCount: assessments.filter((a) => a.verdict === "marginal").length,
    belowCount: assessments.filter((a) => a.verdict === "below_breakeven").length,
    viableShare: assessments.length === 0 ? 0 : viable.length / assessments.length,
    bestViable: viable[0] ?? null,
  };
}

/**
 * Full report: one threshold per risk level plus the configurations that fail
 * everywhere they were tried — those are the ones to drop from the search space.
 */
export function buildViabilityReport(
  rows: readonly ViabilityRow[],
  opts: ViabilityOptions = {},
): ViabilityReport {
  const riskLevels = [...new Set(rows.map((r) => r.riskLevel))].sort();
  const levels = riskLevels.map((rl) => assessRiskLevel(rows, rl, opts));

  const seen = new Map<string, { total: number; below: number }>();
  for (const lvl of levels) {
    for (const a of lvl.assessments) {
      const rec = seen.get(a.id) ?? { total: 0, below: 0 };
      rec.total += 1;
      if (a.verdict === "below_breakeven") rec.below += 1;
      seen.set(a.id, rec);
    }
  }
  const universallyBelow = [...seen.entries()]
    .filter(([, v]) => v.total > 0 && v.below === v.total)
    .map(([id]) => id)
    .sort();

  return {
    levels,
    totalFlagged: levels.reduce((a, l) => a + l.flagged.length, 0),
    totalAssessed: levels.reduce((a, l) => a + l.assessments.length, 0),
    universallyBelow,
  };
}

/** One-line summary per risk level for the console/report. */
export function describeRiskLevelViability(l: RiskLevelViability): string {
  const be =
    l.threshold.breakevenTradesPerYear === null
      ? "no fitted breakeven"
      : `breakeven ${l.threshold.breakevenTradesPerYear.toFixed(0)}/yr (${l.threshold.source})`;
  return (
    `${l.riskLevel}: ${be} · ` +
    `${l.viableCount} viable / ${l.marginalCount} marginal / ${l.belowCount} below ` +
    `(${(l.viableShare * 100).toFixed(0)}% viable)` +
    (l.bestViable
      ? ` · best ${l.bestViable.metrics.cagrPct.toFixed(2)}% CAGR at ` +
        `${l.bestViable.metrics.tradesPerYear.toFixed(0)}/yr`
      : " · no viable configuration")
  );
}

export const VERDICT_LABEL: Record<ViabilityVerdict, string> = {
  viable: "viable",
  marginal: "marginal",
  below_breakeven: "below breakeven",
  unknown: "unknown",
};
