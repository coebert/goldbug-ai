import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  mixTimelineKey,
  type MixTimelineGrids,
  type MixWindowMode,
} from "@/lib/breakout-mix-timeline";
import type { DriverSetting } from "@/lib/breakout-driver-compare";
import {
  SAXO_AXIS,
  SAXO_GRID,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Stacked 100% area of the stance mix across the backtest timeline, so a
 * stance that only appears late in the sample is visible as a trend rather
 * than hidden inside a single aggregate number.
 */
const STANCE_SERIES = [
  { key: "buyPct", label: "Buy", color: "var(--saxo-up)" },
  { key: "holdPct", label: "Partial", color: "var(--saxo-axis)" },
  { key: "sellPct", label: "Stand aside", color: "var(--saxo-down)" },
] as const;

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}pp`;

export function MixTimelineChart({
  grid,
  setting,
}: {
  grid: MixTimelineGrids;
  setting: DriverSetting;
}) {
  const [window, setWindow] = useState<MixWindowMode>("expanding");

  // The whole risk × gap-weight grid is precomputed server-side, so switching
  // setting or window is a lookup, not a recompute.
  const timeline = useMemo(
    () => grid[window]?.entries[mixTimelineKey(setting)] ?? null,
    [grid, window, setting],
  );

  if (!timeline?.points.length) return null;

  return (
    <div className="rounded-md border border-border/40 p-2" data-testid="mix-timeline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium">
          Stance mix over time — {setting.risk} · {setting.gapWeight.toFixed(1)}× gap
        </p>
        <div className="flex flex-wrap gap-1">
          {(["expanding", "rolling"] as const).map((w) => (
            <Button
              key={w}
              size="sm"
              variant={window === w ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setWindow(w)}
              data-testid={`mix-timeline-window-${w}`}
            >
              {w === "expanding" ? "Cumulative" : `Rolling ${grid.rolling.rollingBuckets}`}
            </Button>
          ))}
        </div>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="mix-timeline-summary">
        {timeline.summary}
      </p>

      <div className="mt-2 h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={timeline.points} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
            <defs>
              {STANCE_SERIES.map((s) => (
                <linearGradient key={s.key} id={`mix-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.15} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid {...SAXO_GRID} />
            <XAxis {...SAXO_AXIS} dataKey="period" interval="preserveStartEnd" minTickGap={24} />
            <YAxis
              {...SAXO_AXIS}
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(v: number) => `${v}%`}
              width={38}
            />
            <Tooltip
              cursor={SAXO_TOOLTIP_CURSOR}
              contentStyle={SAXO_TOOLTIP_CONTENT}
              labelStyle={SAXO_TOOLTIP_LABEL}
              formatter={(value: number, name: string) => [`${Number(value).toFixed(0)}%`, name]}
              labelFormatter={(label: string) => {
                const p = timeline.points.find((x) => x.period === label);
                return p ? `${label} · ${p.ranked} ranked · ${p.windowTrades} signals` : label;
              }}
            />
            {STANCE_SERIES.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stackId="mix"
                stroke={s.color}
                strokeWidth={1.5}
                fill={`url(#mix-${s.key})`}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {STANCE_SERIES.map((s) => {
          const key = s.key === "buyPct" ? "buy" : s.key === "holdPct" ? "hold" : "sell";
          return (
            <span key={s.key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.label}
              <Badge
                variant="outline"
                className="px-1 py-0 text-[9px] font-normal"
                data-testid={`mix-timeline-shift-${key}`}
              >
                {signed(timeline.shift[key])}
              </Badge>
            </span>
          );
        })}
      </div>
    </div>
  );
}
