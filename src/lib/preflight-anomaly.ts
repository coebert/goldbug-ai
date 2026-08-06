// Anomaly detector for pre-flight refresh timings.
//
// A manual/hourly run spends its first seconds in pre-flight phases (Saxo token
// refresh, news, regime, symbol resolution, price refresh) before any portfolio
// ticks. When one of those phases silently degrades — a slow broker token
// endpoint, a stalling news feed — the run's fixed deadline gets eaten and
// portfolios are skipped for budget. The symptom shows up far from the cause.
//
// This module compares the latest run's phase timings against a rolling
// baseline of previous runs and names the single step worth investigating.
//
// Statistics: median + MAD (median absolute deviation) rather than mean/stddev,
// because run history is small and contains genuine outliers that would inflate
// a standard deviation and hide the next anomaly. Robust z = 0.6745*(x-med)/MAD.
//
// Pure and dependency-free so it is unit-testable without a database.

import type { PhaseTiming, RunPhase } from "@/lib/run-telemetry";

export type PhaseSample = { phase: RunPhase; ms: number };

export type PhaseBaseline = {
  phase: RunPhase;
  samples: number;
  medianMs: number;
  madMs: number;
  p90Ms: number;
};

export type PhaseAnomaly = {
  phase: RunPhase;
  ms: number;
  medianMs: number | null;
  /** Robust z-score vs the baseline; null when there is no usable baseline. */
  score: number | null;
  /** ms / medianMs, null without a baseline. */
  ratio: number | null;
  /** Share of the run budget this phase consumed (0-1). */
  budgetShare: number;
  severity: "ok" | "watch" | "slow" | "critical";
  reason: string;
};

export type PreflightAnomalyReport = {
  /** True when at least one phase is `slow` or `critical`. */
  anomalous: boolean;
  totalPreflightMs: number;
  preflightBudgetShare: number;
  phases: PhaseAnomaly[];
  /** The step to investigate first, if any. */
  culprit: PhaseAnomaly | null;
  headline: string;
  recommendation: string;
  /** How many historical runs backed the comparison. */
  baselineRuns: number;
};

/**
 * Noise floors for the RELATIVE (ratio/z-score) rules.
 *
 * A sub-second phase can easily double against its median — news ingestion at
 * 260ms vs a 117ms baseline is 2.2x, scores hard, and used to be reported as a
 * "Pre-flight anomaly". That is measurement noise, not a run risk: no phase
 * that finishes this fast can eat the deadline. Relative flags therefore need
 * BOTH a meaningful absolute duration and a meaningful absolute regression.
 * Absolute ceilings and budget-share rules below are unaffected.
 */
export const MIN_RELATIVE_FLAG_MS = 1_500;
export const MIN_RELATIVE_DELTA_MS = 750;

/** Absolute "this is slow whatever the history says" ceilings, in ms. */
const ABSOLUTE_SLOW_MS: Record<RunPhase, number> = {
  saxo_refresh: 6_000,
  news: 12_000,
  regime: 6_000,
  symbols: 4_000,
  prices: 15_000,
  ticks: 30_000,
};

const PHASE_LABEL: Record<RunPhase, string> = {
  saxo_refresh: "Saxo token refresh",
  news: "news ingestion",
  regime: "market-regime computation",
  symbols: "symbol resolution",
  prices: "price refresh",
  ticks: "portfolio ticks",
};

