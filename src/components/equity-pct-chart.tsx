import { useMemo } from "react";
import { AXIS_LINE, AXIS_TICK, GRID_PROPS, TICK_LINE } from "@/lib/chart-palette";
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

function shortDate(s: string) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/**
 * Percentage change in equity versus the portfolio's starting pot.
 * Zero on the y-axis is the starting investment, so the line crosses
 * below the baseline whenever equity falls under the starting value.
 */
export function EquityPctChart({
  equity,
  startingCash,
  className,
}: {
  equity: Array<{ snapshot_date: string; total_value: number | string }>;
  startingCash: number;
  className?: string;
}) {
  const { data, domain, last } = useMemo(() => {
    const base = Number(startingCash);
    const rows =
      base > 0
        ? equity
            .map((e) => ({
              date: String(e.snapshot_date),
              pct: ((Number(e.total_value) - base) / base) * 100,
            }))
            .filter((r) => Number.isFinite(r.pct))
        : [];
    const vals = rows.map((r) => r.pct);
    const mag = Math.max(0.5, ...vals.map((v) => Math.abs(v))) * 1.2;
    return {
      data: rows,
      domain: [-mag, mag] as [number, number],
      last: vals.length ? vals[vals.length - 1] : 0,
    };
  }, [equity, startingCash]);

  if (data.length < 2) return null;

  const up = last >= 0;
  const color = up ? "#4ade80" : "#f87171";

  return (
    <div className={className}>
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Equity change vs starting pot
          </span>
          <span
            className={`text-sm font-semibold tabular-nums ${up ? "text-primary" : "text-destructive"}`}
          >
            {up ? "+" : ""}
            {last.toFixed(2)}%
          </span>
        </div>
        <div className="h-[160px] w-full landscape:h-[200px] md:h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 4 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                stroke="currentColor"
                strokeOpacity={0.4}
                minTickGap={40}
                tickFormatter={(v) => shortDate(String(v))}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                width={64}
                tickMargin={4}
                domain={domain}
                tick={AXIS_TICK}
                stroke="currentColor"
                strokeOpacity={0.4}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <ReferenceLine
                y={0}
                stroke="currentColor"
                strokeOpacity={0.6}
                strokeDasharray="4 3"
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--popover-foreground)",
                }}
                labelStyle={{ color: "var(--muted-foreground)" }}
                labelFormatter={(l) => shortDate(String(l))}
                formatter={(v) => [`${Number(v).toFixed(2)}%`, "vs start"]}
              />
              <Line
                type="monotone"
                dataKey="pct"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
