// Tail-metric decomposition: what actually pays for the worst case?
//
// The shock ablation (`execution-shock-generators.ts`) splits the *generator*
// into its statistical ingredients. That answers "which random mechanism makes
// the tail", but it says nothing about the part of the tail we control: the
// rebalancing policy. A joint drawdown you suffer because the tape gapped is a
// different problem from one you suffer because your own ticket rules kept you
// trading through it.
//
// So this module uses a coarser, decision-relevant factorisation — three
// drivers, each of which maps to something you can either forecast or change:
//
//   volScaling      — the continuous, volatility-proportional part of the model:
//                     realised-vol forcing of the stress regime, vol-linked
//                     slippage beta, and the sigma multiplier. Damage here
//                     scales smoothly with how loud the tape is.
//   eventShocks     — the discrete part: fat-tail jumps and the persistent
//                     stress regime with its slippage/fill multipliers. Damage
//                     here arrives in lumps and is what "event risk" means.
//   rebalanceRules  — our own policy: the minimum-ticket floor and the rule
//                     that abandons a fill too small to carry its commission.
//                     Turning it "off" means a permissive, frictionless
//                     rebalancer that takes every trade at any size.
//
// The three interact (a ticket floor is harmless in a calm tape and expensive
// in a gapping one), so a solo ablation would mis-assign the overlap. We run
// the full 2^3 lattice on common random numbers and split each tail metric with
// Shapley values, reusing the machinery in `execution-attribution.ts` so the
// contributions add back to the measured total exactly.
//
// Nothing here simulates. The caller measures each arm and hands the metrics
// back, which keeps the grid testable and harness-agnostic.

import {
  channelSubsets,
  shapleyAttribution,
  subsetKey,
  type AttributionResult,
} from "./execution-attribution";
import type { ShockOverrides } from "./execution-shock-generators";

// ------------------------------------------------------------------ drivers

export const TAIL_DRIVERS = ["volScaling", "eventShocks", "rebalanceRules"] as const;
export type TailDriver = (typeof TAIL_DRIVERS)[number];

export const TAIL_DRIVER_NOTES: Record<TailDriver, string> = {
  volScaling:
    "vol-proportional damage: realised-vol forcing, vol slippage beta, stress sigma multiplier",
  eventShocks:
    "lumpy damage: fat-tail jumps plus the persistent stress regime and its fill/slippage multipliers",
  rebalanceRules:
    "our own policy: minimum-ticket floor and the abandon-tiny-fill rule",
};

/** Rebalance-policy knobs an arm may neutralise. */
export type RebalancePolicyOverrides = {
  /** Smallest notional we are willing to send. 0 = take any trade. */
  minTicket: number;
  /**
   * Fraction of the requested ticket below which a partial fill is thrown away
   * rather than kept. 0 = keep every scrap.
   */
  abandonPartialFraction: number;
};

export type TailDriverArm = {
  /** "" for the fully neutral baseline, else "volScaling+eventShocks"-style. */
  key: string;
  drivers: TailDriver[];
  label: string;
  /** Shock-side overrides that switch the *disabled* drivers off. */
  shock: ShockOverrides;
  policy: RebalancePolicyOverrides;
};

/** Shock fields that neutralise the volatility-proportional channel. */
export const VOL_SCALING_OFF: ShockOverrides = {
  // Infinity means the realised-vol z-score can never force the stress regime.
  volStressZ: Number.POSITIVE_INFINITY,
  volSlippageBeta: 0,
  stressSigmaMult: 1,
};

/** Shock fields that neutralise the discrete/event channel. */
export const EVENT_SHOCKS_OFF: ShockOverrides = {
  tailProb: 0,
  tailMult: 1,
  stressEnterProb: 0,
  stressExitProb: 1,
  stressSlippageMult: 1,
  stressNoFillMult: 1,
  stressFullFillMult: 1,
};

/** A rebalancer with no discipline at all: every trade goes, at any size. */
export const REBALANCE_RULES_OFF: RebalancePolicyOverrides = {
  minTicket: 0,
  abandonPartialFraction: 0,
};

const labelFor = (drivers: readonly TailDriver[]): string =>
  drivers.length === 0
    ? "baseline (all drivers off)"
    : drivers.length === TAIL_DRIVERS.length
      ? "full model"
      : drivers.join(" + ");

/**
 * The 2^3 lattice, baseline first and full model last.
 *
 * `livePolicy` is the policy the real engine runs; arms with `rebalanceRules`
 * enabled keep it verbatim, arms without it fall back to the permissive one.
 */
