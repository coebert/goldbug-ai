// Shock-generator ablation: which part of the shock process makes the tail?
//
// Every other comparison in this folder swaps the *correlation* assumption and
// holds the shock process fixed. That answers "how much does coupling matter"
// and nothing else, which leaves the obvious complementary question open: with
// the calibrated coupling pinned, how much of the simulated tail comes from
// lognormal dispersion, how much from the fat-tail jump, how much from partial
// and missed fills, and how much from the persistent stress regime?
//
// This module defines the ablation grid for that experiment. It only ever
// rewrites the shock-side fields of `CorrelatedExecutionConfig` — `rho`,
// `structure` and the regime-blend geometry are copied through untouched, so
// the calibrated correlations really are held fixed (there is a test for it).
//
// Two complementary views, because neither alone is honest when ingredients
// interact:
//
//   ladder       — start from a shock-free generator and switch ingredients on
//                  one at a time. Each row's delta is that ingredient's
//                  marginal cost *given* the ones already on.
//   leave-one-out — start from the full generator and switch one ingredient
//                  off. Each row's delta is what you'd save by removing it
//                  from the complete model.
//
// A big gap between an ingredient's ladder delta and its LOO delta means it
// interacts: it is cheap alone and expensive in company (or the reverse).
//
// Nothing here runs a simulation. The caller supplies measured metrics per arm
// so the same grid can be scored on any harness.

import type { CorrelatedExecutionConfig } from "./execution-correlated-shocks";

// ------------------------------------------------------------- the ingredients

/** Shock-side knobs an ablation may touch. Correlation fields are excluded. */
export type ShockOverrides = Partial<Pick<
  CorrelatedExecutionConfig,
  | "slippageSigma"
  | "tailProb"
  | "tailMult"
  | "fullFillProb"
  | "noFillProb"
  | "minFillRatio"
  | "stressEnterProb"
  | "stressExitProb"
  | "stressSlippageMult"
  | "stressSigmaMult"
  | "stressNoFillMult"
  | "stressFullFillMult"
  | "volStressZ"
  | "volSlippageBeta"
>>;

export type ShockIngredientKey =
  | "dispersion"
  | "fillRisk"
  | "fatTail"
  | "stressRegime"
  | "volForcing";

export type ShockIngredient = {
  key: ShockIngredientKey;
  label: string;
  /** What the ingredient represents in tape terms. */
  note: string;
  /** Config overrides that neutralise it, leaving everything else alone. */
  off: ShockOverrides;
};

/**
 * Ordered so the ladder builds from the mildest, most defensible assumption to
 * the most speculative: fills you always get at a noisy price, then fills you
 * sometimes don't get, then jumps, then a regime that clusters the bad ones,
 * then pointing that regime at the bars where the tape was genuinely violent.
 */
export const SHOCK_INGREDIENTS: readonly ShockIngredient[] = [
  {
    key: "dispersion",
    label: "lognormal dispersion",
    note: "bar-to-bar variation in the realised spread around the calibrated median",
    off: { slippageSigma: 0 },
  },
  {
    key: "fillRisk",
    label: "partial / missed fills",
    note: "orders that complete short or not at all and have to be retried",
    // The stress fill multipliers are part of this channel too: without them a
    // "no fill risk" arm still hands out 40% partials on every stressed bar.
    off: { fullFillProb: 1, noFillProb: 0, stressNoFillMult: 1, stressFullFillMult: 1 },
  },
  {
    key: "fatTail",
    label: "fat-tail jumps",
    note: "gap opens, news prints and auction imbalances multiplying one fill",
    off: { tailProb: 0 },
  },
  {
    key: "stressRegime",
    label: "persistent stress regime",
    note: "Markov clustering that widens and starves every symbol on the same bar",
    off: {
      stressEnterProb: 0,
      stressExitProb: 1,
      stressSlippageMult: 1,
      stressSigmaMult: 1,
      stressNoFillMult: 1,
      stressFullFillMult: 1,
    },
  },
  {
    key: "volForcing",
    label: "realised-vol forcing",
    note: "forcing stress on where trailing volatility actually spiked, plus its slippage beta",
    off: { volStressZ: Number.POSITIVE_INFINITY, volSlippageBeta: 0 },
  },
];

const byKey = new Map(SHOCK_INGREDIENTS.map((i) => [i.key, i]));

/** Neutralises every ingredient: deterministic-cost execution, complete fills. */
export function shockFreeOverrides(): ShockOverrides {
  return SHOCK_INGREDIENTS.reduce<ShockOverrides>((acc, i) => ({ ...acc, ...i.off }), {});
}

// --------------------------------------------------------------- the arms

export type ShockArmKind = "ladder" | "leave-one-out" | "reference";

export type ShockArm = {
  key: string;
  label: string;
  kind: ShockArmKind;
  /** Ingredients active in this arm. */
  active: readonly ShockIngredientKey[];
  /** The ingredient this arm isolates (added on the ladder, removed in LOO). */
  ingredient?: ShockIngredientKey;
  /** Shock-side overrides to merge over the run's base config. */
  overrides: ShockOverrides;
};

