// Time-series chart of per-currency wallet balances plus total base cash
// over the sim run. Data is populated once per tick by trading-engine.server.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LineChart as LineIcon } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

import { getWalletHistory } from "@/lib/wallet-history.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  LEGEND_PROPS,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

interface Props {
  portfolioId: string;
  active?: boolean;
}

// Stable palette keyed by currency (falls back to indexed order).
const CCY_COLORS: Record<string, string> = {
  GBP: "hsl(217, 91%, 60%)",
  USD: "hsl(142, 71%, 45%)",
  EUR: "hsl(38, 92%, 50%)",
  JPY: "hsl(0, 72%, 51%)",
  CHF: "hsl(280, 65%, 60%)",
  AUD: "hsl(190, 75%, 45%)",
  CAD: "hsl(15, 80%, 55%)",
  HKD: "hsl(330, 70%, 55%)",
  SEK: "hsl(60, 70%, 50%)",
  NOK: "hsl(200, 80%, 40%)",
};
const FALLBACK = [
  "hsl(217, 91%, 60%)",
  "hsl(142, 71%, 45%)",
  "hsl(38, 92%, 50%)",
  "hsl(0, 72%, 51%)",
  "hsl(280, 65%, 60%)",
  "hsl(190, 75%, 45%)",
];
const colorFor = (ccy: string, i: number) => CCY_COLORS[ccy] ?? FALLBACK[i % FALLBACK.length];

const fmt = (n: number, ccy: string) =>
  n.toLocaleString("en-GB", {
    style: "currency",
    currency: ccy,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

export function WalletHistoryCard({ portfolioId, active = true }: Props) {
  const fetchFn = useServerFn(getWalletHistory);

  const q = useQuery({
    queryKey: ["wallet-history", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId, sinceDays: 365 } }),
    enabled: active,
    staleTime: 60_000,
  });

  const chartData = useMemo(() => {
    if (!q.data) return [] as Array<Record<string, number | string>>;
    const { rows, currencies, baseCcy } = q.data;
    return rows.map((r) => {
      const row: Record<string, number | string> = { date: r.snapshot_date };
      for (const c of currencies) row[c] = r.cash_by_ccy[c] ?? 0;
      row.__baseTotal = r.base_total;
      return row;
    });
  }, [q.data]);

  const currencies = q.data?.currencies ?? [];
  const baseCcy = q.data?.baseCcy ?? "GBP";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <LineIcon className="h-4 w-4" /> Wallet balances over time
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="h-64 animate-pulse rounded bg-muted/30" />
        ) : q.isError ? (
          <div className="text-sm text-destructive">Failed to load wallet history.</div>
        ) : chartData.length === 0 ? (
          <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
            No wallet history yet — snapshots start recording from the next tick.
          </div>
        ) : (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    minTickGap={24}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    width={64}
                    yAxisId="left"
                    tick={AXIS_TICK}
                    tickFormatter={(v) =>
                      typeof v === "number" ? v.toLocaleString("en-GB") : String(v)
                    }
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    width={64}
                    yAxisId="right"
                    orientation="right"
                    tick={AXIS_TICK}
                    tickFormatter={(v) =>
                      typeof v === "number" ? v.toLocaleString("en-GB") : String(v)
                    }
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    formatter={(value: number | string, name: string) => {
                      const n = typeof value === "number" ? value : Number(value);
                      if (name === "__baseTotal") return [fmt(n, baseCcy), `Total (${baseCcy})`];
                      return [fmt(n, name), name];
                    }}
                    labelFormatter={(l) => String(l)}
                  />
                  <Legend
                    {...LEGEND_PROPS}
                    formatter={(v) => (v === "__baseTotal" ? `Total (${baseCcy})` : v)}
                  />
                  {currencies.map((c, i) => (
                    <Area
                      key={c}
                      yAxisId="left"
                      type="monotone"
                      dataKey={c}
                      stackId="wallet"
                      stroke={colorFor(c, i)}
                      fill={colorFor(c, i)}
                      fillOpacity={0.25}
                      name={c}
                      isAnimationActive={false}
                    />
                  ))}
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="__baseTotal"
                    stroke="var(--foreground)"
                    strokeWidth={2}
                    dot={false}
                    name="__baseTotal"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Stacked areas: wallet balance per currency (native units). Line: total wallet valued
              in {baseCcy}. Snapshots are captured once per tick.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
