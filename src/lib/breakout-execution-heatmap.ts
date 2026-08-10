import type { ExecutionCell, ExecutionGrid } from "@/lib/breakout-driver-execution";
import type { RiskLevel } from "@/lib/breakout-driver-actions";

/**
 * Turns the risk × expectancy-gap-weight execution grid into a normalised
 * heatmap so compounded return and drawdown can be compared across every
 * setting at once instead of one cell at a time.
 */
export type HeatmapMetric = "cumulativeReturnPct" | "maxDrawdownPct" | "returnPerUnitPct";

export type HeatmapMetricSpec = {
  key: HeatmapMetric;
  label: string;
  /** true when a bigger number is a better outcome. */
  higherIsBetter: boolean;
  suffix: string;
};

export const HEATMAP_METRICS: readonly HeatmapMetricSpec[] = [
  { key: "cumulativeReturnPct", label: "Compounded return", higherIsBetter: true, suffix: "%" },
  { key: "maxDrawdownPct", label: "Max drawdown", higherIsBetter: false, suffix: "%" },
  { key: "returnPerUnitPct", label: "Return per unit size", higherIsBetter: true, suffix: "%" },
] as const;

export type HeatmapCell = {
  risk: RiskLevel;
  gapWeight: number;
  value: number;
  /** 0..1 position within the grid's value range (0 = worst, 1 = best). */
  intensity: number;
  good: boolean;
  isBest: boolean;
  isWorst: boolean;
  cell: ExecutionCell;
};

export type HeatmapRow = { risk: RiskLevel; cells: HeatmapCell[] };

export type Heatmap = {
  metric: HeatmapMetricSpec;
  gapWeights: number[];
  rows: HeatmapRow[];
  min: number;
  max: number;
  best: HeatmapCell | null;
  worst: HeatmapCell | null;
  summary: string;
};

export function metricSpec(metric: HeatmapMetric): HeatmapMetricSpec {
  return HEATMAP_METRICS.find((m) => m.key === metric) ?? HEATMAP_METRICS[0];
}

export function buildHeatmap(grid: ExecutionGrid, metric: HeatmapMetric): Heatmap {
  const spec = metricSpec(metric);
  const gapWeights = [...grid.gapWeights];
  const values = grid.cells.map((c) => c[spec.key]);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const span = max - min;

  let best: HeatmapCell | null = null;
  let worst: HeatmapCell | null = null;

  const rows: HeatmapRow[] = grid.risks.map((risk) => ({
    risk,
    cells: gapWeights
      .map((gapWeight) => {
        const cell = grid.cells.find((c) => c.risk === risk && c.gapWeight === gapWeight);
        if (!cell) return null;
        const value = cell[spec.key];
        // Normalise so 1 is always the desirable end of the range.
        const raw = span === 0 ? 0.5 : (value - min) / span;
        const intensity = spec.higherIsBetter ? raw : 1 - raw;
        const hc: HeatmapCell = {
          risk,
          gapWeight,
          value,
          intensity,
          good: intensity >= 0.5,
          isBest: false,
          isWorst: false,
          cell,
        };
        if (!best || hc.intensity > best.intensity) best = hc;
        if (!worst || hc.intensity < worst.intensity) worst = hc;
        return hc;
      })
      .filter((c): c is HeatmapCell => c !== null),
  }));

  if (best) (best as HeatmapCell).isBest = true;
  if (worst) (worst as HeatmapCell).isWorst = true;

  const b = best as HeatmapCell | null;
  const summary = b
    ? `Best ${spec.label.toLowerCase()} at ${b.risk} · ${b.gapWeight}× gap: ${b.value.toFixed(2)}${spec.suffix} (range ${min.toFixed(2)}–${max.toFixed(2)}${spec.suffix}).`
    : "No execution cells to compare yet.";

  return { metric: spec, gapWeights, rows, min, max, best: b, worst, summary };
}