const overridesFor = (active: readonly ShockIngredientKey[]): ShockOverrides => {
  const on = new Set(active);
  return SHOCK_INGREDIENTS
    .filter((i) => !on.has(i.key))
    .reduce<ShockOverrides>((acc, i) => ({ ...acc, ...i.off }), {});
};

/**
 * The full grid: shock-free baseline, the cumulative ladder, then one
 * leave-one-out arm per ingredient. The last ladder rung and the "full" LOO
 * reference are the same configuration, so it is emitted once as `full`.
 *
 * `order` lets a caller re-rank the ladder (e.g. cheapest-first) without
 * touching the ingredient definitions.
 */
export function shockAblationArms(
  order: readonly ShockIngredientKey[] = SHOCK_INGREDIENTS.map((i) => i.key),
): ShockArm[] {
  const seq = order.filter((k) => byKey.has(k));
  const arms: ShockArm[] = [{
    key: "none",
    label: "shock-free",
    kind: "reference",
    active: [],
    overrides: overridesFor([]),
  }];

  const active: ShockIngredientKey[] = [];
  for (const key of seq) {
    active.push(key);
    const last = active.length === seq.length;
    arms.push({
      key: last ? "full" : `+${key}`,
      label: last ? "full generator" : `+ ${byKey.get(key)!.label}`,
      kind: last ? "reference" : "ladder",
      active: [...active],
      ingredient: key,
      overrides: overridesFor(active),
    });
  }

  for (const key of seq) {
    const rest = seq.filter((k) => k !== key);
    arms.push({
      key: `-${key}`,
      label: `full − ${byKey.get(key)!.label}`,
      kind: "leave-one-out",
      active: rest,
      ingredient: key,
      overrides: overridesFor(rest),
    });
  }
  return arms;
}

// --------------------------------------------------------------- the metrics

export type ShockMetricKey =
  | "medianReturnPct"
  | "p5ReturnPct"
  | "cvar5ReturnPct"
  | "medianDrawdownPct"
  | "worstDrawdownPct"
  | "breachProb"
  | "jointBreachProb"
  | "meanCost";

export type ShockMetrics = Record<ShockMetricKey, number>;

export type ShockArmResult = {
  arm: ShockArm;
  metrics: ShockMetrics;
};

/**
 * Metrics where a *lower* number is the worse outcome, so a delta's sign can be
 * translated into "this ingredient made the tail worse" consistently.
 */
const LOWER_IS_WORSE: Record<ShockMetricKey, boolean> = {
  medianReturnPct: true,
  p5ReturnPct: true,
  cvar5ReturnPct: true,
  medianDrawdownPct: true,
  worstDrawdownPct: true,
  breachProb: false,
  jointBreachProb: false,
  meanCost: false,
};

export type ShockDelta = {
  ingredient: ShockIngredientKey;
  label: string;
  /** metric → change caused by this arm relative to its comparison arm. */
  delta: ShockMetrics;
  /** metric → true when the change made the tail worse. */
  worse: Record<ShockMetricKey, boolean>;
};

export type ShockAblationReport = {
  results: readonly ShockArmResult[];
  /** Marginal effect of switching each ingredient on, in ladder order. */
  ladder: readonly ShockDelta[];
  /** Effect of removing each ingredient from the full generator (full − arm). */
  leaveOneOut: readonly ShockDelta[];
  /**
   * Ingredients ranked by importance on `focus`: the mean of |ladder delta| and
   * |LOO delta|, so an ingredient only scores highly if it matters both when
   * added early and when pulled out of the complete model.
   */
  ranking: readonly {
    ingredient: ShockIngredientKey;
    label: string;
    ladderDelta: number;
    looDelta: number;
    score: number;
    /** |ladder − LOO|: how much the ingredient's effect depends on the others. */
    interaction: number;
  }[];
  focus: ShockMetricKey;
};

const METRIC_KEYS = Object.keys(LOWER_IS_WORSE) as ShockMetricKey[];

const diff = (a: ShockMetrics, b: ShockMetrics): ShockMetrics => {
  const out = {} as ShockMetrics;
  for (const k of METRIC_KEYS) out[k] = a[k] - b[k];
  return out;
};

const worseFlags = (d: ShockMetrics): Record<ShockMetricKey, boolean> => {
  const out = {} as Record<ShockMetricKey, boolean>;
  for (const k of METRIC_KEYS) out[k] = LOWER_IS_WORSE[k] ? d[k] < 0 : d[k] > 0;
  return out;
};

/**
 * Turns measured per-arm metrics into marginal contributions.
 *
 * Ladder deltas are arm − previous rung; LOO deltas are full − arm, i.e. the
 * damage the ingredient does to the complete model (same sign convention as
 * the ladder, so the two columns are directly comparable).
 */
