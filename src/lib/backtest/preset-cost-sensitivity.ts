// Cost sensitivity across fee / spread / slippage ranges, per assumptions preset.
//
// A backtest priced under one preset answers "what did this earn under these
// costs?". It does not answer the question that actually matters before real
// money goes on: how wrong can the cost estimate be before the strategy stops
// making money? This module sweeps each cost axis independently around every
// preset and reports three things per axis:
//
//   elasticity  — return percentage points lost per unit of extra cost
//                 (per 1bps of spread/slippage, per 0.1x of commission)
//   breakeven   — the axis value at which total return crosses zero, found by
//                 linear interpolation between ladder points
//   headroom    — distance from the preset's own setting to that breakeven
//
// A strategy whose breakeven spread sits just above the spread we currently
// assume is not profitable — it is inside the error bar of our cost model.
//
// The replay itself is injected as a runner, so the same sweep can price the
// governor replay, a style backtest, or any future arm without this module
// knowing anything about signals or bars. Pure and deterministic.

import {
  ASSUMPTION_PRESET_IDS,
  ASSUMPTION_PRESETS,
  resolveAssumptions,
  type AssumptionPresetId,
  type ExecutionAssumptions,
} from "./execution-assumptions";

export type CostAxis = "fees" | "spread" | "slippage";

/** The scalar summary a runner must return for one priced replay. */
export type SensitivityOutcome = {
  totalReturnPct: number;
  maxDrawdownPct: number;
  tradesAdmitted: number;
  frictionBpsOfEquity: number;
};

export type SensitivityRunner = (
  assumptions: ExecutionAssumptions,
) => SensitivityOutcome;

/**
 * Default ladders. Fees are an absolute commission multiplier (not a scaling
 * of the preset) so every preset is measured on the same axis; spread and
 * slippage are absolute bps.
 */
export const DEFAULT_COST_LADDERS: Record<CostAxis, number[]> = {
  fees: [0, 0.5, 1, 1.5, 2],
  spread: [0, 5, 10, 20, 40],
  slippage: [0, 2, 5, 10, 20],
};

export const AXIS_META: Record<CostAxis, { label: string; unit: string }> = {
  fees: { label: "Commission", unit: "x model" },
  spread: { label: "Quoted spread", unit: "bps" },
  slippage: { label: "Slippage", unit: "bps" },
};

function withAxis(
  base: ExecutionAssumptions,
  axis: CostAxis,
  value: number,
): ExecutionAssumptions {
  switch (axis) {
    case "fees":
      return resolveAssumptions({ ...base, commissionMult: value });
    case "spread":
      // Per-symbol overrides would mask the axis, so drop them for the sweep.
      return resolveAssumptions({
        ...base,
        spreadBps: value,
        spreadBpsBySymbol: undefined,
      });
    case "slippage":
      return resolveAssumptions({ ...base, slippageBps: value });
  }
}

/** The preset's own setting on this axis — the point the sweep is centred on. */
export function axisValueOf(a: ExecutionAssumptions, axis: CostAxis): number {
  return axis === "fees" ? a.commissionMult : axis === "spread" ? a.spreadBps : a.slippageBps;
}

export type SensitivityPoint = SensitivityOutcome & {
  value: number;
  /** True when this point equals the preset's own setting. */
  isBaseline: boolean;
};

export type AxisSensitivity = {
  axis: CostAxis;
  points: SensitivityPoint[];
  /** Return points lost per unit of the axis (negative = costlier hurts). */
  elasticity: number;
  /** Axis value where total return crosses zero; null if it never does. */
  breakevenValue: number | null;
  /** Signed distance from the preset's setting to breakeven. */
  headroom: number | null;
  /** Return already negative at the preset's own setting. */
  unprofitableAtBaseline: boolean;
};

export type PresetSensitivity = {
  preset: AssumptionPresetId;
  assumptions: ExecutionAssumptions;
  baseline: SensitivityOutcome;
  axes: AxisSensitivity[];
  verdict: "robust" | "fragile" | "unprofitable";
};

export type CostSensitivityReport = {
  presets: PresetSensitivity[];
  ladders: Record<CostAxis, number[]>;
  /** Axis with the steepest average return damage across presets. */
  dominantAxis: CostAxis;
  /** Presets whose profit survives the whole ladder on every axis. */
  robustPresets: AssumptionPresetId[];
  summary: string;
};

/** Least-squares slope of return against the axis value. */
function slope(points: SensitivityPoint[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.value, 0) / n;
  const my = points.reduce((s, p) => s + p.totalReturnPct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.value - mx) * (p.totalReturnPct - my);
    den += (p.value - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/** First zero-crossing of return along the ladder, linearly interpolated. */
function breakeven(points: SensitivityPoint[]): number | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.totalReturnPct > 0 && b.totalReturnPct <= 0) {
      const span = b.totalReturnPct - a.totalReturnPct;
      const t = span === 0 ? 0 : a.totalReturnPct / -span;
      return a.value + t * (b.value - a.value);
    }
  }
  return null;
}

