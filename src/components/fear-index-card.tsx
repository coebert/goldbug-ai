import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFearIndexSnapshot } from "@/lib/fear-index.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartFrame } from "@/components/chart-frame";
import { Gauge } from "lucide-react";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const SESSION_OPTIONS = [14, 30, 90] as const;


interface Props {
  portfolioId: string;
  active?: boolean;
  /** Base currency for the sizing comparison amounts. */
  currency?: string;
}

function toneFor(score: number) {
  if (score >= 80) return { bar: "bg-destructive", text: "text-destructive", border: "border-destructive/40" };
  if (score >= 60) return { bar: "bg-amber-500", text: "text-amber-500", border: "border-amber-500/40" };
  if (score > 40) return { bar: "bg-primary", text: "text-primary", border: "border-border" };
  if (score > 20) return { bar: "bg-emerald-500", text: "text-emerald-500", border: "border-emerald-500/30" };
  return { bar: "bg-sky-500", text: "text-sky-500", border: "border-sky-500/30" };
}

/**
 * Fear-index gauge: the market-fear score the last run used, plus exactly how
 * that score changed buy sizing (or blocked buys entirely).
 */
export function FearIndexCard({ portfolioId, active = true, currency = "GBP" }: Props) {
  const fetchSnapshot = useServerFn(getFearIndexSnapshot);
  const [sessions, setSessions] = useState<number>(30);
  const [onlyResized, setOnlyResized] = useState(false);
  const query = useQuery({
    queryKey: ["fear-index", portfolioId, sessions],
    queryFn: () => fetchSnapshot({ data: { portfolio_id: portfolioId, sessions } }),
    enabled: active,
    staleTime: 60_000,
  });

  const d = query.data;
  const history = d?.history ?? [];
  const impacts = d?.impacts ?? [];
  const resized = impacts.filter((i) => i.deltaPct != null && Math.abs(i.deltaPct) >= 0.5);
  const visibleImpacts = onlyResized ? resized : impacts;
  const netDelta = resized.reduce(
    (sum, i) => sum + (i.unadjustedValue != null ? i.value - i.unadjustedValue : 0),
    0,
  );
  const score = d?.score ?? null;
  const tone = toneFor(score ?? 50);

  return (
    <Card className={score != null ? tone.border : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className={`h-4 w-4 ${score != null ? tone.text : "text-muted-foreground"}`} aria-hidden />
            Market fear index
          </CardTitle>
          {d?.runDate && (
            <span className="text-xs text-muted-foreground">Last run {d.runDate}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!query.isLoading && score == null && (
          <p className="text-sm text-muted-foreground">
            No fear-index reading yet — it appears after the next trading run.
          </p>
        )}

        {score != null && (
          <>
            <div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={`text-3xl font-semibold tabular-nums ${tone.text}`}>
                  {score.toFixed(0)}
                </span>
                <span className="text-sm text-muted-foreground">/ 100</span>
                {d?.labelText && <Badge variant="secondary">{d.labelText}</Badge>}
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${tone.bar}`}
                  style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
                  role="meter"
                  aria-valuenow={Math.round(score)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Market fear index"
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span>Calm / greed</span>
                <span>Neutral</span>
                <span>Panic</span>
              </div>
            </div>

            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                Effect on new buys:{" "}
                {d?.sizeMultiplier != null ? (
                  <span className={tone.text}>
                    ×{d.sizeMultiplier.toFixed(2)}
                    {d.sizeMultiplier < 1
                      ? ` (buys shrunk ${Math.round((1 - d.sizeMultiplier) * 100)}%)`
                      : d.sizeMultiplier > 1
                        ? ` (buys raised ${Math.round((d.sizeMultiplier - 1) * 100)}%)`
                        : " (no change)"}
                  </span>
                ) : (
                  "no change"
                )}
              </p>
              {d?.reason && <p className="mt-1 text-muted-foreground">{d.reason}</p>}
              {d && d.blockedBuys.length > 0 && (
                <p className="mt-2 text-destructive">
                  Panic level — new buys blocked: {d.blockedBuys.join(", ")}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <p className="text-sm font-medium">Sizing comparison — last run</p>
                {resized.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setOnlyResized((v) => !v)}
                  >
                    {onlyResized ? "Show all" : `Only resized (${resized.length})`}
                  </Button>
                )}
              </div>
              {visibleImpacts.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">Symbol</th>
                        <th className="py-1 px-2 font-medium text-right">Without fear</th>
                        <th className="py-1 px-2 font-medium text-right">Actual</th>
                        <th className="py-1 pl-2 font-medium text-right">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleImpacts.map((i) => {
                        const delta = i.deltaPct;
                        const deltaTone =
                          delta == null || Math.abs(delta) < 0.5
                            ? "text-muted-foreground"
                            : delta < 0
                              ? "text-destructive"
                              : "text-emerald-500";
                        return (
                          <tr key={`${i.side}-${i.symbol}`} className="border-t border-border/60">
                            <td className="py-1.5 pr-2">
                              <span className="flex items-center gap-2 min-w-0">
                                <Badge variant={i.side === "buy" ? "default" : "secondary"}>
                                  {i.side.toUpperCase()}
                                </Badge>
                                <span className="truncate">{i.symbol}</span>
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                              {i.unadjustedValue != null
                                ? formatMoney(i.unadjustedValue, currency, 0)
                                : "—"}
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums">
                              {formatMoney(i.value, currency, 0)}
                            </td>
                            <td className={`py-1.5 pl-2 text-right tabular-nums ${deltaTone}`}>
                              {delta != null
                                ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`
                                : i.note}
                              {i.fearScore != null && (
                                <span className="block text-[11px] text-muted-foreground">
                                  fear {i.fearScore.toFixed(0)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The fear index didn't change sizing on the last run.
                </p>
              )}
              {resized.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {resized.length} order{resized.length === 1 ? "" : "s"} resized by the fear index —
                  net {formatMoney(netDelta, currency, 0)} vs unadjusted sizing.
                </p>
              )}

            </div>

            <div>
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <p className="text-sm font-medium">Fear index over time</p>
                <div className="flex gap-1">
                  {SESSION_OPTIONS.map((n) => (
                    <Button
                      key={n}
                      size="sm"
                      variant={sessions === n ? "secondary" : "ghost"}
                      className="h-7 px-2 text-xs"
                      onClick={() => setSessions(n)}
                    >
                      {n}
                    </Button>
                  ))}
                </div>
              </div>
              {history.length > 1 ? (
                <ChartFrame className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={history}
                      margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="run_date"
                        tick={AXIS_TICK}
                        tickLine={TICK_LINE}
                        axisLine={AXIS_LINE}
                        minTickGap={24}
                        tickFormatter={(v: string) => v.slice(5)}
                      />
                      <YAxis
                        domain={[0, 100]}
                        ticks={[0, 20, 40, 60, 80, 100]}
                        width={36}
                        tick={AXIS_TICK}
                        tickLine={TICK_LINE}
                        axisLine={AXIS_LINE}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        formatter={(v: number) => [v.toFixed(0), "Fear"]}
                      />
                      <ReferenceLine y={60} stroke={CHART_ROLE.warning} strokeDasharray="4 4" />
                      <ReferenceLine y={80} stroke={CHART_ROLE.negative} strokeDasharray="4 4" />
                      <Line
                        type="monotone"
                        dataKey="score"
                        stroke={CHART_ROLE.highlight}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        name="Fear"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartFrame>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not enough runs yet to chart a trend.
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                Above 60 = fear (buys shrink); above 80 = panic (buys can be blocked).
              </p>
            </div>

          </>
        )}
      </CardContent>
    </Card>
  );
}
