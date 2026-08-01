import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BrainCircuit, Loader2, TrendingDown, TrendingUp, MinusCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getExecPostLessons,
  runExecPostStudy,
  type ExecPostStudyResponse,
} from "@/lib/exec-post-analysis.functions";
import type { ExecPostStance } from "@/lib/exec-post-learning";

function StanceBadge({ stance }: { stance: ExecPostStance }) {
  const map: Record<ExecPostStance, { label: string; className: string; Icon: typeof TrendingUp }> = {
    follow: { label: "Follow", className: "text-emerald-500 border-emerald-500/40", Icon: TrendingUp },
    fade: { label: "Fade", className: "text-amber-500 border-amber-500/40", Icon: TrendingDown },
    ignore: { label: "Ignore", className: "text-muted-foreground border-border", Icon: MinusCircle },
  };
  const { label, className, Icon } = map[stance];
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

export function ExecPostLessonsCard() {
  const queryClient = useQueryClient();
  const fetchLessons = useServerFn(getExecPostLessons);
  const runStudy = useServerFn(runExecPostStudy);

  const { data, isLoading } = useQuery<ExecPostStudyResponse>({
    queryKey: ["exec-post-lessons"],
    queryFn: () => fetchLessons({}),
    staleTime: 10 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: () => runStudy({ data: { windowDays: 90 } }),
    onSuccess: (res) => {
      queryClient.setQueryData(["exec-post-lessons"], res);
      if (res.ai_error) toast.warning(res.ai_error);
      else toast.success(`Analysis complete — ${res.lessons?.lessons.length ?? 0} lessons applied`);
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Could not run the analysis"),
  });

  const lessons = data?.lessons ?? null;
  const active = (lessons?.coefficients ?? []).filter((c) => c.confidence > 0 || c.stance !== "follow");
  const shown = active.length > 0 ? active : (lessons?.coefficients ?? []).slice(0, 6);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BrainCircuit className="h-4 w-4 text-primary" aria-hidden="true" />
              What the AI learned from CEO posts
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Every detected post is matched to the affected symbol&apos;s next 1, 3 and 5 days of
              price action. The AI reads that record and rewrites its own rules for how much a post
              may move a decision.
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
                Analysing…
              </>
            ) : (
              "Run analysis"
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
        ) : !lessons ? (
          <p className="text-sm text-muted-foreground">
            No study on file yet. Run the analysis to have the AI study how tracked posts lined up
            with subsequent price moves and turn that into trading rules.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>
                {lessons.sample_size} event{lessons.sample_size === 1 ? "" : "s"} ·{" "}
                {lessons.window_days}-day window
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

            {shown.length > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Learned settings per person
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {shown.map((c) => (
                    <div
                      key={c.executive_id}
                      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{c.executive_name}</span>
                        <StanceBadge stance={c.stance} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                        <span>weight {c.weight.toFixed(2)}</span>
                        <span>cap ±{c.max_nudge.toFixed(2)}</span>
                        <span>half-life {c.half_life_hours}h</span>
                        <span>conf {Math.round(c.confidence * 100)}%</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.note}</p>
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
