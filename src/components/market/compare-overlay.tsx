// Multi-symbol overlay for the market drill-down page: rebased performance
// lines plus a side-by-side range-change table.

import { Link } from "@tanstack/react-router";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Layers, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  LEGEND_STYLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { CorrelationHeatmap } from "@/components/market/correlation-heatmap";
import { MAX_COMPARE_SYMBOLS, type Comparison } from "@/lib/market-compare";
import { rangeLabel, symbolMeta, type HistoryRange } from "@/lib/market-symbol-history";

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function toneClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "";
  return v >= 0 ? "text-emerald-500" : "text-destructive";
}

export interface CompareOverlayProps {
  symbol: string;
  range: HistoryRange;
  /** Symbols currently overlaid (excluding the page's own symbol). */
  compare: string[];
  /** Every symbol that can be added. */
  options: string[];
  comparison: Comparison;
  loading: boolean;
  onToggle: (symbol: string) => void;
  onClear: () => void;
}

export function CompareOverlay({
  symbol,
  range,
  compare,
  options,
  comparison,
  loading,
  onToggle,
  onClear,
}: CompareOverlayProps) {
  const addable = options.filter((s) => s !== symbol && !compare.includes(s));
  const full = compare.length >= MAX_COMPARE_SYMBOLS;

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Layers className="h-4 w-4 text-primary" aria-hidden="true" /> Compare with other markets
        </h2>
        {compare.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>

      {compare.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {compare.map((s) => (
            <Badge
              key={s}
              variant="secondary"
              className="cursor-pointer gap-1 pr-1.5"
              onClick={() => onToggle(s)}
            >
              {symbolMeta(s)?.label ?? s}
              <X className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Remove {symbolMeta(s)?.label ?? s}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {addable.map((s) => (
          <Button
            key={s}
            size="sm"
            variant="outline"
            disabled={full}
            className="h-7 px-2 text-xs"
            onClick={() => onToggle(s)}
          >
            + {symbolMeta(s)?.label ?? s}
          </Button>
        ))}
      </div>

      {full && (
        <p className="text-[11px] text-muted-foreground">
          Up to {MAX_COMPARE_SYMBOLS} overlays at a time — remove one to add another.
        </p>
      )}

      {compare.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pick one or more markets to overlay. Every line is rebased to 100 at the start of the
          shared window, so you're comparing performance rather than price levels.
        </p>
      ) : loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : comparison.points.length < 2 ? (
        <p className="text-xs text-muted-foreground">
          These markets don't have enough overlapping price history to compare over {rangeLabel(range)}.
        </p>
      ) : (
        <>
          <ChartFrame className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={comparison.points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                  minTickGap={40}
                  tickFormatter={(d: string) => d.slice(2, 7)}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                  width={54}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => `${(v - 100).toFixed(0)}%`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  formatter={(v: number, name: string) => [pct(v - 100), name]}
                />
                <Legend wrapperStyle={LEGEND_STYLE} />
                {comparison.series.map((s) => (
                  <Line
                    key={s.symbol}
                    type="monotone"
                    dataKey={s.symbol}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={s.symbol === symbol ? 2.5 : 1.75}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">
                Performance comparison from {comparison.from} to {comparison.to}
              </caption>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">Market</th>
                  <th className="py-1.5 text-right font-medium">Change</th>
                  <th className="py-1.5 text-right font-medium">Best</th>
                  <th className="py-1.5 text-right font-medium">Worst</th>
                  <th className="py-1.5 text-right font-medium">Vol</th>
                </tr>
              </thead>
              <tbody>
                {comparison.series.map((s) => (
                  <tr key={s.symbol} className="border-t border-border/50">
                    <td className="py-1.5">
                      <Link
                        to="/market/$symbol"
                        params={{ symbol: s.symbol }}
                        search={{ range, compare: undefined }}
                        className="inline-flex items-center gap-2 hover:underline"
                      >
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: s.color }}
                        />
                        <span className="truncate">{s.label}</span>
                      </Link>
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${toneClass(s.changePct)}`}>
                      {pct(s.changePct)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.peakPct)}</td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.troughPct)}</td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.volatilityPct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <CorrelationHeatmap
            correlation={comparison.correlation}
            from={comparison.from}
            to={comparison.to}
          />

          <p className="text-[11px] text-muted-foreground">
            Shared window {comparison.from} → {comparison.to}. Best/worst are the highest and lowest
            points reached against that start, so they can differ from the end change.
          </p>
        </>
      )}
    </section>
  );
}
