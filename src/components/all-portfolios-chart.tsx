import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAllPortfoliosEquity } from "@/lib/trading.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const LINE_COLORS = ["#22d3ee", "#f472b6", "#a78bfa", "#facc15", "#4ade80", "#fb923c"];

export function AllPortfoliosChart() {
  const fetchAll = useServerFn(getAllPortfoliosEquity);
  const q = useQuery({
    queryKey: ["all-portfolios-equity"],
    queryFn: () => fetchAll(),
    staleTime: 30_000,
  });

  const { series, portfolios, currency, totalNow, startingTotal } = useMemo(() => {
    const s = q.data?.series ?? [];
    const p = q.data?.portfolios ?? [];
    const c = q.data?.currency ?? "GBP";
    const last = s[s.length - 1];
    const first = s[0];
    return {
      series: s,
      portfolios: p,
      currency: c,
      totalNow: last ? Number(last.total) : 0,
      startingTotal: first ? Number(first.total) : 0,
    };
  }, [q.data]);

  const pnl = totalNow - startingTotal;
  const pnlPct = startingTotal > 0 ? (pnl / startingTotal) * 100 : 0;

  if (!q.data || portfolios.length === 0) return null;

  const fmt = (v: number) => `${currency}${v.toFixed(0)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Total portfolio value over time</CardTitle>
        <CardDescription>
          Combined value across all your portfolios. Each portfolio's value is forward-filled
          between snapshots.
        </CardDescription>
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
              {pnlPct.toFixed(2)}%) vs first snapshot
            </div>
          </div>
        </div>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
              <defs>
                <linearGradient id="totalArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--muted-foreground))" strokeOpacity={0.15} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--muted-foreground))"
                label={{ value: "Date", position: "insideBottom", offset: -2, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              />
              <YAxis
                width={72}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v) => fmt(Number(v))}
                label={{ value: `Total value (${currency})`, angle: -90, position: "insideLeft", offset: 8, style: { textAnchor: "middle" }, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              />
              <Tooltip
                cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
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
              <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="total"
                name="Total"
                stroke="#22d3ee"
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
                  strokeWidth={1.5}
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
