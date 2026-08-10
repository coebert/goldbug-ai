import { useMemo, useState } from "react";
import {
  HEATMAP_METRICS,
  buildHeatmap,
  type HeatmapMetric,
} from "@/lib/breakout-execution-heatmap";
import type { ExecutionGrid } from "@/lib/breakout-driver-execution";
import type { RiskLevel } from "@/lib/breakout-driver-actions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Heatmap of the whole risk × expectancy-gap-weight sweep, so compounded
 * return and drawdown can be compared across every setting simultaneously.
 */
export function ExecutionHeatmap({
  grid,
  current,
}: {
  grid: ExecutionGrid;
  current?: { risk: RiskLevel; gapWeight: number };
}) {
  const [metric, setMetric] = useState<HeatmapMetric>("cumulativeReturnPct");
  const map = useMemo(() => buildHeatmap(grid, metric), [grid, metric]);

  if (!map.rows.length) return null;

  return (
    <div className="rounded-md border border-border/40 p-2" data-testid="execution-heatmap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">
          Settings heatmap — risk × expectancy-gap weight
        </p>
        <div className="flex flex-wrap gap-1">
          {HEATMAP_METRICS.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant={metric === m.key ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setMetric(m.key)}
              data-testid={`heatmap-metric-${m.key}`}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[320px] border-separate border-spacing-1 text-xs">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="text-left font-normal">Risk \ gap w.</th>
              {map.gapWeights.map((w) => (
                <th key={w} className="text-center font-normal tabular-nums">
                  {w}×
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.rows.map((row) => (
              <tr key={row.risk}>
                <td className="pr-1 capitalize text-muted-foreground">{row.risk}</td>
                {row.cells.map((c) => {
                  const isCurrent =
                    current?.risk === c.risk && current?.gapWeight === c.gapWeight;
                  const alpha = 0.12 + Math.abs(c.intensity - 0.5) * 1.4 * 0.6;
                  const hue = c.good ? "var(--chart-positive-rgb)" : "var(--chart-negative-rgb)";
                  return (
                    <td key={c.gapWeight} className="p-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            data-testid={`heatmap-cell-${c.risk}-${c.gapWeight}`}
                            className={`rounded-sm px-1.5 py-2 text-center tabular-nums ${
                              isCurrent ? "ring-2 ring-primary" : ""
                            } ${c.isBest ? "font-semibold" : ""}`}
                            style={{ backgroundColor: `rgb(${hue} / ${alpha.toFixed(2)})` }}
                          >
                            {c.value.toFixed(1)}
                            {map.metric.suffix}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="text-[11px]">
                          <p className="capitalize">
                            {c.risk} · gap weight {c.gapWeight}×
                          </p>
                          <p>Compounded {c.cell.cumulativeReturnPct.toFixed(1)}%</p>
                          <p>Max drawdown {c.cell.maxDrawdownPct.toFixed(1)}%</p>
                          <p>
                            {c.cell.taken}/{c.cell.signals} taken · avg size{" "}
                            {c.cell.avgSize.toFixed(2)}×
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="heatmap-summary">
        {map.summary}
      </p>
    </div>
  );
}

export default ExecutionHeatmap;
