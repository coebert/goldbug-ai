// Dashboard card: how the strategy's backtest curve compares with what the
// live book actually did, over the days both cover. The point of the card is
// the GAP — strategy edge that survived real fills vs edge lost to spread,
// slippage, fees and missed entries.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getBacktestVsReal } from "@/lib/backtest-vs-real.functions";
import { verdictFor } from "@/lib/backtest-vs-real";
import { formatUk } from "@/lib/uk-time";

function money(n: number, ccy: string): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}${ccy} ${Math.abs(n).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down" | "flat";
}) {
  const cls =
    tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-400" : "";
  return (
    <div className="rounded-lg border p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

export function BacktestVsRealCard({
  portfolioId,
  currency = "GBP",
}: {
  portfolioId: string;
  currency?: string;
}) {
  const [runId, setRunId] = useState<string | null>(null);
  const fetchCompare = useServerFn(getBacktestVsReal);
  const q = useQuery({
    queryKey: ["backtest-vs-real", portfolioId, runId],
    queryFn: () => fetchCompare({ data: { portfolioId, runId } }),
    staleTime: 60_000,
  });

  const c = q.data;
  const chart = useMemo(
    () =>
      (c?.points ?? []).map((p) => ({
        date: p.date,
        Backtest: Number(p.backtest.toFixed(3)),
        Real: Number(p.real.toFixed(3)),
        Gap: Number(p.gap.toFixed(3)),
        MoneyGap: Number(p.moneyGap.toFixed(2)),
      })),
    [c],
  );


  return (
    <Card data-testid="backtest-vs-real-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <CardTitle className="text-base">Backtest vs real P&amp;L</CardTitle>
          <p className="text-xs text-muted-foreground">
            {q.isLoading ? "Lining the curves up…" : c ? verdictFor(c) : "—"}
          </p>
        </div>
        {(c?.availableRuns.length ?? 0) > 1 && (
          <Select
            value={runId ?? c?.runId ?? undefined}
            onValueChange={(v) => setRunId(v)}
          >
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue placeholder="Choose a run" />
            </SelectTrigger>
            <SelectContent>
              {(c?.availableRuns ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id} className="text-xs">
                  {formatUk(r.ran_at, { dateStyle: "medium", timeStyle: "short" })}
                  {r.risk_level ? ` · ${r.risk_level}` : ""} · {r.days}d
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError && (
          <p className="text-xs text-rose-400">
            Couldn't load the comparison: {(q.error as Error).message}
          </p>
        )}
        {c?.note && <p className="text-xs text-muted-foreground">{c.note}</p>}
        {c && c.backtestBaseShifts > 0 && (
          <p className="text-xs text-amber-400">
            {c.backtestBaseShifts === 1 ? "One day in" : `${c.backtestBaseShifts} days in`} the saved
            run moved the account by more than 25% in a single step — a deposit or a rebuilt
            history, not trading. {c.backtestBaseShifts === 1 ? "It has" : "They have"} been
            removed, so the backtest return shown here is lower than the raw saved figure.
          </p>
        )}

        {c && c.days >= 2 && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {c.days} shared days
              </Badge>
              <span className="tabular-nums">
                {c.from} → {c.to}
              </span>
              {c.runRanAt && (
                <span>
                  run {formatUk(c.runRanAt, { dateStyle: "medium" })}
                  {c.runRiskLevel ? ` · ${c.runRiskLevel}` : ""}
                </span>
              )}
              {(c.droppedBacktestDays > 0 || c.droppedRealDays > 0) && (
                <span>
                  · {c.droppedBacktestDays + c.droppedRealDays} non-overlapping days excluded
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Backtest return"
                value={pct(c.backtestStats.totalReturnPct)}
                sub={money(c.backtestPnl, currency)}
                tone={c.backtestStats.totalReturnPct >= 0 ? "up" : "down"}
              />
              <Stat
                label="Real return"
                value={pct(c.realStats.totalReturnPct)}
                sub={money(c.realPnl, currency)}
                tone={c.realStats.totalReturnPct >= 0 ? "up" : "down"}
              />
              <Stat
                label="Money lost to execution"
                value={money(c.moneyLost, currency)}
                sub={`worst ${money(c.worstMoneyLost, currency)}`}
                tone={c.moneyLost < 0 ? "down" : "up"}
              />
              <Stat
                label="Broker fees paid"
                value={money(c.fees, currency)}
                sub={`${c.feesBps.toFixed(0)}bps of start${
                  c.feeShareOfGap != null
                    ? ` · ${(c.feeShareOfGap * 100).toFixed(0)}% of the gap`
                    : ""
                }`}
                tone={c.fees > 0 ? "down" : "flat"}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat
                label="Underperformance days"
                value={`${c.underperformDays} days`}
                sub="real daily money change below backtest"
                tone={c.underperformDays > 0 ? "down" : "flat"}
              />
              <Stat
                label="Recovery delay"
                value={c.daysBehind == null ? "—" : `${c.daysBehind} days`}
                sub={c.daysBehind == null ? "not behind at the latest point" : "behind the backtest path"}
                tone={c.daysBehind != null && c.daysBehind > 0 ? "down" : "flat"}
              />
              <Stat
                label="Exact live equity"
                value={money(c.realEquityNow, currency)}
                sub={`shadow ${money(c.shadowEquityNow, currency)}`}
                tone="flat"
              />
            </div>

            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    minTickGap={32}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    width={52}
                    tick={{ fontSize: 10 }}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => v.toFixed(1)}
                    tickLine={false}
                    axisLine={false}
                    label={{
                      value: "Index (=100 at start)",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 10 },
                    }}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [v.toFixed(2), name]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="Backtest"
                    stroke="#0072B2"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="Real"
                    stroke="#D55E00"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* The gap itself: how much money live execution is behind the
                strategy's own path, day by day. Below zero = live is behind. */}
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="btGapFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#D55E00" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#D55E00" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    minTickGap={32}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    width={62}
                    tick={{ fontSize: 10 }}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => v.toFixed(0)}
                    tickLine={false}
                    axisLine={false}
                    label={{
                      value: "Gap (money)",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 10 },
                    }}
                  />
                  <Tooltip
                    formatter={(v: number) => [money(v, currency), "Live minus backtest"]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.4} />
                  <Area
                    type="monotone"
                    dataKey="MoneyGap"
                    name="Live minus backtest"
                    stroke="#D55E00"
                    strokeWidth={2}
                    fill="url(#btGapFill)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>


            <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
              <Stat
                label="Backtest max drawdown"
                value={`${c.backtestStats.maxDrawdownPct.toFixed(2)}%`}
                tone="down"
              />
              <Stat
                label="Real max drawdown"
                value={`${c.realStats.maxDrawdownPct.toFixed(2)}%`}
                tone="down"
              />
              <Stat
                label="Drawdown gap"
                value={pct(c.drawdownGapPct)}
                sub={c.drawdownGapPct < 0 ? "real fell further" : "real held up better"}
                tone={c.drawdownGapPct >= 0 ? "up" : "down"}
              />
              <Stat
                label="Up days"
                value={`${c.realStats.upDayPct?.toFixed(0) ?? "—"}% real`}
                sub={`${c.backtestStats.upDayPct?.toFixed(0) ?? "—"}% backtest`}
              />
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The chart is an indexed shape comparison for readability. The money tiles keep the
              live curve in its exact flow-netted currency: shadow equity applies the backtest's
              day-by-day path to the same starting capital, so execution loss is not a rebased
              estimate. Underperformance days count daily money shortfalls; recovery delay measures
              how many shared days behind the backtest's path live equity sits.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
