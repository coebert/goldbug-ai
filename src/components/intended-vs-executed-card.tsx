import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getIntendedVsExecutedMetrics } from "@/lib/intended-vs-executed.functions";
import { POLL } from "@/lib/query-keys";

const WINDOWS = [
  { label: "24h", value: 24 },
  { label: "72h", value: 72 },
  { label: "7d", value: 24 * 7 },
  { label: "30d", value: 24 * 30 },
];

interface Props { portfolioId: string }

function pct(x: number): string {
  return `${Math.round((Number.isFinite(x) ? x : 0) * 100)}%`;
}

function rateTone(rate: number, intended: number): "ok" | "warn" | "bad" | "muted" {
  if (intended === 0) return "muted";
  if (rate >= 0.8) return "ok";
  if (rate >= 0.4) return "warn";
  return "bad";
}

const TONE_CLASS: Record<string, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};

export function IntendedVsExecutedCard({ portfolioId }: Props) {
  const [windowHours, setWindowHours] = useState(72);
  const fetchFn = useServerFn(getIntendedVsExecutedMetrics);
  const q = useQuery({
    queryKey: ["intended-vs-executed", portfolioId, windowHours],
    queryFn: () => fetchFn({ data: { portfolioId, windowHours } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const data = q.data;
  const overallTone = data ? rateTone(data.executed_rate, data.intended) : "muted";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-base">Intended vs executed trades</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Rate at which AI trade intents reach the broker and fill. A drop
            here is the earliest signal of the executor stalling.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={windowHours === w.value ? "default" : "outline"}
              onClick={() => setWindowHours(w.value)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile label="Intended orders" value={String(data.intended)} />
              <Tile
                label="Executed rate"
                value={pct(data.executed_rate)}
                sub={`${data.executed} of ${data.intended}`}
                tone={overallTone}
              />
              <Tile
                label="Fill rate"
                value={pct(data.fill_rate)}
                sub={`${data.filled} filled`}
                tone={rateTone(data.fill_rate, data.intended)}
              />
              <Tile
                label="Missed"
                value={String(data.missed)}
                sub="rejected · skipped · error"
                tone={data.missed > 0 ? "warn" : "muted"}
              />
            </div>

            {data.intended === 0 ? (
              <p className="text-sm text-muted-foreground">
                No trade intents in the last {data.windowHours}h — the AI held.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Per-symbol fill quality
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Sorted lowest executed-rate first
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b">
                        <th className="py-1.5 pr-3">Symbol</th>
                        <th className="py-1.5 pr-3 text-right">Intended</th>
                        <th className="py-1.5 pr-3 text-right">Executed</th>
                        <th className="py-1.5 pr-3 text-right">Filled</th>
                        <th className="py-1.5 pr-3 text-right">Exec %</th>
                        <th className="py-1.5">Top miss reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.symbols.slice(0, 25).map((s) => {
                        const tone = rateTone(s.executed_rate, s.intended);
                        const chronic =
                          s.intended >= 5 && s.executed_rate <= 0.2;
                        return (
                          <tr key={s.symbol} className="border-b last:border-0">
                            <td className="py-1.5 pr-3 font-mono">
                              <span className="mr-1.5">{s.symbol}</span>
                              {chronic && (
                                <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                                  chronic miss
                                </Badge>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{s.intended}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{s.executed}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{s.filled}</td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${TONE_CLASS[tone]}`}>
                              {pct(s.executed_rate)}
                            </td>
                            <td className="py-1.5 text-muted-foreground truncate max-w-[16rem]">
                              {s.top_miss_reason ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.symbols.length > 25 && (
                  <p className="text-[11px] text-muted-foreground">
                    Showing 25 of {data.symbols.length} symbols.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "muted",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "bad" | "muted";
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${TONE_CLASS[tone]}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
