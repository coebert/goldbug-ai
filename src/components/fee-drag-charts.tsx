import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  CHART_SEQUENCE,
  GRID_PROPS,
  LEGEND_PROPS,
  TICK_LINE,
} from "@/lib/chart-palette";
import type { PerTradeFeeRow } from "@/lib/fee-breakdown";

import { CollapsibleLegend } from "@/components/ui/collapsible-legend";
/** Builds a cumulative-fee-drag-over-time series and a per-asset stacked
 *  breakdown from the per-trade rows already loaded by FeeBreakdownCard.
 *  Pure aggregation — no server round-trip. */
export function FeeDragCharts({
  perTrade,
  currency,
}: {
  perTrade: PerTradeFeeRow[];
  currency: string;
}) {
  const [scale, setScale] = useState<"cost" | "bps">("cost");

  // ---- Per-asset totals (all symbols, sorted by total spend). ----
  const perSymbol = useMemo(() => {
    const map = new Map<
      string,
      { symbol: string; buyFee: number; sellFee: number; commission: number; notional: number }
    >();
    for (const r of perTrade) {
      const row = map.get(r.symbol) ?? {
        symbol: r.symbol,
        buyFee: 0,
        sellFee: 0,
        commission: 0,
        notional: 0,
      };
      row.commission += r.commission;
      row.notional += r.notional;
      if (r.side === "buy") row.buyFee += r.commission;
      else row.sellFee += r.commission;
      map.set(r.symbol, row);
    }
    return [...map.values()]
      .map((r) => ({
        ...r,
        dragBps: r.notional > 0 ? (r.commission / r.notional) * 10_000 : 0,
      }))
      .sort((a, b) => b.commission - a.commission);
  }, [perTrade]);

  const topSymbols = perSymbol.slice(0, 12);

  // ---- Daily + cumulative fees. Bucket by trade_date so gaps in trading
  //      collapse naturally on the x-axis. ----
  const daily = useMemo(() => {
    const byDate = new Map<string, { date: string; buy: number; sell: number; notional: number }>();
    for (const r of perTrade) {
      const row = byDate.get(r.trade_date) ?? {
        date: r.trade_date,
        buy: 0,
        sell: 0,
        notional: 0,
      };
      row.notional += r.notional;
      if (r.side === "buy") row.buy += r.commission;
      else row.sell += r.commission;
      byDate.set(r.trade_date, row);
    }
    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    let cumBuy = 0,
      cumSell = 0,
      cumNotional = 0;
    return sorted.map((r) => {
      cumBuy += r.buy;
      cumSell += r.sell;
      cumNotional += r.notional;
      const cumTotal = cumBuy + cumSell;
      return {
        date: r.date,
        buy: r.buy,
        sell: r.sell,
        cumBuy,
        cumSell,
        cumTotal,
        cumDragBps: cumNotional > 0 ? (cumTotal / cumNotional) * 10_000 : 0,
      };
    });
  }, [perTrade]);

  const totalFees = daily.at(-1)?.cumTotal ?? 0;
  const totalDragBps = daily.at(-1)?.cumDragBps ?? 0;

  if (perTrade.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3">
        No trades in this window — run a backtest or place a trade to see fee drag over time.
      </p>
    );
  }

  const money = (v: number) =>
    `${currency} ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div
      className="space-y-6"
      role="img"
      aria-label={`Fee drag charts. Total commissions ${money(totalFees)} across ${perTrade.length} trades, cumulative drag ${totalDragBps.toFixed(1)} basis points.`}
    >
      {/* ---- Cumulative fees over time ---- */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-medium">Cumulative fee drag over time</h4>
            <p className="text-xs text-muted-foreground">
              Buys stacked below sells. Line shows drag in bps of turnover.
            </p>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setScale("cost")}
              className={`text-xs px-2 py-1 rounded border ${
                scale === "cost" ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              {currency}
            </button>
            <button
              type="button"
              onClick={() => setScale("bps")}
              className={`text-xs px-2 py-1 rounded border ${
                scale === "bps" ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              bps
            </button>
          </div>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={daily} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                minTickGap={40}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                width={64}
                tick={AXIS_TICK}
                tickFormatter={(v: number) =>
                  scale === "cost"
                    ? v >= 1000
                      ? `${(v / 1000).toFixed(1)}k`
                      : v.toFixed(0)
                    : `${v.toFixed(0)}bps`
                }
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--popover-foreground)",
                }}
                formatter={(v: number, name: string) => {
                  if (name === "Drag (bps)") return [`${v.toFixed(1)} bps`, name];
                  return [money(Number(v)), name];
                }}
              />
              <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
              {scale === "cost" ? (
                <>
                  <Area
                    type="monotone"
                    dataKey="cumBuy"
                    stackId="fees"
                    name="Cumulative buy fees"
                    stroke={CHART_ROLE.positive}
                    fill={CHART_ROLE.positive}
                    fillOpacity={0.35}
                  />
                  <Area
                    type="monotone"
                    dataKey="cumSell"
                    stackId="fees"
                    name="Cumulative sell fees"
                    stroke={CHART_ROLE.negative}
                    fill={CHART_ROLE.negative}
                    fillOpacity={0.35}
                  />
                </>
              ) : (
                <Area
                  type="monotone"
                  dataKey="cumDragBps"
                  name="Drag (bps)"
                  stroke={CHART_ROLE.highlight}
                  fill={CHART_ROLE.highlight}
                  fillOpacity={0.35}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ---- Per-asset stacked bar ---- */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-medium">Fees by asset</h4>
            <p className="text-xs text-muted-foreground">
              Top {topSymbols.length} of {perSymbol.length} symbols by total commission. Buy vs sell
              split shown.
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] font-normal">
            Total {money(totalFees)}
          </Badge>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={topSymbols}
              layout="vertical"
              margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
            >
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                type="number"
                tick={AXIS_TICK}
                tickFormatter={(v: number) =>
                  v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)
                }
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                type="category"
                dataKey="symbol"
                tick={AXIS_TICK}
                width={80}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--popover-foreground)",
                }}
                formatter={(v: number, name: string, entry) => {
                  const row = entry?.payload as (typeof topSymbols)[number] | undefined;
                  const extra = row
                    ? ` · ${row.dragBps.toFixed(1)} bps of ${money(row.notional)}`
                    : "";
                  return [`${money(Number(v))}${extra}`, name];
                }}
              />
              <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
              <Bar dataKey="buyFee" stackId="fees" name="Buy fees" fill={CHART_ROLE.positive}>
                {topSymbols.map((_, i) => (
                  <Cell key={`buy-${i}`} fill={CHART_ROLE.positive} />
                ))}
              </Bar>
              <Bar dataKey="sellFee" stackId="fees" name="Sell fees" fill={CHART_ROLE.negative}>
                {topSymbols.map((_, i) => (
                  <Cell
                    key={`sell-${i}`}
                    fill={
                      CHART_SEQUENCE[i % CHART_SEQUENCE.length] === CHART_ROLE.negative
                        ? CHART_ROLE.negative
                        : CHART_ROLE.negative
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        Total commissions {money(totalFees)} across {perTrade.length} trades. Cumulative drag{" "}
        {totalDragBps.toFixed(1)} basis points of turnover. Top cost symbol:{" "}
        {topSymbols[0]?.symbol ?? "n/a"} at {money(topSymbols[0]?.commission ?? 0)}.
      </p>
    </div>
  );
}
