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
import { Loader2, Scale } from "lucide-react";
import { runCostScenarioBacktest } from "@/lib/batching-backtest.functions";
import type { CostScenarioResponse } from "@/lib/batching-backtest.functions";
import type { CostScenarioId } from "@/lib/backtest/cost-scenarios";
import { formatMoney } from "@/lib/format-money";
import {
  SAXO_LEGEND_PROPS,
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_METRIC,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
  edgeTicks,
} from "@/lib/saxo-chart";

const SCENARIO_COLOR: Record<CostScenarioId, string> = {
  best: SAXO_COLOR.up,
  base: SAXO_COLOR.crosshair,
  worst: SAXO_COLOR.down,
};

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function signedPct(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
}

function VerdictBadge({ verdict }: { verdict: CostScenarioResponse["verdict"] }) {
  if (verdict === "robust") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
        Cost-robust
      </Badge>
    );
  }
  if (verdict === "fragile") {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-400">
        Fragile to costs
      </Badge>
    );
  }
  if (verdict === "unprofitable") {
    return (
      <Badge variant="outline" className="border-rose-500/40 text-rose-400">
        Loss-making at any cost
      </Badge>
    );
  }
  return <Badge variant="outline">Inconclusive</Badge>;
}

/**
 * Best / base / worst friction replay. The headline is not the return — it is
 * how often the strategy avoided losses once fees, spreads and stamp duty are
 * assumed pessimistically rather than optimistically.
 */
export function CostScenarioBacktestCard({
  portfolioId,
  currency = "GBP",
}: {
  portfolioId: string;
  currency?: string;
}) {
  const [days, setDays] = useState<number>(365);
  const [rollingWindowDays, setRollingWindowDays] = useState<number>(21);
  const [result, setResult] = useState<CostScenarioResponse | null>(null);
  const run = useServerFn(runCostScenarioBacktest);

  const mutation = useMutation({
    mutationFn: (vars: { days: number; rollingWindowDays: number }) =>
      run({
        data: {
          portfolioId,
          days: vars.days,
          rollingWindowDays: vars.rollingWindowDays,
        },
      }),
    onSuccess: (r) => setResult(r),
    onError: (e: Error) => toast.error(e.message || "Scenario backtest failed"),
  });

  const chartData = useMemo(() => {
    if (!result) return [];
    const curves = result.scenarios.map(
      (s) => [s.scenario.id, new Map(s.arm.equityCurve.map((p) => [p.date, p.totalValue]))] as const,
    );
    const dates = result.scenarios[0]?.arm.equityCurve.map((p) => p.date) ?? [];
    return dates.map((date) => {
      const row: Record<string, string | number | null> = { date };
      for (const [id, map] of curves) row[id] = map.get(date) ?? null;
      return row;
    });
  }, [result]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" />
            Cost-scenario backtest
          </CardTitle>
          {result ? <VerdictBadge verdict={result.verdict} /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          The same strategy replayed under optimistic, live and pessimistic fee, spread and
          stamp-duty assumptions — and how often it avoided losses under each.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
            {[10, 21, 63].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setRollingWindowDays(w)}
                className={`rounded px-2 py-1 text-xs ${
                  rollingWindowDays === w ? "bg-muted font-medium" : "text-muted-foreground"
                }`}
              >
                {w}d window
              </button>
            ))}
          </div>
          <Button
            size="sm"
            onClick={() => mutation.mutate({ days, rollingWindowDays })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Run scenarios
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

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 text-left font-medium">Case</th>
                    <th className="py-1.5 text-right font-medium">Return</th>
                    <th className="py-1.5 text-right font-medium">Cost drag</th>
                    <th className="py-1.5 text-right font-medium">Max DD</th>
                    <th className="py-1.5 text-right font-medium">Loss-free months</th>
                    <th className="py-1.5 text-right font-medium">
                      Loss-free {result.rollingWindowDays}d windows
                    </th>
                    <th className="py-1.5 text-right font-medium">Days above start</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {result.scenarios.map((s) => (
                    <tr key={s.scenario.id} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5">
                        <span
                          className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: SCENARIO_COLOR[s.scenario.id] }}
                        />
                        {s.scenario.label}
                      </td>
                      <td
                        className={`py-1.5 text-right ${
                          s.returnPct >= 0 ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {signedPct(s.returnPct)}
                      </td>
                      <td className="py-1.5 text-right">{s.costBpsOfEquity.toFixed(1)}bps</td>
                      <td className="py-1.5 text-right">{s.maxDrawdownPct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">
                        {pct(s.monthsProfitablePct)}
                        <span className="ml-1 text-muted-foreground">/{s.monthsTotal}</span>
                      </td>
                      <td className="py-1.5 text-right">{pct(s.rollingProfitablePct)}</td>
                      <td className="py-1.5 text-right">{pct(s.daysAboveStartPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                  <Legend {...SAXO_LEGEND_PROPS} />
                  {result.scenarios.map((s) => (
                    <Line
                      key={s.scenario.id}
                      type="monotone"
                      dataKey={s.scenario.id}
                      name={s.scenario.label}
                      stroke={SCENARIO_COLOR[s.scenario.id]}
                      strokeWidth={
                        s.scenario.id === "base"
                          ? SAXO_METRIC.strokeWidth
                          : SAXO_METRIC.hairlineWidth
                      }
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {result.scenarios.map((s) => (
                <div
                  key={s.scenario.id}
                  className="rounded-lg border border-border/60 bg-card/40 p-3 text-[11px] text-muted-foreground"
                >
                  <div className="mb-1 text-xs font-medium text-foreground">
                    {s.scenario.label}
                  </div>
                  {s.scenario.assumption}
                </div>
              ))}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Best → worst gives up {signedPct(result.costSensitivityPct)} of return and{" "}
              {Math.round(result.frequencySensitivityPct)}pp of loss-free months, on{" "}
              {result.frictionSpreadBps.toFixed(1)}bps more friction. {result.bars} bars{" "}
              {result.from} → {result.to} · {result.symbols.join(", ")} · minimum ticket{" "}
              {formatMoney(result.minTicketBase, currency)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