export function shockAblationReport(
  results: readonly ShockArmResult[],
  focus: ShockMetricKey = "worstDrawdownPct",
): ShockAblationReport {
  const chain = results.filter((r) => r.arm.kind !== "leave-one-out");
  const ladder: ShockDelta[] = [];
  for (let i = 1; i < chain.length; i++) {
    const cur = chain[i]!;
    const prev = chain[i - 1]!;
    if (!cur.arm.ingredient) continue;
    const delta = diff(cur.metrics, prev.metrics);
    ladder.push({
      ingredient: cur.arm.ingredient,
      label: byKey.get(cur.arm.ingredient)?.label ?? cur.arm.ingredient,
      delta,
      worse: worseFlags(delta),
    });
  }

  const full = results.find((r) => r.arm.key === "full");
  const leaveOneOut: ShockDelta[] = [];
  if (full) {
    for (const r of results) {
      if (r.arm.kind !== "leave-one-out" || !r.arm.ingredient) continue;
      const delta = diff(full.metrics, r.metrics);
      leaveOneOut.push({
        ingredient: r.arm.ingredient,
        label: byKey.get(r.arm.ingredient)?.label ?? r.arm.ingredient,
        delta,
        worse: worseFlags(delta),
      });
    }
  }

  const looBy = new Map(leaveOneOut.map((d) => [d.ingredient, d.delta[focus]]));
  const ladderBy = new Map(ladder.map((d) => [d.ingredient, d.delta[focus]]));
  const keys = [...new Set([...ladderBy.keys(), ...looBy.keys()])];
  const ranking = keys.map((ingredient) => {
    const l = ladderBy.get(ingredient) ?? Number.NaN;
    const o = looBy.get(ingredient) ?? Number.NaN;
    const parts = [l, o].filter(Number.isFinite);
    const score = parts.length
      ? parts.reduce((a, b) => a + Math.abs(b), 0) / parts.length
      : Number.NaN;
    return {
      ingredient,
      label: byKey.get(ingredient)?.label ?? ingredient,
      ladderDelta: l,
      looDelta: o,
      score,
      interaction: Number.isFinite(l) && Number.isFinite(o) ? Math.abs(l - o) : Number.NaN,
    };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));

  return { results, ladder, leaveOneOut, ranking, focus };
}

// --------------------------------------------------------------- formatting

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const signed = (v: number, d = 2) =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";

const COLS: readonly { key: ShockMetricKey; head: string; digits: number }[] = [
  { key: "medianReturnPct", head: "med ret%", digits: 2 },
  { key: "p5ReturnPct", head: "p5 ret%", digits: 2 },
  { key: "cvar5ReturnPct", head: "CVaR5%", digits: 2 },
  { key: "medianDrawdownPct", head: "med DD%", digits: 2 },
  { key: "worstDrawdownPct", head: "worstDD%", digits: 2 },
  { key: "breachProb", head: "P(breach)", digits: 3 },
  { key: "jointBreachProb", head: "∧stress", digits: 3 },
  { key: "meanCost", head: "cost£", digits: 0 },
];

const row = (label: string, cells: string[]) =>
  [label.padEnd(30), ...cells.map((c) => c.padStart(10))].join(" ");

const header = () => row("arm", COLS.map((c) => c.head));

export function formatShockAblation(report: ShockAblationReport): string {
  const lines: string[] = [];
  lines.push(header());
  lines.push("-".repeat(header().length));
  for (const r of report.results) {
    if (r.arm.kind === "leave-one-out") continue;
    lines.push(row(r.arm.label, COLS.map((c) => fmt(r.metrics[c.key], c.digits))));
  }
  const loo = report.results.filter((r) => r.arm.kind === "leave-one-out");
  if (loo.length) {
    lines.push("");
    lines.push("Leave-one-out (full generator with a single ingredient switched off)");
    for (const r of loo) {
      lines.push(row(r.arm.label, COLS.map((c) => fmt(r.metrics[c.key], c.digits))));
    }
  }

  if (report.ladder.length) {
    lines.push("");
    lines.push("Marginal effect of switching each ingredient ON (ladder order)");
    lines.push(header());
    for (const d of report.ladder) {
      lines.push(row(d.label, COLS.map((c) => signed(d.delta[c.key], c.digits))));
    }
  }
  if (report.leaveOneOut.length) {
    lines.push("");
    lines.push("Cost of each ingredient inside the full generator (full − without it)");
    lines.push(header());
    for (const d of report.leaveOneOut) {
      lines.push(row(d.label, COLS.map((c) => signed(d.delta[c.key], c.digits))));
    }
  }

  if (report.ranking.length) {
    lines.push("");
    lines.push(`Drivers of ${report.focus} (mean |Δ| across both views)`);
    lines.push(row("ingredient", ["ladder", "LOO", "score", "interact"]));
    for (const r of report.ranking) {
      lines.push(row(r.label, [
        signed(r.ladderDelta), signed(r.looDelta), fmt(r.score), fmt(r.interaction),
      ]));
    }
  }
  return lines.join("\n");
}
