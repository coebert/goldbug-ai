import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFearIndexSnapshot } from "@/lib/fear-index.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";

interface Props {
  portfolioId: string;
  active?: boolean;
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
export function FearIndexCard({ portfolioId, active = true }: Props) {
  const fetchSnapshot = useServerFn(getFearIndexSnapshot);
  const query = useQuery({
    queryKey: ["fear-index", portfolioId],
    queryFn: () => fetchSnapshot({ data: { portfolio_id: portfolioId } }),
    enabled: active,
    staleTime: 60_000,
  });

  const d = query.data;
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
              <p className="text-sm font-medium mb-2">Last run's sizing decisions</p>
              {d && d.impacts.length > 0 ? (
                <ul className="space-y-1.5">
                  {d.impacts.map((i) => (
                    <li
                      key={`${i.side}-${i.symbol}`}
                      className="flex items-center justify-between gap-2 text-sm flex-wrap"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Badge variant={i.side === "buy" ? "default" : "secondary"}>
                          {i.side.toUpperCase()}
                        </Badge>
                        <span className="truncate">{i.symbol}</span>
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {i.multiplier != null ? `sized ×${i.multiplier.toFixed(2)}` : i.note}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The fear index didn't change sizing on the last run.
                </p>
              )}
            </div>

            {d && d.history.length > 1 && (
              <div>
                <p className="text-sm font-medium mb-2">Recent readings</p>
                <div className="flex items-end gap-1 h-12">
                  {d.history.map((h) => (
                    <div
                      key={h.run_date}
                      title={`${h.run_date}: ${h.score.toFixed(0)}`}
                      className={`flex-1 rounded-sm ${toneFor(h.score).bar}`}
                      style={{ height: `${Math.max(6, Math.min(100, h.score))}%` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
