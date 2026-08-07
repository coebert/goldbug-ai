// Sector exposure over time: how much of the invested book sits in sectors
// the cycle classifier calls growing, stagnating or shrinking, plus the net
// tilt (growing% - shrinking%).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/chart-frame";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_METRIC,
  SAXO_REFERENCE_LINE,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";
import { formatUkAxisDay } from "@/lib/uk-time";
import { sectorLabel } from "@/lib/sector-exposure";
import { getSectorExposureSeries } from "@/lib/sector-exposure.functions";

const WINDOWS = [30, 90, 180, 365] as const;

type SeriesKey = "growing" | "stagnating" | "shrinking" | "unclassified" | "tilt";

const PHASE_STYLE = {
  growing: { label: "Growing", color: SAXO_COLOR.up },
  stagnating: { label: "Stagnating", color: SAXO_COLOR.axis },
  shrinking: { label: "Shrinking", color: SAXO_COLOR.down },
  unclassified: { label: "Unclassified", color: SAXO_COLOR.crosshairSoft },
} as const;

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function signedPct(v: number) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)} pts`;
}

export function SectorExposureChart({ portfolioId }: { portfolioId: string }) {
  const [windowDays, setWindowDays] = useState<(typeof WINDOWS)[number]>(90);
  const fetchSeries = useServerFn(getSectorExposureSeries);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sector-exposure", portfolioId, windowDays],
    queryFn: () => fetchSeries({ data: { portfolioId, windowDays } }),
    staleTime: 5 * 60 * 1000,
  });

  const rows = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        date: p.date,
        growing: p.growingPct * 100,
        stagnating: p.stagnatingPct * 100,
        shrinking: p.shrinkingPct * 100,
        unclassified: p.unclassifiedPct * 100,
        tilt: p.tilt * 100,
        invested: p.invested,
      })),
    [data],
  );

  const hasData = rows.some((r) => r.invested > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Sector exposure over time</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Share of invested value in growing vs shrinking sectors, day by day.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={w === windowDays ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => setWindowDays(w)}
            >
              {w}d
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">
            No positions in this window yet — the tilt appears once trades are filled.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Growing now" value={pct(rows[rows.length - 1].growing / 100)} />
              <Metric label="Shrinking now" value={pct(rows[rows.length - 1].shrinking / 100)} />
              <Metric label="Net tilt" value={signedPct((data?.points.at(-1)?.tilt ?? 0))} />
              <Metric label="Tilt change" value={signedPct(data?.tiltChange ?? 0)} />
            </div>

            <ChartFrame className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid {...SAXO_GRID} />
                  <XAxis
                    dataKey="date"
                    {...SAXO_AXIS}
                    minTickGap={42}
                    tickFormatter={(d: string) => formatUkAxisDay(d)}
                  />
                  <YAxis
                    {...SAXO_AXIS}
                    domain={[-100, 100]}
                    ticks={[-100, -50, 0, 50, 100]}
                    width={44}
                    tickFormatter={(v: number) => `${v}%`}
                    label={{
                      value: "% of invested",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: SAXO_METRIC.tickFontSize, fill: SAXO_COLOR.axis },
                    }}
                  />
                  <ReferenceLine y={0} {...SAXO_REFERENCE_LINE} />
                  <Tooltip
                    contentStyle={SAXO_TOOLTIP_CONTENT}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                    labelFormatter={(d) => formatUkAxisDay(String(d))}
                    formatter={(value: number, name: string) => [
                      `${Number(value).toFixed(1)}%`,
                      name,
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="growing"
                    name="Growing"
                    stackId="exposure"
                    stroke={PHASE_STYLE.growing.color}
                    fill={PHASE_STYLE.growing.color}
                    fillOpacity={SAXO_METRIC.splitFillPeakOpacity}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="stagnating"
                    name="Stagnating"
                    stackId="exposure"
                    stroke={PHASE_STYLE.stagnating.color}
                    fill={PHASE_STYLE.stagnating.color}
                    fillOpacity={0.22}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="shrinking"
                    name="Shrinking"
                    stackId="exposure"
                    stroke={PHASE_STYLE.shrinking.color}
                    fill={PHASE_STYLE.shrinking.color}
                    fillOpacity={SAXO_METRIC.splitFillDownPeakOpacity}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="unclassified"
                    name="Unclassified"
                    stackId="exposure"
                    stroke={PHASE_STYLE.unclassified.color}
                    fill={PHASE_STYLE.unclassified.color}
                    fillOpacity={0.14}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="tilt"
                    name="Net tilt"
                    dot={false}
                    stroke={SAXO_COLOR.crosshair}
                    strokeWidth={SAXO_METRIC.strokeWidth}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartFrame>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {Object.entries(PHASE_STYLE).map(([key, s]) => (
                <span key={key} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: s.color }}
                  />
                  {s.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-4"
                  style={{ background: SAXO_COLOR.crosshair }}
                />
                Net tilt (growing − shrinking)
              </span>
            </div>

            {data?.latestBySector.length ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Current sectors</p>
                <ul className="space-y-1">
                  {data.latestBySector.map((s) => (
                    <li key={s.sector} className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: PHASE_STYLE[s.phase].color }}
                        />
                        {sectorLabel(s.sector)}
                        <span className="text-muted-foreground">
                          {PHASE_STYLE[s.phase].label.toLowerCase()}
                        </span>
                      </span>
                      <span className="tabular-nums">{pct(s.pct)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data?.staticPhases ? (
              <p className="text-xs text-muted-foreground">
                Sector phases use the latest classification — daily history builds up as runs
                record sector momentum.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
