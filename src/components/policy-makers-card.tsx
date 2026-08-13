import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPolicyTracker, type PolicyTracker } from "@/lib/policy-makers.functions";

function tone(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score > 0.15) return "text-emerald-500";
  if (score < -0.15) return "text-destructive";
  return "text-muted-foreground";
}

export function PolicyMakersCard() {
  const fetchTracker = useServerFn(getPolicyTracker);
  const { data, isLoading } = useQuery<PolicyTracker>({
    queryKey: ["policy-maker-tracker"],
    queryFn: () => fetchTracker({ data: { sinceDays: 7 } }),
    staleTime: 5 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4 text-primary" aria-hidden="true" />
          Policy makers the AI is tracking
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Central bankers and finance ministers move whole markets. Their reported remarks are scored
          hawkish (tightening, risk-off) to dovish (easing, risk-on) and nudge the AI&apos;s view of the
          affected assets.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {(data?.tracked ?? []).map((t) => (
            <Badge key={t.name} variant="secondary" className="text-[10px]">
              {t.name} · {t.ccy}
            </Badge>
          ))}
        </div>

        {data && data.currencies.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {data.currencies.map((c) => (
              <div
                key={c.ccy}
                className="rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="font-semibold">{c.ccy}</span>{" "}
                <span className={tone(c.score)}>{c.stance}</span>{" "}
                <span className="text-muted-foreground tabular-nums">({c.score.toFixed(2)})</span>
              </div>
            ))}
          </div>
        ) : null}

        {data && data.signals.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.signals.slice(0, 6).map((s) => (
              <div key={s.symbol} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{s.symbol}</span>
                  <span className={`text-sm font-semibold tabular-nums ${tone(s.score)}`}>
                    {s.score > 0 ? "+" : ""}
                    {s.score.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {s.statements} remark{s.statements === 1 ? "" : "s"} · {s.makers.join(", ")}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-2">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading policy remarks…</p>
          ) : data && data.statements.length > 0 ? (
            data.statements.slice(0, 6).map((s, i) => (
              <a
                key={`${s.headline}-${i}`}
                href={s.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-border/60 px-3 py-2 hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {s.maker_name} · {s.role}
                  </span>
                  <span className={`text-[11px] font-semibold ${tone(s.tone)}`}>{s.stance}</span>
                </div>
                <p className="mt-0.5 text-xs leading-snug">{s.headline}</p>
              </a>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              No tracked policy remarks in the last 7 days.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
