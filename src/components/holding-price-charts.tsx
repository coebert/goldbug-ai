// Live price charts for every open holding on the trading desk. Each chart
// draws the holding's own price series (hourly when enough intraday points
// exist, otherwise daily closes) with a reference line at average cost, so a
// strategy rule's entry / stop / target can be read against real price action.
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUk } from "@/lib/uk-time";

export type HoldingChartSeries = {
  symbol: string;
  avg_cost: number;
  quantity: number;
  closes: number[];
  hourly: number[];
  hourlyAt: string[];
  currentPrice: number | null;
  hourlyStale: boolean;
};

type Resolution = "hourly" | "daily";

function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: abs < 10 ? 3 : 2,
    maximumFractionDigits: abs < 10 ? 3 : 2,
  });
}

function HoldingChart({
  s,
  resolution,
}: {
  s: HoldingChartSeries;
  resolution: Resolution;
}) {
  const useHourly =
    resolution === "hourly" && !s.hourlyStale && s.hourly.length >= 2;
  const points = useMemo(() => {
    if (useHourly) {
      return s.hourly.map((v, i) => ({
        label: s.hourlyAt[i]
          ? formatUk(s.hourlyAt[i], { hour: "2-digit", minute: "2-digit" })
          : String(i),
        price: v,
      }));
    }
    const n = s.closes.length;
    return s.closes.map((v, i) => ({ label: `D-${n - 1 - i}`, price: v }));
  }, [s, useHourly]);

  const last = s.currentPrice ?? points[points.length - 1]?.price ?? null;
  const pnlPct =
    last != null && s.avg_cost > 0 ? ((last - s.avg_cost) / s.avg_cost) * 100 : null;
  const up = (pnlPct ?? 0) >= 0;
  const stroke = up ? "hsl(var(--chart-2))" : "hsl(var(--destructive))";
  const gradId = `hpc-${s.symbol.replace(/[^A-Za-z0-9]/g, "")}`;

  if (points.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-3">
        <div className="text-sm font-medium">{s.symbol}</div>
        <div className="mt-2 flex h-28 items-center justify-center text-[11px] text-muted-foreground">
          No price history yet — it builds up as syncs run.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3" data-testid={`holding-chart-${s.symbol}`}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">{s.symbol}</span>
          <Badge variant="outline" className="px-1.5 py-0 text-[9px] uppercase">
            {useHourly ? "hourly" : "daily"}
          </Badge>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {last == null ? "—" : fmtPrice(last)}
          </div>
          {pnlPct != null && (
            <div
              className={`text-[11px] tabular-nums ${up ? "text-emerald-500" : "text-rose-400"}`}
            >
              {pnlPct >= 0 ? "+" : "−"}
              {Math.abs(pnlPct).toFixed(2)}% vs avg cost {fmtPrice(s.avg_cost)}
            </div>
          )}
        </div>
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} vertical={false} />
            <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={28} />
            <YAxis
              width={52}
              {...AXIS_PROPS}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => fmtPrice(v)}
            />
            <Tooltip
              formatter={(v: number) => [fmtPrice(v), "Price"]}
              contentStyle={TOOLTIP_CONTENT_STYLE}
              wrapperStyle={TOOLTIP_WRAPPER_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
            />
            <ReferenceLine
              y={s.avg_cost}
              {...REFERENCE_LINE}
              label={{
                value: "avg cost",
                fontSize: 11,
                fill: "var(--foreground)",
                position: "insideTopLeft",
              }}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke={stroke}
              strokeWidth={2}
              fill={`url(#${gradId})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function HoldingPriceCharts({
  series,
  isLoading,
  updatedAt,
}: {
  series: HoldingChartSeries[];
  isLoading?: boolean;
  updatedAt?: number | null;
}) {
  const [resolution, setResolution] = useState<Resolution>("hourly");
  const list = series.filter((s) => Number(s.quantity) !== 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Live price charts</CardTitle>
          <p className="text-xs text-muted-foreground">
            Real price action per holding, with your average cost marked
            {updatedAt ? ` · updated ${formatUk(new Date(updatedAt), { timeStyle: "short" })}` : ""}
          </p>
        </div>
        <div className="flex gap-1">
          {(["hourly", "daily"] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={resolution === r ? "secondary" : "ghost"}
              className="h-7 px-2 text-[11px] capitalize"
              onClick={() => setResolution(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-xs text-muted-foreground">Loading price history…</p>}
        {!isLoading && list.length === 0 && (
          <p className="text-xs text-muted-foreground">No open positions to chart.</p>
        )}
        {list.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((s) => (
              <HoldingChart key={s.symbol} s={s} resolution={resolution} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
