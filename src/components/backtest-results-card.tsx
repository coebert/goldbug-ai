import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getBacktestSeries } from "@/lib/backtest-series.functions";

// Deterministic palette so the same symbol keeps its colour across renders.
const PALETTE = [
  "hsl(var(--chart-1, 217 91% 60%))",
  "hsl(var(--chart-2, 142 71% 45%))",
  "hsl(var(--chart-3, 38 92% 50%))",
  "hsl(var(--chart-4, 291 64% 55%))",
  "hsl(var(--chart-5, 0 84% 60%))",
  "hsl(199 89% 48%)",
  "hsl(24 95% 53%)",
  "hsl(160 84% 39%)",
  "hsl(280 65% 60%)",
  "hsl(48 96% 53%)",
];

function colorFor(symbol: string, index: number): string {
  return PALETTE[index % PALETTE.length];
}

const CASH_COLOR = "hsl(220 9% 46%)";

export function BacktestResultsCard({
  portfolioId,
  days,
  runToken,
  currency = "USD",
}: {
  portfolioId: string;
  days: number;
  /** Bumped by the parent whenever a backtest completes, to force refetch. */
  runToken: number;
  currency?: string;
}) {
  const fn = useServerFn(getBacktestSeries);
  const q = useQuery({
    queryKey: ["backtest-series", portfolioId, days, runToken],
    queryFn: () => fn({ data: { portfolio_id: portfolioId, days } }),
    staleTime: 60 * 1000,
  });

  const equityData = useMemo(
    () =>
      (q.data?.equity ?? []).map((e) => ({
        date: e.snapshot_date,
        value: e.total_value,
      })),
    [q.data?.equity],
  );

  const holdingsPoints = q.data?.holdings.points ?? [];
  const holdingsSymbols = q.data?.holdings.symbols ?? [];

  const fmtCurrency = (n: number) =>
    `${currency} ${Number(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const fmtCompact = (n: number) =>
    Number(n).toLocaleString(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    });

  if (q.isLoading) {
    return (
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Backtest charts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-40 animate-pulse rounded bg-muted/40" />
        </CardContent>
      </Card>
    );
  }

  if (equityData.length === 0) {
    return (
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Backtest charts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No equity snapshots yet — run a backtest to see charts.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Backtest charts
          {q.data?.from && q.data?.to ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {q.data.from} → {q.data.to}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Equity curve
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equityData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtCompact} width={56} />
                <Tooltip
                  formatter={(v: number) => fmtCurrency(v)}
                  labelFormatter={(l) => `${l}`}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  name="Equity"
                  stroke="hsl(var(--primary, 217 91% 60%))"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Holdings over time
            </div>
            <div className="text-[10px] text-muted-foreground">
              stacked market value · cash included
            </div>
          </div>
          {holdingsPoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">No holdings in this window.</p>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={holdingsPoints} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtCompact} width={56} />
                  <Tooltip
                    formatter={(v: number, name: string) => [fmtCurrency(v), name]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area
                    type="monotone"
                    dataKey="cash"
                    name="Cash"
                    stackId="h"
                    stroke={CASH_COLOR}
                    fill={CASH_COLOR}
                    fillOpacity={0.35}
                  />
                  {holdingsSymbols.map((s, i) => (
                    <Area
                      key={s}
                      type="monotone"
                      dataKey={s}
                      name={s}
                      stackId="h"
                      stroke={colorFor(s, i)}
                      fill={colorFor(s, i)}
                      fillOpacity={0.55}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