const round = (v: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

export type CostSensitivityOptions = {
  /** Presets to sweep. Default: every preset. */
  presets?: readonly AssumptionPresetId[];
  /** Axis ladders; each axis merges with the preset's own setting. */
  ladders?: Partial<Record<CostAxis, number[]>>;
  /** Axes to sweep. Default: all three. */
  axes?: readonly CostAxis[];
};

/**
 * Sweep fees, spread and slippage around each preset and score how fragile the
 * result is. The runner is called once per ladder point per axis per preset,
 * plus once for each preset's baseline, and must be deterministic — otherwise
 * the elasticities measure noise.
 */
export function runCostSensitivity(
  run: SensitivityRunner,
  opts: CostSensitivityOptions = {},
): CostSensitivityReport {
  const presetIds = opts.presets?.length ? [...opts.presets] : [...ASSUMPTION_PRESET_IDS];
  const axes: CostAxis[] = opts.axes?.length
    ? [...opts.axes]
    : (["fees", "spread", "slippage"] as CostAxis[]);
  const ladders: Record<CostAxis, number[]> = {
    fees: opts.ladders?.fees ?? DEFAULT_COST_LADDERS.fees,
    spread: opts.ladders?.spread ?? DEFAULT_COST_LADDERS.spread,
    slippage: opts.ladders?.slippage ?? DEFAULT_COST_LADDERS.slippage,
  };

  const presets: PresetSensitivity[] = presetIds.map((id) => {
    const base = ASSUMPTION_PRESETS[id];
    const baseline = run(resolveAssumptions({ ...base }));
    const axisResults: AxisSensitivity[] = axes.map((axis) => {
      const own = axisValueOf(base, axis);
      const values = [...new Set([...ladders[axis], own])]
        .filter((v) => Number.isFinite(v) && v >= 0)
        .sort((a, b) => a - b);
      const points: SensitivityPoint[] = values.map((value) => {
        const isBaseline = value === own;
        const outcome = isBaseline ? baseline : run(withAxis(base, axis, value));
        return { value, isBaseline, ...outcome };
      });
      const bev = breakeven(points);
      return {
        axis,
        points,
        elasticity: round(slope(points), 4),
        breakevenValue: bev === null ? null : round(bev, 2),
        headroom: bev === null ? null : round(bev - own, 2),
        unprofitableAtBaseline: baseline.totalReturnPct <= 0,
      };
    });

    const verdict: PresetSensitivity["verdict"] =
      baseline.totalReturnPct <= 0
        ? "unprofitable"
        : axisResults.some((a) => a.breakevenValue !== null)
          ? "fragile"
          : "robust";

    return { preset: id, assumptions: resolveAssumptions({ ...base }), baseline, axes: axisResults, verdict };
  });

  // Damage per axis is normalised by the ladder's span so bps and multiplier
  // axes are comparable: "return lost across the whole plausible range".
  let dominantAxis: CostAxis = axes[0] ?? "spread";
  let worst = -Infinity;
  for (const axis of axes) {
    const span = Math.max(...ladders[axis]) - Math.min(...ladders[axis]);
    const damage =
      presets.reduce((s, p) => {
        const a = p.axes.find((x) => x.axis === axis);
        return s + (a ? -a.elasticity * span : 0);
      }, 0) / Math.max(1, presets.length);
    if (damage > worst) {
      worst = damage;
      dominantAxis = axis;
    }
  }

  const robustPresets = presets.filter((p) => p.verdict === "robust").map((p) => p.preset);
  const summary = robustPresets.length
    ? `profit survives the full cost ladder under ${robustPresets.join(", ")}; ` +
      `${AXIS_META[dominantAxis].label.toLowerCase()} is the most damaging axis (${round(worst, 2)}pp across its range)`
    : `no preset survives the full cost ladder — ${AXIS_META[dominantAxis].label.toLowerCase()} ` +
      `alone costs ${round(worst, 2)}pp across its range`;

  return { presets, ladders, dominantAxis, robustPresets, summary };
}

/** Fixed-width text report suitable for a CLI run or a saved artifact. */
export function costSensitivityReportText(report: CostSensitivityReport): string {
  const lines: string[] = [];
  lines.push("Cost sensitivity by assumptions preset");
  lines.push("=".repeat(78));
  for (const p of report.presets) {
    lines.push("");
    lines.push(
      `${p.preset.toUpperCase()}  baseline return ${p.baseline.totalReturnPct.toFixed(2)}%  ` +
        `maxDD ${p.baseline.maxDrawdownPct.toFixed(2)}%  trades ${p.baseline.tradesAdmitted}  ` +
        `friction ${p.baseline.frictionBpsOfEquity.toFixed(0)}bps  [${p.verdict}]`,
    );
    for (const a of p.axes) {
      const meta = AXIS_META[a.axis];
      lines.push(`  ${meta.label} (${meta.unit})`);
      lines.push(
        "    " +
          ["value", "return", "maxDD", "trades", "friction"]
            .map((h, i) => h.padStart(i === 0 ? 8 : 10))
            .join(""),
      );
      for (const pt of a.points) {
        lines.push(
          "    " +
            `${pt.value}${pt.isBaseline ? "*" : ""}`.padStart(8) +
            `${pt.totalReturnPct.toFixed(2)}%`.padStart(10) +
            `${pt.maxDrawdownPct.toFixed(2)}%`.padStart(10) +
            String(pt.tradesAdmitted).padStart(10) +
            `${pt.frictionBpsOfEquity.toFixed(0)}bps`.padStart(10),
        );
      }
      lines.push(
        `    elasticity ${a.elasticity}pp per ${meta.unit === "x model" ? "1x" : "1bps"}; ` +
          (a.breakevenValue === null
            ? "no breakeven inside the ladder"
            : `breakeven at ${a.breakevenValue}${meta.unit === "x model" ? "x" : "bps"} ` +
              `(headroom ${a.headroom})`),
      );
    }
  }
  lines.push("");
  lines.push(`verdict: ${report.summary}`);
  return lines.join("\n");
}
