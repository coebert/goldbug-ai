// Per-signal weight history: how much each alpha model drove decisions
// across the last 5–30 days, as a stacked share chart plus a drift table.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Layers, TrendingDown, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AXIS_PROPS,
  CHART_SEQUENCE,
  GRID_PROPS,
  LEGEND_PROPS,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSignalWeightHistory } from "@/lib/signal-weight-history.functions";
import { SIGNAL_WINDOW_OPTIONS, signalLabel } from "@/lib/signal-weight-history";

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const shortDate = (d: string) => d.slice(5).replace("-", "/");

export function SignalWeightHistoryCard({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const [windowDays, setWindowDays] = useState<number>(30);
  const load = useServerFn(getSignalWeightHistory);

  const query = useQuery({
    queryKey: ["signal-weight-history", portfolioId, windowDays],
    queryFn: () => load({ data: { portfolioId, windowDays } }),
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  const colorFor = useMemo(() => {
    const map = new Map<string, string>();
    (data?.kinds ?? []).forEach((k, i) => map.set(k, CHART_SEQUENCE[i % CHART_SEQUENCE.length]!));
    return (k: string) => map.get(k) ?? CHART_SEQUENCE[0]!;
  }, [data?.kinds]);

  const chartData = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        date: p.date,
        ...Object.fromEntries((data?.kinds ?? []).map((k) => [k, p.shares[k] ?? 0])),
      })),
    [data?.points, data?.kinds],
  );

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-muted-foreground" />
              Signal weight history
            </CardTitle>
            <CardDescription>
              Share of total alpha weight each signal carried per decision day
              {data?.topDriver ? ` — ${signalLabel(data.topDriver)} led this window` : ""}.
            </CardDescription>
          </div>
          <div className="flex gap-1">
            {SIGNAL_WINDOW_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={windowDays === d ? "secondary" : "ghost"}
                className="h-8 px-2 text-xs"
                onClick={() => setWindowDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground">Could not load signal weight history.</p>
        ) : !data || data.points.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No adaptive weight records yet for this portfolio — the engine writes one row per
            signal each time it runs.
          </p>
        ) : (
          <>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...AXIS_PROPS} dataKey="date" tickFormatter={shortDate} minTickGap={18} />
                  <YAxis {...AXIS_PROPS} domain={[0, 1]} tickFormatter={pct} width={46} />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    formatter={(v: number, name: string) => [pct1(Number(v)), signalLabel(name)]}
                  />
                  <Legend {...LEGEND_PROPS} formatter={(v: string) => signalLabel(v)} />
                  {data.kinds.map((k) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stackId="w"
                      stroke={colorFor(k)}
                      fill={colorFor(k)}
                      fillOpacity={0.55}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[380px] text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-2 font-medium">Signal</th>
                    <th className="py-1 pr-2 text-right font-medium">Avg share</th>
                    <th className="py-1 pr-2 text-right font-medium">Now</th>
                    <th className="py-1 pr-2 text-right font-medium">Drift</th>
                    <th className="py-1 text-right font-medium">Multiplier</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((s) => {
                    const up = s.deltaShare >= 0;
                    return (
                      <tr key={s.kind} className="border-t border-border/60">
                        <td className="py-1.5 pr-2">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 rounded-[2px]"
                              style={{ background: colorFor(s.kind) }}
                            />
                            {signalLabel(s.kind)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{pct1(s.avgShare)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{pct1(s.lastShare)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          <span
                            className={`inline-flex items-center justify-end gap-1 ${
                              up ? "text-emerald-500" : "text-rose-500"
                            }`}
                          >
                            {up ? (
                              <TrendingUp className="h-3 w-3" />
                            ) : (
                              <TrendingDown className="h-3 w-3" />
                            )}
                            {up ? "+" : ""}
                            {pct1(s.deltaShare)}
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {s.lastMultiplier.toFixed(2)}x
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Drift compares the first and last day in the window. Multiplier is the adaptive
              adjustment applied to the signal's base weight (1.00x = unadapted).
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
