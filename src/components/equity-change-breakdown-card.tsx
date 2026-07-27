import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PieChart as PieChartIcon } from "lucide-react";
import {
  computeEquityChangeBreakdown,
  type DepositLike,
  type EquityPoint,
} from "@/lib/equity-change-breakdown";

type Range = "7d" | "30d" | "90d" | "ytd" | "all";

interface Props {
  equity: EquityPoint[];
  deposits: DepositLike[];
  currency: string;
}

const RANGE_DAYS: Record<Exclude<Range, "ytd" | "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function sliceEquityByRange(equity: EquityPoint[], range: Range): EquityPoint[] {
  if (range === "all" || equity.length === 0) return equity;
  if (range === "ytd") {
    const year = equity[equity.length - 1].snapshot_date.slice(0, 4);
    return equity.filter((r) => r.snapshot_date >= `${year}-01-01`);
  }
  const days = RANGE_DAYS[range];
  const endDate = new Date(equity[equity.length - 1].snapshot_date + "T00:00:00Z");
  const cutoff = new Date(endDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const sliced = equity.filter((r) => r.snapshot_date >= cutoffStr);
  return sliced.length >= 2 ? sliced : equity;
}

function formatMoney(v: number, currency: string) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Math.abs(v))}`;
}

function formatPct(v: number) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

const COLORS: Record<string, string> = {
  deposits: "hsl(var(--chart-1, 214 90% 52%))",
  withdrawals: "hsl(var(--chart-2, 20 90% 55%))",
  tradingPnl: "hsl(var(--chart-3, 142 70% 45%))",
  feesDivInterest: "hsl(var(--chart-4, 260 60% 60%))",
};

export function EquityChangeBreakdownCard({ equity, deposits, currency }: Props) {
  const [range, setRange] = useState<Range>("30d");

  const breakdown = useMemo(
    () => computeEquityChangeBreakdown(sliceEquityByRange(equity, range), deposits),
    [equity, deposits, range],
  );

  if (!breakdown) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <PieChartIcon className="h-4 w-4" /> Equity change breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Not enough equity history yet to attribute % change.
          </p>
        </CardContent>
      </Card>
    );
  }

  const rows = breakdown.buckets;
  const chartData = rows.map((b) => ({
    key: b.key,
    name: b.label,
    amount: b.amount,
    pct: b.pctPoints,
  }));

  const totalIsNegative = breakdown.totalChange < 0;
  const totalTone = totalIsNegative ? "text-destructive" : breakdown.totalChange > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <PieChartIcon className="h-4 w-4" /> Equity change breakdown
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            How the {formatPct(breakdown.totalPct)} total equity move splits between
            external cash-flows and trading. Fees / dividends / interest are inferred
            from small (&lt; {formatMoney(25, currency).replace("+", "")}) cash-flow events.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {(["7d", "30d", "90d", "ytd", "all"] as Range[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setRange(r)}
            >
              {r.toUpperCase()}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div>
            <div className="text-xs text-muted-foreground">Total change</div>
            <div className={`text-xl font-semibold tabular-nums ${totalTone}`}>
              {formatMoney(breakdown.totalChange, currency)}{" "}
              <span className="text-sm font-medium">({formatPct(breakdown.totalPct)})</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatMoney(breakdown.startEquity, currency).replace("+", "")} →{" "}
            {formatMoney(breakdown.endEquity, currency).replace("+", "")}
          </div>
        </div>

        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
              barCategoryGap="20%"
            >
              <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => formatMoney(v, currency).replace("+", "")}
                width={70}
              />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                formatter={(value: number, _name, entry) => {
                  const pct = (entry?.payload as { pct: number } | undefined)?.pct ?? 0;
                  return [`${formatMoney(value, currency)}  (${formatPct(pct)})`, "Contribution"];
                }}
                labelClassName="text-xs"
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                {chartData.map((d) => (
                  <Cell key={d.key} fill={COLORS[d.key]} />
                ))}
                <LabelList
                  dataKey="pct"
                  position="top"
                  formatter={(v: unknown) => formatPct(Number(v))}
                  style={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Component</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">% of start</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.key} className="border-t">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: COLORS[b.key] }}
                      />
                      {b.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(b.amount, currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPct(b.pctPoints)}
                  </td>
                </tr>
              ))}
              <tr className="border-t bg-muted/20 font-medium">
                <td className="px-3 py-2">Total equity change</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(breakdown.totalChange, currency)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatPct(breakdown.totalPct)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            % change excludes deposits &amp; external cash-flows
          </Badge>
          <Badge variant="outline" className="font-normal">
            Trading P&amp;L = Δequity − external flows
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
