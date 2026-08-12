import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Loader2, Layers } from "lucide-react";
import { runOrderBatchingBacktest } from "@/lib/batching-backtest.functions";
import type { OrderBatchingAbResponse } from "@/lib/batching-backtest.functions";
import { formatMoney } from "@/lib/format-money";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_METRIC,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
  edgeTicks,
} from "@/lib/saxo-chart";

const WINDOWS = [24, 48, 96, 168] as const;
type WindowHours = (typeof WINDOWS)[number];

const BATCHED = SAXO_COLOR.up;
const UNBATCHED = SAXO_COLOR.crosshair;
const BUY_HOLD = SAXO_COLOR.down;
const MOMENTUM = SAXO_COLOR.axis;

function bps(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}bps`;
}

function signed(v: number, digits = 1, unit = "bps"): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}${unit}`;
}

function VerdictBadge({ verdict }: { verdict: OrderBatchingAbResponse["verdict"] }) {
  if (verdict === "supported") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
        Batching pays
      </Badge>
    );
  }
  if (verdict === "costly_risk") {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-400">
        Cheaper but riskier
      </Badge>
    );
  }
  if (verdict === "not_supported") {
    return (
      <Badge variant="outline" className="border-rose-500/40 text-rose-400">
        Batching costs more
      </Badge>
    );
  }
  return <Badge variant="outline">No clear difference</Badge>;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold tabular-nums ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : ""
        }`}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * Replays the same signal stream over your own price history twice — with the
 * order-batching window on and off — and reports whether parking sub-minimum
 * buys actually reduces commission drag, and what it costs in drawdown.
 */
export function BatchingBacktestCard({
  portfolioId,
  currency = "GBP",
}: {
  portfolioId: string;
  currency?: string;
}) {
  const [windowHours, setWindowHours] = useState<WindowHours>(96);
  const [days, setDays] = useState<number>(365);
  const [result, setResult] = useState<OrderBatchingAbResponse | null>(null);
  const run = useServerFn(runOrderBatchingBacktest);

  const mutation = useMutation({
    mutationFn: (vars: { windowHours: number; days: number }) =>
      run({ data: { portfolioId, windowHours: vars.windowHours, days: vars.days } }),
    onSuccess: (r) => setResult(r),
    onError: (e: Error) => toast.error(e.message || "Backtest failed"),
  });

  const chartData = useMemo(() => {
    if (!result) return [];
    const un = new Map(result.unbatched.equityCurve.map((p) => [p.date, p.totalValue]));
    const byId = new Map(
      (result.benchmarks?.arms ?? []).map((a) => [
        a.id,
        new Map(a.equityCurve.map((p) => [p.date, p.totalValue])),
      ]),
    );
    const bh = byId.get("buy_and_hold");
    const mo = byId.get("momentum_only");
    return result.batched.equityCurve.map((p) => ({
      date: p.date,
      batched: p.totalValue,
      unbatched: un.get(p.date) ?? null,
      buyHold: bh?.get(p.date) ?? null,
      momentum: mo?.get(p.date) ?? null,
    }));
  }, [result]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" />
            Order-batching backtest
          </CardTitle>
          {result ? <VerdictBadge verdict={result.verdict} /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Same signals, same bars, one difference: sub-minimum buys are parked and released as one
          larger ticket instead of being skipped. Does that cut costs without deepening drawdowns?
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowHours(w)}
                className={`rounded px-2 py-1 text-xs ${
                  windowHours === w ? "bg-muted font-medium" : "text-muted-foreground"
                }`}
              >
                {w}h
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
            {[180, 365, 730].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded px-2 py-1 text-xs ${
                  days === d ? "bg-muted font-medium" : "text-muted-foreground"
                }`}
              >
                {d === 730 ? "2y" : d === 365 ? "1y" : "6m"}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            onClick={() => mutation.mutate({ windowHours, days })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Run replay
          </Button>
        </div>

        {!result ? (
          <p className="text-xs text-muted-foreground">
            Runs on your traded symbols using cached daily closes. Read-only — nothing is written to
            the ledger.
          </p>
        ) : (
          <>
            <p className="text-sm">{result.summary}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Cost saved"
                value={signed(result.costSavingBps)}
                hint="of starting equity"
                tone={result.costSavingBps > 0 ? "good" : result.costSavingBps < 0 ? "bad" : undefined}
              />
              <Stat
                label="Drawdown delta"
                value={signed(result.drawdownDeltaPct, 2, "pp")}
                hint="batched vs unbatched"
                tone={result.drawdownDeltaPct > 0 ? "bad" : result.drawdownDeltaPct < 0 ? "good" : undefined}
              />
              <Stat
                label="Return delta"
                value={signed(result.returnDeltaPct, 2, "pp")}
                hint="batched vs unbatched"
                tone={result.returnDeltaPct > 0 ? "good" : result.returnDeltaPct < 0 ? "bad" : undefined}
              />
              <Stat
                label="Tickets saved"
                value={`${result.ticketsSaved > 0 ? "−" : result.ticketsSaved < 0 ? "+" : ""}${Math.abs(result.ticketsSaved)}`}
                hint={`${result.batched.tickets} vs ${result.unbatched.tickets} routed`}
                tone={result.ticketsSaved > 0 ? "good" : undefined}
              />
            </div>

            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid {...SAXO_GRID} />
                  <XAxis
                    {...SAXO_AXIS}
                    dataKey="date"
                    ticks={edgeTicks(chartData, "date") as string[]}
                  />
                  <YAxis
                    {...SAXO_AXIS}
                    width={62}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => formatMoney(v, currency, 0)}
                  />
                  <Tooltip
                    contentStyle={SAXO_TOOLTIP_CONTENT}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                    cursor={SAXO_TOOLTIP_CURSOR}
                    formatter={(v: number, name: string) => [formatMoney(v, currency), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: SAXO_METRIC.tickFontSize, color: SAXO_COLOR.axis }} />
                  <Line
                    type="monotone"
                    dataKey="batched"
                    name="Batching on"
                    stroke={BATCHED}
                    strokeWidth={SAXO_METRIC.strokeWidth}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="unbatched"
                    name="Batching off"
                    stroke={UNBATCHED}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="buyHold"
                    name="Buy & hold"
                    stroke={BUY_HOLD}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    strokeDasharray="4 3"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="momentum"
                    name="Momentum only"
                    stroke={MOMENTUM}
                    strokeWidth={SAXO_METRIC.hairlineWidth}
                    strokeDasharray="2 3"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 text-left font-medium">Arm</th>
                    <th className="py-1.5 text-right font-medium">Tickets</th>
                    <th className="py-1.5 text-right font-medium">Cost</th>
                    <th className="py-1.5 text-right font-medium">Cost / turnover</th>
                    <th className="py-1.5 text-right font-medium">Max DD</th>
                    <th className="py-1.5 text-right font-medium">Return</th>
                    <th className="py-1.5 text-right font-medium">Signals lost</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[
                    { key: "batched", label: "Batching on", ...result.batched },
                    { key: "unbatched", label: "Batching off", ...result.unbatched },
                    ...(result.benchmarks?.arms ?? []).map((a) => ({ key: a.id, label: a.label, ...a })),
                  ].map((arm) => (
                    <tr key={arm.key} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5">{arm.label}</td>
                      <td className="py-1.5 text-right">{arm.tickets}</td>
                      <td className="py-1.5 text-right">{formatMoney(arm.totalCostBase, currency)}</td>
                      <td className="py-1.5 text-right">{bps(arm.costBpsOfTurnover)}</td>
                      <td className="py-1.5 text-right">{arm.maxDrawdownPct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.returnPct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.signalsSkipped + arm.parkedLost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.benchmarks ? (
              <div className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Versus baselines
                </div>
                <p className="mt-1 text-xs">{result.benchmarks.summary}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {result.benchmarks.comparisons.map((c) => (
                    <div key={c.id} className="rounded-md border border-border/40 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{c.label}</span>
                        <Badge
                          variant="outline"
                          className={
                            c.outcome === "beats"
                              ? "border-emerald-500/40 text-emerald-400"
                              : c.outcome === "lags"
                                ? "border-rose-500/40 text-rose-400"
                                : ""
                          }
                        >
                          {c.outcome === "beats" ? "Ahead" : c.outcome === "lags" ? "Behind" : "Level"}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                        <span>Return {signed(c.returnDeltaPct, 2, "pp")}</span>
                        <span>Max DD {signed(c.drawdownDeltaPct, 2, "pp")}</span>
                        <span>Sharpe {signed(c.sharpeDelta, 2, "")}</span>
                        <span>Cost {signed(c.costDeltaBps)}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{c.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              {result.bars} bars {result.from} → {result.to} · {result.symbols.join(", ")} · minimum
              ticket {formatMoney(result.minTicketBase, currency)} · {result.windowHours}h window ·{" "}
              {result.signals} signals
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
