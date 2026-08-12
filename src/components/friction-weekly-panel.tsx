import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FrictionWeekRow, WeeklyFrictionLedger } from "@/lib/friction-kpi";
import { formatMoney } from "@/lib/format-money";
import {
  SAXO_AXIS,
  SAXO_GRID,
  SAXO_REFERENCE_LINE,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";

const COMMISSION = "var(--saxo-down)";
const TAX = "var(--saxo-crosshair)";
const SPREAD = "var(--saxo-axis)";

function weekLabel(weekStart: string): string {
  if (!weekStart) return "—";
  const d = new Date(`${weekStart}T00:00:00.000Z`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function bps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}bps`;
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

/**
 * Week-by-week cost ledger for a real-cash book: what each week's trading
 * cost, split into broker commission, stamp duty and levies, and the spread
 * we crossed — beside how much was traded to incur it. A losing month is
 * usually one or two weeks of heavy turnover, and this is where that shows.
 */
export function FrictionWeeklyPanel({
  weekly,
  currency,
}: {
  weekly: WeeklyFrictionLedger;
  currency: string;
}) {
  const [metric, setMetric] = useState<"money" | "bps">("money");
  const weeks = weekly.weeks;

  const chartData = useMemo(
    () =>
      weeks.map((w) => {
        const scale =
          metric === "bps" && w.turnoverBase > 0 ? 10_000 / w.turnoverBase : 1;
        return {
          week: weekLabel(w.weekStart),
          commission: w.components.commissionBase * scale,
          tax: w.components.taxBase * scale,
          spread: w.components.spreadBase * scale,
          row: w,
        };
      }),
    [weeks, metric],
  );

  if (weeks.length === 0) return null;

  const worst = weeks.reduce((a, b) => (b.chargedBase > a.chargedBase ? b : a), weeks[0]!);
  const totals = weekly.totals;

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Weekly trading costs</p>
          <p className="text-xs text-muted-foreground">
            Commission, stamp duty and spread per week, with how much you traded
            to pay it.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-border/60 p-0.5 text-xs">
          {(["money", "bps"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={`rounded px-2 py-1 ${
                metric === m ? "bg-primary/15 text-primary" : "text-muted-foreground"
              }`}
            >
              {m === "money" ? currency : "bps of turnover"}
            </button>
          ))}
        </div>
      </div>

      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...SAXO_GRID} />
            <XAxis dataKey="week" {...SAXO_AXIS} />
            <YAxis {...SAXO_AXIS} width={48} />
            {metric === "bps" && (
              <ReferenceLine
                y={weekly.weeklyBudgetBps}
                {...SAXO_REFERENCE_LINE}
                label={{ value: "budget", position: "insideTopRight", fontSize: 10 }}
              />
            )}
            <Tooltip
              cursor={SAXO_TOOLTIP_CURSOR}
              contentStyle={SAXO_TOOLTIP_CONTENT}
              labelStyle={SAXO_TOOLTIP_LABEL}
              formatter={(value: number, name: string) => [
                metric === "money"
                  ? formatMoney(Number(value) || 0, currency, 2)
                  : `${(Number(value) || 0).toFixed(1)}bps`,
                name,
              ]}
            />
            <Bar dataKey="commission" name="Commission" stackId="c" fill={COMMISSION} />
            <Bar dataKey="tax" name="Stamp duty & levies" stackId="c" fill={TAX} />
            <Bar dataKey="spread" name="Spread crossed" stackId="c" fill={SPREAD} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 pr-2 font-normal">Week</th>
              <th className="py-1 pr-2 text-right font-normal">Trades</th>
              <th className="py-1 pr-2 text-right font-normal">Turnover</th>
              <th className="py-1 pr-2 text-right font-normal">Commission</th>
              <th className="py-1 pr-2 text-right font-normal">Duty</th>
              <th className="py-1 pr-2 text-right font-normal">Spread</th>
              <th className="py-1 pr-2 text-right font-normal">Total</th>
              <th className="py-1 text-right font-normal">of NAV</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {[...weeks].reverse().map((w) => (
              <WeekRow key={w.weekStart} row={w} currency={currency} budget={weekly.weeklyBudgetBps} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border/60 font-medium tabular-nums">
              <td className="py-1 pr-2">All weeks</td>
              <td className="py-1 pr-2 text-right">{totals.tickets}</td>
              <td className="py-1 pr-2 text-right">{formatMoney(totals.turnoverBase, currency, 0)}</td>
              <td className="py-1 pr-2 text-right">
                {formatMoney(totals.components.commissionBase, currency, 0)}
              </td>
              <td className="py-1 pr-2 text-right">
                {formatMoney(totals.components.taxBase, currency, 0)}
              </td>
              <td className="py-1 pr-2 text-right">
                {formatMoney(totals.components.spreadBase, currency, 0)}
              </td>
              <td className="py-1 pr-2 text-right">{formatMoney(totals.chargedBase, currency, 0)}</td>
              <td className="py-1 text-right">{bps(totals.chargedBpsOfNav)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Your worst week was {weekLabel(worst.weekStart)}:{" "}
        {formatMoney(worst.chargedBase, currency, 2)} of cost on{" "}
        {formatMoney(worst.turnoverBase, currency, 0)} traded across {worst.tickets}{" "}
        {worst.tickets === 1 ? "trade" : "trades"} ({bps(worst.chargedBpsOfTurnover)} of
        turnover
        {worst.turnoverRatio == null ? "" : `, churning ${pct(worst.turnoverRatio)} of the book`}
        ). Anything above {bps(weekly.weeklyBudgetBps)} of NAV in a week is over the
        cost budget.
      </p>
    </div>
  );
}

function WeekRow({
  row,
  currency,
  budget,
}: {
  row: FrictionWeekRow;
  currency: string;
  budget: number;
}) {
  const over = row.chargedBpsOfNav != null && row.chargedBpsOfNav > budget;
  return (
    <tr className="border-t border-border/40">
      <td className="py-1 pr-2 whitespace-nowrap">{weekLabel(row.weekStart)}</td>
      <td className="py-1 pr-2 text-right">
        {row.tickets}
        <span className="text-muted-foreground"> ({row.buyTickets}b/{row.sellTickets}s)</span>
      </td>
      <td className="py-1 pr-2 text-right">{formatMoney(row.turnoverBase, currency, 0)}</td>
      <td className="py-1 pr-2 text-right">
        {formatMoney(row.components.commissionBase, currency, 0)}
      </td>
      <td className="py-1 pr-2 text-right">{formatMoney(row.components.taxBase, currency, 0)}</td>
      <td className="py-1 pr-2 text-right">{formatMoney(row.components.spreadBase, currency, 0)}</td>
      <td className="py-1 pr-2 text-right">{formatMoney(row.chargedBase, currency, 2)}</td>
      <td className={`py-1 text-right ${over ? "text-rose-400" : ""}`}>
        {bps(row.chargedBpsOfNav)}
      </td>
    </tr>
  );
}
