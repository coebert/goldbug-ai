/**
 * Coverage trend: is Saxo charge data arriving reliably, or drifting away?
 *
 * A single "82% broker-priced" figure can't tell you whether that's a recovery
 * from 40% or a slide from 99%. This plots trailing-window coverage per
 * portfolio, with an overall line, so a degrading account is visible as a
 * falling curve rather than an unremarkable number.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { ChartFrame } from "@/components/chart-frame";
import { getCoverageTrend } from "@/lib/fee-coverage-trend.functions";
import { COVERAGE_TREND_ALERT_CATEGORY } from "@/lib/coverage-trend-alert";
import { WebhookDeliveryStatusStrip } from "@/components/webhook-delivery-status-strip";
import type { CoverageDirection, CoverageSeries } from "@/lib/fee-coverage-trend";
import { POLL } from "@/lib/query-keys";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
  saxoActiveDot,
} from "@/lib/saxo-chart";

const RANGES = [30, 90] as const;
type Range = (typeof RANGES)[number];

const LINE_COLORS = [
  SAXO_COLOR.up,
  "hsl(var(--chart-2, 199 89% 60%))",
  "hsl(var(--chart-3, 43 96% 56%))",
  "hsl(var(--chart-4, 322 81% 66%))",
  "hsl(var(--chart-5, 262 83% 68%))",
];

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

function DirectionBadge({ direction, change }: { direction: CoverageDirection; change: number | null }) {
  if (direction === "improving") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
        <TrendingUp className="mr-1 h-3 w-3" /> +{change?.toFixed(1)}pts
      </Badge>
    );
  }
  if (direction === "degrading") {
    return (
      <Badge variant="outline" className="border-rose-500/40 text-rose-400">
        <TrendingDown className="mr-1 h-3 w-3" /> {change?.toFixed(1)}pts
      </Badge>
    );
  }
  if (direction === "flat") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Minus className="mr-1 h-3 w-3" /> steady
      </Badge>
    );
  }
  return null;
}

function shortDate(d: string): string {
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return d;
  return new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function CoverageTrendCard() {
  const [range, setRange] = useState<Range>(30);
  const fetchTrend = useServerFn(getCoverageTrend);

  const { data, isLoading } = useQuery({
    queryKey: ["coverage-trend"],
    queryFn: () => fetchTrend({ data: { days: 90 } }),
    refetchInterval: POLL.SLOW,
  });

  const series: CoverageSeries[] = useMemo(() => {
    if (!data) return [];
    return [data.overall, ...data.portfolios];
  }, [data]);

  const chartRows = useMemo(() => {
    if (!data) return [];
    const dates = data.dates.slice(-range);
    return dates.map((date) => {
      const row: Record<string, string | number | null> = { date };
      for (const s of series) {
        const p = s.points.find((x) => x.date === date);
        row[s.portfolioId ?? "overall"] = p?.coveragePct ?? null;
      }
      return row;
    });
  }, [data, series, range]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-sm">Broker cost coverage trend</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Share of trades carrying a booked Saxo charge, on a{" "}
            {data?.windowDays ?? 14}-day trailing window.
          </p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded px-2 py-1 text-xs ${
                range === r ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : chartRows.length === 0 || series.every((s) => s.latestPct == null) ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No fills in this window yet — coverage will appear once trades settle.
          </p>
        ) : (
          <>
            <ChartFrame className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid {...SAXO_GRID} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...SAXO_AXIS} minTickGap={24} />
                  <YAxis
                    domain={[0, 100]}
                    tickFormatter={(v: number) => `${v}%`}
                    {...SAXO_AXIS}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={SAXO_TOOLTIP_CONTENT}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                    cursor={SAXO_TOOLTIP_CURSOR}
                    labelFormatter={(l) => shortDate(String(l))}
                    formatter={(v, name) => [pct(typeof v === "number" ? v : null), String(name)]}
                  />
                  {series.map((s, i) => (
                    <Line
                      key={s.portfolioId ?? "overall"}
                      type="monotone"
                      dataKey={s.portfolioId ?? "overall"}
                      name={s.label}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]}
                      strokeWidth={s.portfolioId == null ? 2.5 : 1.5}
                      strokeDasharray={s.portfolioId == null ? undefined : "4 3"}
                      dot={false}
                      activeDot={saxoActiveDot(LINE_COLORS[i % LINE_COLORS.length])}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ul className="space-y-1.5">
              {series.map((s, i) => (
                <li
                  key={s.portfolioId ?? "overall"}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: LINE_COLORS[i % LINE_COLORS.length] }}
                    aria-hidden
                  />
                  <span className={s.portfolioId == null ? "font-medium" : ""}>{s.label}</span>
                  <span className="tabular-nums text-muted-foreground">{pct(s.latestPct)}</span>
                  <span className="ml-auto">
                    <DirectionBadge direction={s.direction} change={s.changePct} />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <WebhookDeliveryStatusStrip category={COVERAGE_TREND_ALERT_CATEGORY} />
      </CardContent>

    </Card>
  );
}
