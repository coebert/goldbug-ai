// Rolling-window correlation for the overlaid symbols: how each pair's
// relationship *changed* inside the selected range, rather than one average
// number for the whole window.

import { useMemo } from "react";
import { Activity } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { ChartFrame } from "@/components/chart-frame";
import { CHART_ROLE } from "@/lib/chart-palette";
import {
  MIN_CORRELATION_POINTS,
  ROLLING_WINDOWS,
  buildRollingCorrelation,
  type Comparison,
  type RollingWindow,
} from "@/lib/market-compare";

function num(v: number | null, digits = 2) {
  return v == null ? "—" : v.toFixed(digits);
}

function drift(latest: number | null, average: number | null) {
  if (latest == null || average == null) return null;
  return latest - average;
}

export interface RollingCorrelationPanelProps {
  comparison: Comparison;
  window: RollingWindow;
  onWindowChange: (w: RollingWindow) => void;
}

export function RollingCorrelationPanel({
  comparison,
  window,
  onWindowChange,
}: RollingCorrelationPanelProps) {
  const rolling = useMemo(
    () => buildRollingCorrelation(comparison, window),
    [comparison, window],
  );

  if (comparison.series.length < 2) return null;

  const rows = rolling.dates.map((date, i) => {
    const row: Record<string, string | number | null> = { date };
    for (const p of rolling.pairs) row[p.key] = p.values[i];
    return row;
  });

  const hasData = rolling.pairs.some((p) => p.latest != null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> Rolling correlation
        </h3>
        <div className="flex gap-1" role="group" aria-label="Rolling correlation window">
          {ROLLING_WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={w === window ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              aria-pressed={w === window}
              onClick={() => onWindowChange(w)}
            >
              {w}d
            </Button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <p className="text-xs text-muted-foreground">
          The selected range is too short for a {window}-day rolling correlation — it needs at least{" "}
          {Math.max(window, MIN_CORRELATION_POINTS)} overlapping trading days. Pick a longer range
          or a shorter window.
        </p>
      ) : (
        <>
          <ChartFrame height={200}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  minTickGap={28}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  domain={[-1, 1]}
                  ticks={[-1, -0.5, 0, 0.5, 1]}
                  tick={{ fontSize: 10 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <ReferenceLine y={0} stroke="hsl(var(--border))" />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  formatter={(value: number | string, name: string) => {
                    const pair = rolling.pairs.find((p) => p.key === name);
                    return [typeof value === "number" ? value.toFixed(2) : "—", pair?.label ?? name];
                  }}
                />
                {rolling.pairs.map((p) => (
                  <Line
                    key={p.key}
                    type="monotone"
                    dataKey={p.key}
                    stroke={p.color}
                    strokeWidth={1.6}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 text-left font-medium">Pair</th>
                  <th className="py-1 text-right font-medium">Now</th>
                  <th className="py-1 text-right font-medium">Avg</th>
                  <th className="py-1 text-right font-medium">Range</th>
                  <th className="py-1 text-right font-medium">Drift</th>
                </tr>
              </thead>
              <tbody>
                {rolling.pairs.map((p) => {
                  const d = drift(p.latest, p.average);
                  return (
                    <tr key={p.key} className="border-t border-border/50">
                      <td className="max-w-[12rem] truncate py-1.5" title={p.label}>
                        <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: p.color }} aria-hidden="true" />
                        {p.label}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{num(p.latest)}</td>
                      <td className="py-1.5 text-right tabular-nums">{num(p.average)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {num(p.min)} → {num(p.max)}
                      </td>
                      <td
                        className="py-1.5 text-right tabular-nums"
                        style={{
                          color:
                            d == null
                              ? undefined
                              : d > 0.1
                                ? CHART_ROLE.positive
                                : d < -0.1
                                  ? CHART_ROLE.negative
                                  : undefined,
                        }}
                      >
                        {d == null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Each point correlates the trailing {window} trading days of returns. "Drift" is the
            latest reading against this window's own average — a large positive drift means pairs
            are converging (less diversification than the headline number suggests).
          </p>
        </>
      )}
    </div>
  );
}