const PHASE_HINT: Record<RunPhase, string> = {
  saxo_refresh:
    "Check the Saxo OAuth token age and 429 retry counts — a refresh that is retrying against rate limits blocks the whole run.",
  news:
    "Check feed fetch errors and per-feed latency; disable or backfill the slowest feeds rather than blocking the run on them.",
  regime:
    "Regime computation is CPU/query bound — check for a missing index on the price history query or an unusually wide lookback.",
  symbols:
    "Symbol resolution touches the universe and broker instrument lookups — check the blocklist query and any uncached instrument searches.",
  prices:
    "Price refresh is the usual deadline eater — check Yahoo fetch failures, the symbol count for this run, and price_cache hit rate.",
  ticks: "Individual portfolio ticks are slow — check per-portfolio tick durations and broker call counts.",
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Builds per-phase baselines from previous runs' phase timings. */
export function buildPhaseBaselines(history: PhaseSample[][]): Map<RunPhase, PhaseBaseline> {
  const byPhase = new Map<RunPhase, number[]>();
  for (const run of history) {
    for (const s of run) {
      if (!Number.isFinite(s.ms) || s.ms <= 0) continue; // skipped phases carry no signal
      const arr = byPhase.get(s.phase) ?? [];
      arr.push(s.ms);
      byPhase.set(s.phase, arr);
    }
  }
  const out = new Map<RunPhase, PhaseBaseline>();
  for (const [phase, xs] of byPhase) {
    const med = median(xs);
    const mad = median(xs.map((x) => Math.abs(x - med)));
    out.set(phase, { phase, samples: xs.length, medianMs: med, madMs: mad, p90Ms: percentile(xs, 90) });
  }
  return out;
}

export function robustScore(ms: number, base: PhaseBaseline): number | null {
  if (base.samples < 3 || base.medianMs <= 0) return null;
  // MAD can be 0 for very stable phases; fall back to a 10% floor so a stable
  // 200ms phase jumping to 3s still scores, without dividing by zero.
  const scale = Math.max(base.madMs, base.medianMs * 0.1);
  return (0.6745 * (ms - base.medianMs)) / scale;
}

/** Minimum runs of history before score-based flags are trusted. */
export const MIN_BASELINE_RUNS = 3;

export function analyzePreflight(input: {
  /** Phase timings of the run being judged. */
  phases: PhaseTiming[];
  /** Phase timings of previous runs, most recent first (excludes the current run). */
  history: PhaseSample[][];
  /** Run budget in ms; used for the budget-share signal. */
  budgetMs: number;
}): PreflightAnomalyReport {
  const budgetMs = input.budgetMs > 0 ? input.budgetMs : 1;
  const baselines = buildPhaseBaselines(input.history);
  const active = input.phases.filter((p) => !p.skipped && p.phase !== "ticks");
  const totalPreflightMs = active.reduce((a, p) => a + Math.max(0, p.ms), 0);

  const analyzed: PhaseAnomaly[] = active.map((p) => {
    const base = baselines.get(p.phase) ?? null;
    const score = base ? robustScore(p.ms, base) : null;
    const ratio = base && base.medianMs > 0 ? p.ms / base.medianMs : null;
    const budgetShare = p.ms / budgetMs;

    let severity: PhaseAnomaly["severity"] = "ok";
    const reasons: string[] = [];

    // Relative rules only apply once the step is slow enough in absolute terms
    // for a regression to matter to the run's deadline.
    const relativeEligible =
      p.ms >= MIN_RELATIVE_FLAG_MS &&
      (base === null || p.ms - base.medianMs >= MIN_RELATIVE_DELTA_MS);

    if (score !== null && ratio !== null && relativeEligible) {
      if (score >= 6 && ratio >= 2) {
        severity = "critical";
        reasons.push(`${ratio.toFixed(1)}x its usual ${Math.round(base!.medianMs)}ms`);
      } else if (score >= 3.5 && ratio >= 1.5) {
        severity = "slow";
        reasons.push(`${ratio.toFixed(1)}x its usual ${Math.round(base!.medianMs)}ms`);
      } else if (score >= 2) {
        severity = "watch";
        reasons.push(`drifting above its usual ${Math.round(base!.medianMs)}ms`);
      }
    }

    if (p.ms >= ABSOLUTE_SLOW_MS[p.phase]) {
      reasons.push(`over the ${Math.round(ABSOLUTE_SLOW_MS[p.phase] / 1000)}s ceiling for this step`);
      severity = severity === "critical" ? "critical" : "slow";
    }
    if (budgetShare >= 0.4) {
      reasons.push(`ate ${Math.round(budgetShare * 100)}% of the run budget`);
      severity = "critical";
    } else if (budgetShare >= 0.25 && severity === "ok") {
      severity = "watch";
      reasons.push(`used ${Math.round(budgetShare * 100)}% of the run budget`);
    }
    if (p.note === "failed") {
      reasons.push("the step failed");
      severity = severity === "ok" ? "watch" : severity;
    }

    return {
      phase: p.phase,
      ms: p.ms,
      medianMs: base?.medianMs ?? null,
      score,
      ratio,
      budgetShare,
      severity,
      reason: reasons.join("; ") || "within normal range",
    };
  });

  const rank: Record<PhaseAnomaly["severity"], number> = { ok: 0, watch: 1, slow: 2, critical: 3 };
  const sorted = [...analyzed].sort(
    (a, b) => rank[b.severity] - rank[a.severity] || b.ms - a.ms,
  );
  const worst = sorted[0] ?? null;
  const culprit = worst && rank[worst.severity] >= 1 ? worst : null;
  const anomalous = analyzed.some((p) => rank[p.severity] >= 2);
  const preflightBudgetShare = totalPreflightMs / budgetMs;
  const baselineRuns = input.history.length;

  let headline: string;
  let recommendation: string;
  if (!culprit) {
    headline =
      baselineRuns < MIN_BASELINE_RUNS
        ? `Pre-flight took ${(totalPreflightMs / 1000).toFixed(1)}s — baseline still building (${baselineRuns} run${baselineRuns === 1 ? "" : "s"}).`
        : `Pre-flight took ${(totalPreflightMs / 1000).toFixed(1)}s — normal for this run.`;
    recommendation = "No step stands out. Nothing to investigate.";
  } else {
    const label = PHASE_LABEL[culprit.phase];
    headline =
      `${culprit.severity === "critical" ? "Pre-flight anomaly" : culprit.severity === "slow" ? "Slow pre-flight step" : "Pre-flight drift"}: ` +
      `${label} took ${(culprit.ms / 1000).toFixed(1)}s (${culprit.reason}).`;
    recommendation = `Investigate ${label} first. ${PHASE_HINT[culprit.phase]}`;
    if (preflightBudgetShare >= 0.5) {
      recommendation +=
        ` Pre-flight consumed ${Math.round(preflightBudgetShare * 100)}% of the run budget, so portfolio ticks are at risk of being skipped — consider disabling pre-flight refresh for manual runs until this is fixed.`;
    }
  }

  return {
    anomalous,
    totalPreflightMs,
    preflightBudgetShare,
    phases: analyzed,
    culprit,
    headline,
    recommendation,
    baselineRuns,
  };
}

export function phaseLabel(p: RunPhase): string {
  return PHASE_LABEL[p];
}
