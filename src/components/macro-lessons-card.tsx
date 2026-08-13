import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  History,
  Loader2,
  MinusCircle,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getMacroLessons,
  runMacroStudy,
  type MacroStudyResponse,
} from "@/lib/macro-history-analysis.functions";
import type { MacroResponse } from "@/lib/macro-playbook";

const RESPONSE_META: Record<
  MacroResponse,
  { label: string; className: string; Icon: typeof TrendingUp }
> = {
  follow: { label: "Follow", className: "text-emerald-500 border-emerald-500/40", Icon: TrendingUp },
  fade: { label: "Fade", className: "text-amber-500 border-amber-500/40", Icon: TrendingDown },
  wait: { label: "Wait", className: "text-muted-foreground border-border", Icon: MinusCircle },
  de_risk: { label: "De-risk", className: "text-red-500 border-red-500/40", Icon: ShieldAlert },
};

function ResponseBadge({ response }: { response: MacroResponse }) {
  const meta = RESPONSE_META[response] ?? RESPONSE_META.wait;
  const { label, className, Icon } = meta;
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

export function MacroLessonsCard() {
  const queryClient = useQueryClient();
  const fetchLessons = useServerFn(getMacroLessons);
  const runStudy = useServerFn(runMacroStudy);

  const { data, isLoading } = useQuery<MacroStudyResponse>({
    queryKey: ["macro-lessons"],
    queryFn: () => fetchLessons({}),
    staleTime: 30 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: () => runStudy({ data: { newsWindowDays: 365 } }),
    onSuccess: (res) => {
      queryClient.setQueryData(["macro-lessons"], res);
      if (res.ai_error) toast.warning(res.ai_error);
      else toast.success(`Study complete — ${res.lessons?.lessons.length ?? 0} rules now applied`);
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Could not run the study"),
  });

  const lessons = data?.lessons ?? null;
  const notable = (lessons?.playbook ?? [])
    .filter((e) => e.response !== "wait" || e.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4 text-primary" aria-hidden="true" />
              What the AI learned from 20 years of news
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Every major drawdown since 2005 is measured against the index — how deep, how long to
              recover, and what kind of news started it. The AI turns that record into rules for how
              it reacts to today&apos;s headlines.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Studying…
              </>
            ) : (
              "Run study"
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
        ) : !lessons ? (
          <p className="text-sm text-muted-foreground">
            No study on file yet. Run it to have the AI analyse two decades of market history
            alongside the news that drove it, and convert that into the rules it applies before every
            trade.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>
                {lessons.years_covered} years · {lessons.episodes} drawdown episodes
              </span>
              <span>·</span>
              <span>{new Date(lessons.generated_at).toLocaleString("en-GB")}</span>
              {lessons.model ? (
                <>
                  <span>·</span>
                  <span>{lessons.model}</span>
                </>
              ) : null}
            </div>

            {lessons.narrative ? (
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                {lessons.narrative}
              </p>
            ) : null}

            {lessons.lessons.length > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Rules now applied to every run
                </h4>
                <ul className="space-y-1.5">
                  {lessons.lessons.map((l) => (
                    <li key={l} className="flex gap-2 text-sm">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                      <span>{l}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {(lessons.event_lessons?.length ?? 0) > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Learned from the global events reel
                  {lessons.event_reel ? (
                    <span className="ml-1 font-normal normal-case tracking-normal">
                      ({lessons.event_reel.events_measured}/{lessons.event_reel.events_total} events
                      measured)
                    </span>
                  ) : null}
                </h4>
                <ul className="space-y-1.5">
                  {lessons.event_lessons!.map((l) => (
                    <li key={l} className="flex gap-2 text-sm">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                      <span>{l}</span>
                    </li>
                  ))}
                </ul>
                {(lessons.event_reel?.categories.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {lessons.event_reel!.categories.map((c) => (
                      <Badge key={c.category} variant="outline" className="text-[10px] capitalize">
                        {c.category}: {c.stance.replace(/_/g, " ")}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}


            {notable.length > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How it now reacts to each kind of news
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {notable.map((e) => (
                    <div
                      key={String(e.kind)}
                      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold capitalize">{kindLabel(String(e.kind))}</span>
                        <ResponseBadge response={e.response} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                        <span>tilt ×{e.tilt_multiplier.toFixed(2)}</span>
                        <span>decay {e.half_life_hours}h</span>
                        {e.confirm_sessions > 0 ? <span>confirm {e.confirm_sessions}d</span> : null}
                        <span>conf {Math.round(e.confidence * 100)}%</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{e.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {lessons.drawdown_rules.length > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How much it buys at each depth below the high
                </h4>
                <div className="space-y-1.5">
                  {lessons.drawdown_rules.map((r) => (
                    <div
                      key={r.from_pct}
                      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {r.from_pct}%+ below the high
                        </span>
                        <span className="tabular-nums">
                          size ×{r.size_scale.toFixed(2)}
                          {r.require_trend ? " · trend required" : ""}
                        </span>
                      </div>
                      <p className="mt-0.5 leading-snug">{r.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
