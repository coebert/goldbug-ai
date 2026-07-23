import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAllPortfoliosEquity } from "@/lib/trading.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const LINE_COLORS = ["#f472b6", "#a78bfa", "#facc15", "#4ade80", "#fb923c", "#60a5fa"];
const TOTAL_COLOR = "#22d3ee";
const AXIS_COLOR = "hsl(var(--foreground))";
const GRID_COLOR = "hsl(var(--foreground))";

type Range = "7d" | "30d" | "90d" | "1y" | "all";

const RANGE_OPTS: { value: Range; label: string; days: number | null }[] = [
  { value: "7d", label: "7D", days: 7 },
  { value: "30d", label: "30D", days: 30 },
  { value: "90d", label: "90D", days: 90 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "All", days: null },
];

export function AllPortfoliosChart() {
  const fetchAll = useServerFn(getAllPortfoliosEquity);
  const [range, setRange] = useState<Range>("all");
  const q = useQuery({
    queryKey: ["all-portfolios-equity"],
    queryFn: () => fetchAll(),
    staleTime: 30_000,
  });

  const { series, portfolios, currency, totalNow, startingTotal, yDomain, pctDomain } = useMemo(() => {
    const all = q.data?.series ?? [];
    const p = q.data?.portfolios ?? [];
    const c = q.data?.currency ?? "GBP";
    const opt = RANGE_OPTS.find((r) => r.value === range)!;
    let s = all;
    if (opt.days && all.length > 0) {
      const cutoff = Date.now() - opt.days * 86_400_000;
      s = all.filter((r: any) => new Date(r.date).getTime() >= cutoff);
      if (s.length === 0) s = all.slice(-1);
    }
    const first = s[0];
    const last = s[s.length - 1];
    const start = first ? Number(first.total) : 0;
    // annotate with pct change vs window start
    s = s.map((r: any) => ({
      ...r,
      pct: start > 0 ? ((Number(r.total) - start) / start) * 100 : 0,
    }));
    const totals = s.map((r: any) => Number(r.total)).filter((n: number) => Number.isFinite(n));
    let lo = Math.min(...totals);
    let hi = Math.max(...totals);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0; hi = 1;
    }
    const pad = Math.max((hi - lo) * 0.1, hi * 0.005, 1);
    const yLo = Math.max(0, lo - pad);
    const yHi = hi + pad;
    const pctLo = start > 0 ? ((yLo - start) / start) * 100 : 0;
    const pctHi = start > 0 ? ((yHi - start) / start) * 100 : 0;
    return {
      series: s,
      portfolios: p,
      currency: c,
      totalNow: last ? Number(last.total) : 0,
      startingTotal: start,
      yDomain: [yLo, yHi] as [number, number],
      pctDomain: [pctLo, pctHi] as [number, number],
    };
  }, [q.data, range]);


  const pnl = totalNow - startingTotal;
  const pnlPct = startingTotal > 0 ? (pnl / startingTotal) * 100 : 0;

  if (!q.data || portfolios.length === 0) return null;

  const fmt = (v: number) => `${currency}${v.toFixed(0)}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Total portfolio value over time</CardTitle>
            <CardDescription>
              Combined value across all your portfolios. Each portfolio's value is forward-filled
              between snapshots.
            </CardDescription>
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            value={range}
            onValueChange={(v) => v && setRange(v as Range)}
            className="shrink-0"
          >
            {RANGE_OPTS.map((r) => (
              <ToggleGroupItem key={r.value} value={r.value} className="px-2.5 text-xs">
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className="text-2xl font-semibold tracking-tight">
              {currency} {totalNow.toFixed(2)}
            </div>
            <div className={`text-xs ${pnl >= 0 ? "text-primary" : "text-destructive"}`}>
              {pnl >= 0 ? "+" : ""}
              {currency} {pnl.toFixed(2)} ({pnl >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%) over {RANGE_OPTS.find((r) => r.value === range)!.label}
            </div>
          </div>
        </div>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 8, right: 16, bottom: 28, left: 12 }}>
              <defs>
                <linearGradient id="totalArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TOTAL_COLOR} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={TOTAL_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_COLOR} strokeOpacity={0.18} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: AXIS_COLOR }}
                stroke={AXIS_COLOR}
                strokeOpacity={0.6}
                minTickGap={40}
                label={{ value: "Date", position: "insideBottom", offset: -6, fill: AXIS_COLOR, fontSize: 12 }}
              />
              <YAxis
                width={72}
                tick={{ fontSize: 11, fill: AXIS_COLOR }}
                stroke={AXIS_COLOR}
                strokeOpacity={0.6}
                tickFormatter={(v) => fmt(Number(v))}
                domain={["auto", "auto"]}
                label={{ value: `Total value (${currency})`, angle: -90, position: "insideLeft", offset: 8, style: { textAnchor: "middle" }, fill: AXIS_COLOR, fontSize: 12 }}
              />
              <Tooltip
                cursor={{ stroke: AXIS_COLOR, strokeOpacity: 0.4, strokeDasharray: "3 3" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as Record<string, number | string>;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                      <div className="mb-1 font-medium">{String(label)}</div>
                      <div className="mb-1 flex justify-between gap-4">
                        <span className="text-muted-foreground">Total</span>
                        <span className="font-medium">{currency} {Number(row.total).toFixed(2)}</span>
                      </div>
                      {portfolios.map((p, i) => (
                        <div key={p.id} className="flex justify-between gap-4">
                          <span style={{ color: LINE_COLORS[i % LINE_COLORS.length] }}>{p.name}</span>
                          <span>{currency} {Number(row[p.id] ?? 0).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12, color: AXIS_COLOR }} />
              <Area
                type="monotone"
                dataKey="total"
                name="Total"
                stroke={TOTAL_COLOR}
                strokeWidth={2.5}
                fill="url(#totalArea)"
                isAnimationActive={false}
              />
              {portfolios.map((p, i) => (
                <Line
                  key={p.id}
                  type="monotone"
                  dataKey={p.id}
                  name={p.name}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={1.75}
                  strokeDasharray="4 3"
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
