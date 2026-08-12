import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getBacktestSeries } from "@/lib/backtest-series.functions";
import { FeeBreakdownCard } from "@/components/fee-breakdown-card";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_NEUTRAL_SERIES,
  CHART_ROLE,
  CHART_SEQUENCE,
  GRID_PROPS,
  OKABE_ITO,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

// Okabe–Ito colour-blind-safe sequence for per-symbol stacks.
const PALETTE = CHART_SEQUENCE;

function colorFor(_symbol: string, index: number): string {
  return PALETTE[index % PALETTE.length];
}

// Neutral cash band — kept low-chroma so per-symbol hues stand out.
const CASH_COLOR = CHART_NEUTRAL_SERIES;
const EQUITY_COLOR = CHART_ROLE.deposits; // blue reads as the primary series
const BUY_COLOR = CHART_ROLE.positive;
const SELL_COLOR = CHART_ROLE.negative;
const DRAWDOWN_COLOR = OKABE_ITO.vermillion;

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

  const drawdownData = useMemo(() => {
    let peak = -Infinity;
    return equityData.map((p) => {
      peak = Math.max(peak, p.value);
      const dd = peak > 0 ? ((p.value - peak) / peak) * 100 : 0;
      return { date: p.date, drawdown: Number(dd.toFixed(4)) };
    });
  }, [equityData]);

  const equityByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of equityData) m.set(p.date, p.value);
    return m;
  }, [equityData]);

  const buyMarkers = useMemo(
    () =>
      (q.data?.trades ?? [])
        .filter((t) => t.side === "buy" && equityByDate.has(t.date))
        .map((t) => ({
          date: t.date,
          value: equityByDate.get(t.date)!,
          label: `BUY ${t.quantity} ${t.symbol} @ ${t.price}`,
        })),
    [q.data?.trades, equityByDate],
  );

  const sellMarkers = useMemo(
    () =>
      (q.data?.trades ?? [])
        .filter((t) => t.side === "sell" && equityByDate.has(t.date))
        .map((t) => ({
          date: t.date,
          value: equityByDate.get(t.date)!,
          label: `SELL ${t.quantity} ${t.symbol} @ ${t.price}`,
        })),
    [q.data?.trades, equityByDate],
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
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Equity curve
            </div>
            <div className="flex items-center gap-3 text-[10px] text-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-0 w-0 border-b-[8px] border-l-[5px] border-r-[5px] border-l-transparent border-r-transparent"
                  style={{ borderBottomColor: BUY_COLOR }}
                />{" "}
                buy
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-0 w-0 border-t-[8px] border-l-[5px] border-r-[5px] border-l-transparent border-r-transparent"
                  style={{ borderTopColor: SELL_COLOR }}
                />{" "}
                sell
              </span>
            </div>
          </div>
          <div
            className="h-48 w-full sm:h-56"
            role="img"
            aria-label={`Backtest equity curve with ${buyMarkers.length} buys and ${sellMarkers.length} sells`}
          >
            <span className="sr-only">
              {`Equity curve over ${equityData.length} days from ${equityData[0]?.date ?? ""} to ${equityData[equityData.length - 1]?.date ?? ""}. Buys marked with up triangles, sells with down triangles.`}
            </span>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={equityData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  type="category"
                  allowDuplicatedCategory={false}
                  tick={AXIS_TICK}
                  minTickGap={24}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickFormatter={fmtCompact}
                  width={64}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <Tooltip
                  formatter={(v: number) => fmtCurrency(v)}
                  labelFormatter={(l) => `${l}`}
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  name="Equity"
                  stroke={EQUITY_COLOR}
                  strokeWidth={2}
                  dot={false}
                />
                <Scatter
                  name="Buys"
                  data={buyMarkers}
                  dataKey="value"
                  fill={BUY_COLOR}
                  shape="triangle"
                />
                <Scatter
                  name="Sells"
                  data={sellMarkers}
                  dataKey="value"
                  fill={SELL_COLOR}
                  shape="triangle"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Drawdown curve
          </div>
          <div
            className="h-32 w-full sm:h-40"
            role="img"
            aria-label={`Backtest drawdown curve, ${drawdownData.length} observations`}
          >
            <span className="sr-only">
              {`Peak-to-trough drawdown series. Minimum ${Math.min(0, ...drawdownData.map((d) => d.drawdown)).toFixed(2)} percent.`}
            </span>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  minTickGap={24}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  tick={AXIS_TICK}
                  width={64}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  domain={[(min: number) => Math.min(0, Math.floor(min)), 0]}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <Tooltip
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                  labelFormatter={(l) => `${l}`}
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                />
                <Area
                  type="monotone"
                  dataKey="drawdown"
                  name="Drawdown"
                  stroke={DRAWDOWN_COLOR}
                  fill={DRAWDOWN_COLOR}
                  fillOpacity={0.25}
                  strokeDasharray="4 2"
                />
              </AreaChart>
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
            <div
              className="h-52 w-full sm:h-64"
              role="img"
              aria-label={`Holdings over time, ${holdingsSymbols.length} symbols plus cash`}
            >
              <span className="sr-only">
                {`Stacked market value including cash across ${holdingsPoints.length} days. Symbols: ${["Cash", ...holdingsSymbols].join(", ")}.`}
              </span>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={holdingsPoints} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    minTickGap={24}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={fmtCompact}
                    width={64}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [fmtCurrency(v), name]}
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                  />
                  <Legend {...LEGEND_PROPS} />
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

        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Fees &amp; net returns
          </div>
          <FeeBreakdownCard portfolioId={portfolioId} runToken={runToken} days={days} />
        </section>
      </CardContent>
    </Card>
  );
}
