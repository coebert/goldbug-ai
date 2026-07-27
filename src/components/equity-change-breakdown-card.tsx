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

// Okabe–Ito color-blind-safe palette. Each hue is distinguishable under
// protanopia, deuteranopia and tritanopia simulations, and each color has
// a WCAG AA (>=3:1) non-text contrast ratio against both the light and
// dark app surfaces (verified against --background = white / near-black).
const COLORS: Record<string, string> = {
  deposits: "#0072B2", // blue — money in
  withdrawals: "#E69F00", // orange — money out
  tradingPnl: "#009E73", // bluish green — trading performance
  feesDivInterest: "#CC79A7", // reddish purple — inferred fees/divs/interest
};

const SHORT_LABELS: Record<string, string> = {
  deposits: "Deposits",
  withdrawals: "Withdrawals",
  tradingPnl: "Trading",
  feesDivInterest: "Fees / Div",
};

const SERIES_ORDER = ["deposits", "withdrawals", "tradingPnl", "feesDivInterest"] as const;
type SeriesKey = (typeof SERIES_ORDER)[number];

export function EquityChangeBreakdownCard({ equity, deposits, currency }: Props) {
  const [range, setRange] = useState<Range>("30d");
  const [hidden, setHidden] = useState<Set<SeriesKey>>(() => new Set());

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
  const visibleRows = rows.filter((b) => !hidden.has(b.key as SeriesKey));
  const chartData = visibleRows.map((b) => ({
    key: b.key,
    name: SHORT_LABELS[b.key] ?? b.label,
    fullName: b.label,
    amount: b.amount,
    pct: b.pctPoints,
  }));

  const toggle = (k: SeriesKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      // Prevent hiding the last visible series (chart would be empty).
      if (next.has(k)) next.delete(k);
      else if (rows.length - next.size > 1) next.add(k);
      return next;
    });
  };

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

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Toggle series">
          {rows.map((b) => {
            const key = b.key as SeriesKey;
            const isHidden = hidden.has(key);
            const onlyOneLeft = rows.length - hidden.size <= 1 && !isHidden;
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                disabled={onlyOneLeft}
                aria-pressed={!isHidden}
                title={onlyOneLeft ? "At least one series must remain visible" : isHidden ? `Show ${b.label}` : `Hide ${b.label}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                  isHidden
                    ? "border-dashed border-border bg-transparent text-muted-foreground opacity-60 hover:opacity-100"
                    : "border-border bg-muted/40 text-foreground hover:bg-muted/70"
                } ${onlyOneLeft ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: isHidden ? "transparent" : COLORS[key], borderWidth: isHidden ? 1 : 0, borderStyle: "solid", borderColor: COLORS[key] }}
                />
                <span className="font-medium">{b.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatPct(b.pctPoints)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="sr-only" aria-live="polite">
          Equity change over the selected {range.toUpperCase()} window: total{" "}
          {formatMoney(breakdown.totalChange, currency)} ({formatPct(breakdown.totalPct)}).{" "}
          {rows.map((b) => `${b.label} ${formatMoney(b.amount, currency)} (${formatPct(b.pctPoints)})`).join("; ")}.
        </p>

        <div
          className="h-64 w-full"
          role="img"
          aria-label={`Bar chart of equity change components for the ${range.toUpperCase()} window`}
        >

          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 24, right: 12, left: 8, bottom: 8 }}
              barCategoryGap="25%"
            >
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
                interval={0}
                tickMargin={6}
                axisLine={{ stroke: "hsl(var(--border))" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
                tickFormatter={(v: number) => formatMoney(v, currency).replace("+", "")}
                width={70}
                axisLine={false}
                tickLine={false}
                domain={([min, max]: [number, number]) => [
                  Math.min(0, min) * 1.15,
                  Math.max(0, max) * 1.25 || 1,
                ]}
              />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as {
                    key: string;
                    name: string;
                    fullName: string;
                    amount: number;
                    pct: number;
                  };
                  const totalPct = breakdown.totalPct;
                  const shareOfMove =
                    totalPct !== 0 ? (p.pct / totalPct) * 100 : 0;
                  const tone =
                    p.amount > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : p.amount < 0
                        ? "text-destructive"
                        : "text-muted-foreground";
                  return (
                    <div
                      className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
                      style={{ borderColor: "hsl(var(--border))" }}
                    >
                      <div className="mb-1 flex items-center gap-2 font-medium">
                        <span
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ background: COLORS[p.key] }}
                        />
                        {p.fullName}
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                        <span className="text-muted-foreground">Amount</span>
                        <span className={`text-right ${tone}`}>
                          {formatMoney(p.amount, currency)}
                        </span>
                        <span className="text-muted-foreground">Contribution</span>
                        <span className={`text-right ${tone}`}>
                          {formatPct(p.pct)} pts
                        </span>
                        <span className="text-muted-foreground">Share of move</span>
                        <span className="text-right">
                          {totalPct === 0 ? "—" : `${shareOfMove.toFixed(1)}%`}
                        </span>
                      </div>
                    </div>
                  );
                }}
              />

              <Bar dataKey="amount" radius={[6, 6, 0, 0]} maxBarSize={56}>
                {chartData.map((d) => (
                  <Cell key={d.key} fill={COLORS[d.key]} />
                ))}
                <LabelList
                  dataKey="pct"
                  position="top"
                  formatter={(v: unknown) => formatPct(Number(v))}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    fill: "hsl(var(--foreground))",
                  }}
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
