import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getFxLegHistory } from "@/lib/fx-leg-history.functions";
import type { FxLegAction } from "@/lib/fx-leg-playbook";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

const RANGES = [30, 90, 180, 365] as const;

const ACTION_TONE: Record<FxLegAction, string> = {
  keep: "bg-muted text-muted-foreground",
  hold_stale: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unwind_orphan: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  close_loss: "bg-destructive/15 text-destructive",
  close_profit: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

const ACTION_LABEL: Record<FxLegAction, string> = {
  keep: "Keep",
  hold_stale: "Hold (stale)",
  unwind_orphan: "Unwind",
  close_loss: "Close (cut)",
  close_profit: "Close (take)",
};

function money(n: number, ccy: string) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 2,
  }).format(Math.abs(n))}`;
}

/**
 * Rate history for each open FX funding leg plotted against the unrealised
 * P&L path, followed by the decision log: the playbook verdict for the leg
 * and every signal that produced it.
 */
export function FxLegHistoryCard({ portfolioId, active = true }: Props) {
  const [days, setDays] = useState<number>(90);
  const fetchHistory = useServerFn(getFxLegHistory);

  const query = useQuery({
    queryKey: ["fx-leg-history", portfolioId, days],
    queryFn: () => fetchHistory({ data: { portfolioId, days } }),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: POLL.SLOW,
  });

  const legs = useMemo(() => query.data?.legs ?? [], [query.data]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">FX rate history &amp; decision log</CardTitle>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={days === r ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setDays(r)}
              >
                {r}d
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading FX history…</p>
        ) : legs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open FX funding legs. When the engine opens one (e.g. short GBPUSD to fund a
            dollar buy) its rate path, P&amp;L and the reasoning behind keeping or closing it
            appear here.
          </p>
        ) : (
          legs.map((leg) => {
            const pnlTone =
              leg.pnlQuote > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : leg.pnlQuote < 0
                  ? "text-destructive"
                  : "text-muted-foreground";
            return (
              <div key={leg.symbol} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{leg.symbol}</span>
                  <Badge variant="outline" className="text-xs">
                    {leg.quantity < 0 ? "Short" : "Long"} {leg.pairBase}
                  </Badge>
                  <Badge className={`text-xs ${ACTION_TONE[leg.verdict.action]}`}>
                    {ACTION_LABEL[leg.verdict.action]}
                  </Badge>
                  <span className={`ml-auto text-sm font-medium tabular-nums ${pnlTone}`}>
                    {money(leg.pnlQuote, leg.quoteCcy)}{" "}
                    <span className="text-xs">
                      ({(leg.verdict.pnlPct * 100).toFixed(2)}%)
                    </span>
                  </span>
                </div>

                {leg.points.length > 1 ? (
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={leg.points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 10 }}
                          minTickGap={28}
                          tickFormatter={(d: string) => d.slice(5)}
                        />
                        <YAxis
                          yAxisId="rate"
                          domain={["auto", "auto"]}
                          tick={{ fontSize: 10 }}
                          width={54}
                          tickFormatter={(v: number) => v.toFixed(4)}
                        />
                        <YAxis
                          yAxisId="pnl"
                          orientation="right"
                          tick={{ fontSize: 10 }}
                          width={54}
                          tickFormatter={(v: number) => v.toFixed(0)}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--popover))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(value: number, name: string) =>
                            name === "rate"
                              ? [value.toFixed(5), `${leg.pairBase}${leg.quoteCcy}`]
                              : [money(value, leg.quoteCcy), "Unrealised P&L"]
                          }
                        />
                        <ReferenceLine
                          yAxisId="rate"
                          y={leg.avgCost}
                          strokeDasharray="4 4"
                          className="stroke-muted-foreground"
                          label={{ value: "entry", fontSize: 10, position: "insideTopLeft" }}
                        />
                        <ReferenceLine yAxisId="pnl" y={0} className="stroke-border" />
                        <Area
                          yAxisId="pnl"
                          type="monotone"
                          dataKey="pnlQuote"
                          fill="hsl(var(--primary))"
                          stroke="hsl(var(--primary))"
                          fillOpacity={0.15}
                          strokeOpacity={0.5}
                        />
                        <Line
                          yAxisId="rate"
                          type="monotone"
                          dataKey="rate"
                          dot={false}
                          strokeWidth={2}
                          stroke="hsl(var(--chart-1, var(--primary)))"
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {leg.error ?? "Not enough rate history for this pair yet."}
                  </p>
                )}

                <div className="rounded-md border p-3 space-y-2">
                  <p className="text-sm font-medium">{leg.verdict.headline}</p>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {leg.verdict.signals.map((s) => (
                      <li key={s.id} className="flex items-start gap-2 text-xs">
                        <span
                          className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                            s.triggered ? "bg-primary" : "bg-muted-foreground/40"
                          }`}
                        />
                        <span className={s.triggered ? "font-medium" : "text-muted-foreground"}>
                          {s.label}: <span className="tabular-nums">{s.value}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-muted-foreground">
                    Mark source: {leg.source}
                    {leg.observedAt ? ` · observed ${new Date(leg.observedAt).toLocaleTimeString("en-GB")}` : ""}
                  </p>
                  {leg.aiNotes.length > 0 && (
                    <div className="pt-1 space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        Recent AI notes on this currency
                      </p>
                      {leg.aiNotes.map((n, i) => (
                        <p key={`${n.at}-${i}`} className="text-[11px] text-muted-foreground">
                          <span className="font-medium">{n.kind}</span> ·{" "}
                          {new Date(n.at).toLocaleString("en-GB")} — {n.reason}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
