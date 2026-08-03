// Risk-dial equity-curve comparison.
//
// Runs the same long-horizon backtest once per dial position (1..5) and
// overlays the curves, indexed to 100 at inception, so the effect of position
// sizing and buy/sell aggressiveness is visible rather than theoretical.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart as LineChartIcon } from "lucide-react";
import { toast } from "sonner";
import { runRiskSweepFn } from "@/lib/risk-sweep.functions";
import type { RiskSweepResult } from "@/lib/risk-sweep.server";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";


const LEVEL_COLORS: Record<number, string> = {
  1: "var(--chart-5)",
  2: "var(--chart-4)",
  3: "var(--chart-1)",
  4: "var(--chart-2)",
  5: "var(--chart-3)",
};

/** Merge per-level curves into one row-per-date shape for Recharts. */
function mergeCurves(res: RiskSweepResult) {
  const byDate = new Map<string, Record<string, number | string>>();
  for (const leg of res.legs) {
    for (const p of leg.curve) {
      const row = byDate.get(p.date) ?? { date: p.date };
      row[`l${leg.level}`] = Number(p.value.toFixed(2));
      byDate.set(p.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export function RiskCurveComparisonCard({
  portfolioId,
  currentLevel,
}: {
  portfolioId: string;
  currentLevel: number;
}) {
  const [result, setResult] = useState<RiskSweepResult | null>(null);
  const [years, setYears] = useState(5);
  const runSweep = useServerFn(runRiskSweepFn);

  const sweep = useMutation({
    mutationFn: async () => runSweep({ data: { portfolioId, years } }),
    onSuccess: (r) => setResult(r),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not run the risk comparison"),
  });

  const rows = result ? mergeCurves(result) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LineChartIcon className="h-4 w-4 text-primary" /> Risk level vs equity curve
        </CardTitle>
        <CardDescription>
          Replays the strategy at every dial position over the last {years} years, indexed to
          100 at the start. Higher levels size up and chase targets harder — usually more
          return, always more drawdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {[3, 5, 10].map((y) => (
            <Button
              key={y}
              size="sm"
              variant={years === y ? "default" : "outline"}
              onClick={() => setYears(y)}
              disabled={sweep.isPending}
            >
              {y}y
            </Button>
          ))}
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => sweep.mutate()}
            disabled={sweep.isPending}
          >
            {sweep.isPending ? "Running…" : result ? "Re-run" : "Compare risk levels"}
          </Button>
        </div>

        {sweep.isPending && <Skeleton className="h-64 w-full rounded-md" />}

        {!sweep.isPending && !result && (
          <p className="text-sm text-muted-foreground">
            Run the comparison to see how each risk level would have performed on the same
            data and the same costs.
          </p>
        )}

        {!sweep.isPending && result && (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    {...AXIS_PROPS}
                    minTickGap={40}
                    tickMargin={6}
                    tickFormatter={(d: string) => String(d).slice(0, 7)}
                  />
                  <YAxis {...AXIS_PROPS} width={56} domain={["auto", "auto"]} />

                  <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} />

                  {result.legs.map((leg) => (
                    <Line
                      key={leg.level}
                      type="monotone"
                      dataKey={`l${leg.level}`}
                      name={`${leg.level}. ${leg.name}`}
                      stroke={LEVEL_COLORS[leg.level]}
                      strokeWidth={leg.level === result.current_level ? 2.5 : 1.4}
                      strokeOpacity={leg.level === result.current_level ? 1 : 0.75}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Level</th>
                    <th className="py-1 pr-2 font-medium">Return</th>
                    <th className="py-1 pr-2 font-medium">CAGR</th>
                    <th className="py-1 pr-2 font-medium">Max DD</th>
                    <th className="py-1 pr-2 font-medium">Sharpe</th>
                    <th className="py-1 pr-2 font-medium">Size / Buy / Sell</th>
                  </tr>
                </thead>
                <tbody>
                  {result.legs.map((leg) => (
                    <tr
                      key={leg.level}
                      className={
                        leg.level === result.current_level
                          ? "border-t border-border bg-primary/5"
                          : "border-t border-border"
                      }
                    >
                      <td className="py-1.5 pr-2">
                        <span
                          className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: LEVEL_COLORS[leg.level] }}
                        />
                        {leg.level}. {leg.name}
                        {leg.level === result.current_level && (
                          <span className="ml-1 text-xs text-primary">(current)</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {pct(leg.metrics?.totalReturnPct)}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">{pct(leg.metrics?.cagrPct)}</td>
                      <td className="py-1.5 pr-2 tabular-nums text-destructive">
                        {leg.metrics ? `${leg.metrics.maxDrawdownPct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {leg.metrics ? leg.metrics.sharpe.toFixed(2) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                        {leg.sizeMult.toFixed(2)}× / {leg.buy.toFixed(2)}× /{" "}
                        {leg.sell.toFixed(2)}×
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Backtested on the shared long-horizon universe with the same commission and
              slippage assumptions. Past behaviour is not a forecast.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
