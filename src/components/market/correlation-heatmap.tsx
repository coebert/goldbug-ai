// Correlation heatmap for the symbols currently overlaid on the drill-down
// chart. Correlations use daily returns over the same shared window as the
// comparison table, so the two panels always describe the same period.

import { Grid3x3 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  MIN_CORRELATION_POINTS,
  clusterCorrelation,
  type CorrelationCell,
  type CorrelationMatrix,
} from "@/lib/market-compare";

/** Green for co-moving, red for opposing, muted near zero. */
function cellStyle(value: number | null) {
  if (value == null) return { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" };
  const strength = Math.min(1, Math.abs(value));
  const alpha = 0.12 + strength * 0.55;
  const hue = value >= 0 ? "142 71% 45%" : "0 72% 51%";
  return {
    background: `hsl(${hue} / ${alpha})`,
    color: strength > 0.55 ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
  };
}

function cellText(cell: CorrelationCell) {
  if (cell.value == null) return "—";
  return cell.value.toFixed(2);
}

function shortLabel(label: string) {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

export interface CorrelationHeatmapProps {
  correlation: CorrelationMatrix;
  from: string | null;
  to: string | null;
}

export function CorrelationHeatmap({ correlation, from, to }: CorrelationHeatmapProps) {
  const [clustered, setClustered] = useState(false);
  const clustering = useMemo(() => clusterCorrelation(correlation), [correlation]);
  const view = clustered ? clustering.matrix : correlation;
  const groups = clustered ? clustering.groups : null;
  const clusterCount = groups ? groups[groups.length - 1] + 1 : 0;

  const { symbols, labels, cells } = view;
  if (correlation.symbols.length < 2) return null;

  const hasAny = cells.some((row, i) => row.some((c, j) => i !== j && c.value != null));
  const canCluster = correlation.symbols.length >= 3;

  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Grid3x3 className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> Return correlation
      </h3>

      {canCluster && hasAny ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={clustered ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            aria-pressed={clustered}
            onClick={() => setClustered((v) => !v)}
          >
            {clustered ? "Clustered order" : "Cluster by similarity"}
          </Button>
          {clustered ? (
            <span className="text-[11px] text-muted-foreground">
              {clusterCount === 1
                ? "All selected markets move as one block."
                : `${clusterCount} groups — dividers separate markets that move apart.`}
            </span>
          ) : null}
        </div>
      ) : null}

      {!hasAny ? (
        <p className="text-xs text-muted-foreground">
          Not enough overlapping daily moves ({MIN_CORRELATION_POINTS}+ needed) to measure
          correlation over this window.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] border-separate border-spacing-1 text-xs">
              <caption className="sr-only">
                Correlation of daily returns between selected markets
                {from && to ? ` from ${from} to ${to}` : ""}
              </caption>
              <thead>
                <tr>
                  <th className="w-24 text-left font-medium text-muted-foreground" scope="col">
                    <span className="sr-only">Market</span>
                  </th>
                  {labels.map((l, i) => (
                    <th
                      key={symbols[i]}
                      scope="col"
                      className={`px-1 text-center text-[10px] font-medium text-muted-foreground${
                        groups && i > 0 && groups[i] !== groups[i - 1] ? " border-l border-border" : ""
                      }`}
                      title={l}
                    >
                      {shortLabel(l)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map((row, i) => (
                  <tr
                    key={symbols[i]}
                    className={
                      groups && i > 0 && groups[i] !== groups[i - 1] ? "border-t border-border" : ""
                    }
                  >
                    <th
                      scope="row"
                      className="max-w-[7rem] truncate pr-1 text-left text-[11px] font-medium"
                      title={labels[i]}
                    >
                      {shortLabel(labels[i])}
                    </th>
                    {row.map((cell, j) => (
                      <td
                        key={`${symbols[i]}-${symbols[j]}`}
                        className={`rounded-md px-2 py-1.5 text-center tabular-nums${
                          groups && j > 0 && groups[j] !== groups[j - 1] ? " border-l border-border" : ""
                        }`}
                        style={cellStyle(cell.value)}
                        title={
                          cell.value == null
                            ? `${labels[i]} vs ${labels[j]}: not enough overlapping days (${cell.n})`
                            : `${labels[i]} vs ${labels[j]}: ${cell.value.toFixed(2)} over ${cell.n} days`
                        }
                      >
                        {cellText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Daily-return correlation over the shared window
            {from && to ? ` (${from} → ${to})` : ""}. +1 means the two markets moved together, 0 no
            relationship, −1 opposite — low or negative pairs are what actually diversify a book.
          </p>
        </>
      )}
    </div>
  );
}
