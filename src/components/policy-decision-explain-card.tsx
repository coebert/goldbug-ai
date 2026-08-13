// "Why did policy push this trade?" — per-order breakdown of the
// policy-maker nudge for the latest decision run.
//
// Each order expands into the individual remarks that fed its score, showing
// tone, the maker's weight, how old the remark is, the 48h-half-life decay
// applied to it, and the signed share of the final score it accounts for.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gavel, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getPolicyDecisionExplain,
  type PolicyDecisionExplain,
  type PolicyOrderExplain,
} from "@/lib/policy-explain.functions";

function toneClass(v: number): string {
  if (v > 0.02) return "text-emerald-500";
  if (v < -0.02) return "text-destructive";
  return "text-muted-foreground";
}

function pts(v: number): string {
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}pts`;
}

function NudgeBar({ nudge, max }: { nudge: number; max: number }) {
  const frac = Math.max(-1, Math.min(1, max > 0 ? nudge / max : 0));
  const width = `${Math.abs(frac) * 50}%`;
  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`Policy nudge ${pts(nudge)} of a maximum ${pts(max)}`}
    >
      <span className="absolute left-1/2 top-0 h-full w-px bg-border" />
      <span
        className={`absolute top-0 h-full rounded-full ${nudge >= 0 ? "bg-emerald-500" : "bg-destructive"}`}
        style={frac >= 0 ? { left: "50%", width } : { right: "50%", width }}
      />
    </div>
  );
}

function OrderRow({ order, max }: { order: PolicyOrderExplain; max: number }) {
  const { explain } = order;
  const Icon = explain.nudge > 0 ? TrendingUp : explain.nudge < 0 ? TrendingDown : Minus;
  return (
    <AccordionItem value={`${order.symbol}-${order.side}`} className="border-border/60">
      <AccordionTrigger className="gap-2 py-3 hover:no-underline">
        <div className="grid min-w-0 flex-1 gap-1 text-left">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={order.side === "sell" ? "outline" : "secondary"} className="shrink-0 uppercase">
              {order.side}
            </Badge>
            <span className="min-w-0 break-words font-semibold">{order.symbol}</span>
            {order.rejected ? (
              <Badge variant="outline" className="shrink-0 border-amber-500/50 text-amber-500">
                blocked
              </Badge>
            ) : null}
            <span className={`ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums ${toneClass(explain.nudge)}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {pts(explain.nudge)}
            </span>
          </div>
          <NudgeBar nudge={explain.nudge} max={max} />
          <p className="text-xs font-normal text-muted-foreground">{order.summary}</p>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 pb-4">
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Policy score</dt>
            <dd className={`tabular-nums ${toneClass(explain.score)}`}>
              {explain.score.toFixed(2)} · {explain.stance}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Confidence</dt>
            <dd className="tabular-nums">
              ×{explain.confidence.toFixed(2)} ({explain.statements} remark
              {explain.statements === 1 ? "" : "s"})
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Applied nudge</dt>
            <dd className={`tabular-nums ${toneClass(explain.nudge)}`}>
              {pts(explain.nudge)} of ±{(explain.max_nudge * 100).toFixed(0)}pts
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Final news score</dt>
            <dd className="tabular-nums">
              {order.news_score == null ? "—" : order.news_score.toFixed(3)}
            </dd>
          </div>
        </dl>

        {explain.contributions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tracked policy maker mentioned this symbol&apos;s market in the last 7 days.
          </p>
        ) : (
          <ul className="space-y-2">
            {explain.contributions.map((c, i) => (
              <li
                key={`${c.maker_id}-${i}`}
                className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-medium">{c.maker_name}</span>
                  <span className="text-muted-foreground">· {c.org}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px] uppercase">
                    {c.stance}
                  </Badge>
                  <span className={`ml-auto tabular-nums ${toneClass(c.share)}`}>
                    share {pts(c.share)}
                  </span>
                </div>
                <p className="mt-1 break-words text-muted-foreground">{c.headline}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
                  <span>tone {c.tone.toFixed(2)}</span>
                  <span>sentiment {c.sentiment == null ? "n/a" : c.sentiment.toFixed(2)}</span>
                  <span>blended {c.value.toFixed(2)}</span>
                  <span>maker weight {c.maker_weight.toFixed(2)}</span>
                  <span>{c.proximity === 1 ? "primary market" : "secondary proxy ×0.5"}</span>
                  <span>
                    age {c.age_hours.toFixed(0)}h → decay ×{c.decay.toFixed(2)}
                  </span>
                  {c.source ? <span className="break-words">{c.source}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {order.reason ? (
          <p className="break-words rounded-md border border-dashed border-border/60 p-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">AI reason: </span>
            {order.reason}
          </p>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

export function PolicyDecisionExplainCard({ portfolioId }: { portfolioId: string }) {
  const fetchExplain = useServerFn(getPolicyDecisionExplain);
  const { data, isLoading, isError } = useQuery<PolicyDecisionExplain>({
    queryKey: ["policy-decision-explain", portfolioId],
    queryFn: () => fetchExplain({ data: { portfolioId } }),
    staleTime: 5 * 60_000,
  });

  return (
    <Card id="policy-explain">
      <CardHeader className="pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <Gavel className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 break-words">How policy makers moved this run</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every remark by a tracked central banker or minister is scored hawkish to dovish, faded with
          a {data?.half_life_hours ?? 48}-hour half-life, and capped at ±
          {((data?.max_nudge ?? 0.1) * 100).toFixed(0)} points of the news score. This is the working
          out behind the latest {data?.run_date ? `run (${data.run_date})` : "run"}.
        </p>
        {data?.regime ? (
          <p className="text-xs text-muted-foreground">
            Market regime on this run:{" "}
            <span className="font-medium text-foreground">
              {data.regime.posture.replace("_", "-")} · {data.regime.vol} volatility
            </span>{" "}
            — policy guidance weighted ×{data.regime.scale.toFixed(2)}.
          </p>
        ) : null}

      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">Could not load the policy breakdown.</p>
        ) : !data || data.orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The latest run proposed no buys or sells, so there is nothing to attribute yet.
          </p>
        ) : (
          <>
            {data.no_policy_input ? (
              <p className="mb-2 text-xs text-muted-foreground">
                No tracked policy remarks touched these symbols — policy contributed nothing to this
                run.
              </p>
            ) : null}
            <Accordion type="single" collapsible className="w-full">
              {data.orders.map((o) => (
                <OrderRow key={`${o.symbol}-${o.side}`} order={o} max={data.max_nudge} />
              ))}
            </Accordion>
          </>
        )}
      </CardContent>
    </Card>
  );
}