export function tailDriverArms(livePolicy: RebalancePolicyOverrides): TailDriverArm[] {
  return channelSubsets<TailDriver>(TAIL_DRIVERS).map((drivers) => {
    const on = new Set(drivers);
    const shock: ShockOverrides = {
      ...(on.has("volScaling") ? {} : VOL_SCALING_OFF),
      ...(on.has("eventShocks") ? {} : EVENT_SHOCKS_OFF),
    };
    return {
      key: subsetKey<TailDriver>(drivers, TAIL_DRIVERS),
      drivers,
      label: labelFor(drivers),
      shock,
      policy: on.has("rebalanceRules") ? { ...livePolicy } : { ...REBALANCE_RULES_OFF },
    };
  });
}

// ------------------------------------------------------------------ metrics

export type TailMetrics = {
  /** P(drawdown breaches the threshold AND the trough sits in stress), %. */
  jointBreachProb: number;
  /** Deepest drawdown across paths, % (negative). */
  worstDrawdownPct: number;
  /** Mean return of the worst 5% of paths, % (negative in the tail). */
  cvar5ReturnPct: number;
  /** Median per-fold execution cost, currency units. */
  meanCost: number;
};

export type TailMetricKey = keyof TailMetrics;

export const TAIL_METRICS: {
  key: TailMetricKey;
  label: string;
  unit: string;
  /** true when a *larger* number is worse (cost, breach probability). */
  higherIsWorse: boolean;
}[] = [
  { key: "jointBreachProb", label: "joint drawdown breach", unit: "pp", higherIsWorse: true },
  { key: "worstDrawdownPct", label: "worst drawdown", unit: "pp", higherIsWorse: false },
  { key: "cvar5ReturnPct", label: "CVaR5 return", unit: "pp", higherIsWorse: false },
  { key: "meanCost", label: "execution cost", unit: "£", higherIsWorse: true },
];

export type TailDriverArmResult = {
  arm: TailDriverArm;
  metrics: TailMetrics;
};

export type TailMetricDecomposition = {
  metric: TailMetricKey;
  label: string;
  unit: string;
  higherIsWorse: boolean;
  attribution: AttributionResult<TailDriver>;
};

export type TailDecompositionReport = {
  metrics: TailMetricDecomposition[];
  arms: TailDriverArmResult[];
};

/**
 * Shapley-decompose every tail metric over the three drivers.
 *
 * `results` must contain exactly one entry per lattice arm; a missing arm is an
 * error rather than a silently NaN row, because a hole in the lattice makes the
 * whole decomposition meaningless.
 */
export function tailDecompositionReport(
  results: readonly TailDriverArmResult[],
): TailDecompositionReport {
  const byKey = new Map(results.map((r) => [r.arm.key, r]));
  for (const arm of tailDriverArms(REBALANCE_RULES_OFF)) {
    if (!byKey.has(arm.key)) {
      throw new Error(`tail decomposition is missing arm "${arm.key || "baseline"}"`);
    }
  }

  const metrics = TAIL_METRICS.map(({ key, label, unit, higherIsWorse }) => ({
    metric: key,
    label,
    unit,
    higherIsWorse,
    attribution: shapleyAttribution<TailDriver>(
      (_subset, k) => byKey.get(k)!.metrics[key],
      TAIL_DRIVERS,
    ),
  }));

  return { metrics, arms: [...results] };
}

// ------------------------------------------------------------------ printing

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const signed = (v: number, d = 2) => (v > 0 ? `+${num(v, d)}` : num(v, d));

export function formatTailDecomposition(report: TailDecompositionReport): string {
  const out: string[] = [];

  out.push(pad("arm", 34) + ["joint%", "worstDD", "CVaR5", "cost"].map((h) => h.padStart(10)).join(""));
  for (const r of report.arms) {
    out.push(
      pad(r.arm.label, 34) +
        [
          num(r.metrics.jointBreachProb, 1),
          num(r.metrics.worstDrawdownPct, 2),
          num(r.metrics.cvar5ReturnPct, 2),
          num(r.metrics.meanCost, 0),
        ]
          .map((v) => v.padStart(10))
          .join(""),
    );
  }

  for (const m of report.metrics) {
    const { attribution: a } = m;
    out.push("");
    out.push(
      `${m.label} (${m.unit}): baseline ${num(a.baseline)} → full ${num(a.full)}  ` +
        `total ${signed(a.total)}  interact ${signed(a.interaction)}`,
    );
    out.push(
      pad("  driver", 20) +
        ["shapley", "share%", "solo", "marginal"].map((h) => h.padStart(11)).join(""),
    );
    for (const c of a.contributions) {
      out.push(
        pad(`  ${c.channel}`, 20) +
          [signed(c.shapley), num(c.share * 100, 1), signed(c.solo), signed(c.marginal)]
            .map((v) => v.padStart(11))
            .join(""),
      );
    }
  }

  return out.join("\n");
}

/** Driver with the largest |Shapley| for a metric — the headline attribution. */
export function dominantDriver(d: TailMetricDecomposition): TailDriver {
  return d.attribution.contributions.reduce((best, c) =>
    Math.abs(c.shapley) > Math.abs(best.shapley) ? c : best,
  ).channel;
}
