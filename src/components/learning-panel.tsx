import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getPortfolioLearning,
  setLessonOverride,
  clearLessonOverride,
  rateLessonFeedback,
} from "@/lib/trading.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Sparkles,
  Pencil,
  Ban,
  RotateCcw,
  Check,
  X,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";

type OverrideAction = "disabled" | "edited";

type OverrideView = {
  original_text: string;
  action: OverrideAction | "neutral";
  replacement_text: string | null;
  helpful_count: number;
  unhelpful_count: number;
  feedback_score: number;
} | undefined;


export function LearningPanel({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const fn = useServerFn(getPortfolioLearning);
  const setOverride = useServerFn(setLessonOverride);
  const clearOverride = useServerFn(clearLessonOverride);
  const rateFeedback = useServerFn(rateLessonFeedback);


  const q = useQuery({
    queryKey: ["learning", portfolioId],
    queryFn: () => fn({ data: { portfolio_id: portfolioId } }),
  });

  const [editing, setEditing] = useState<{ text: string; draft: string; reason: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["learning", portfolioId] });

  const disableMut = useMutation({
    mutationFn: (original_text: string) =>
      setOverride({ data: { original_text, action: "disabled" } }),
    onSuccess: () => {
      toast.success("Lesson marked as unhelpful — the AI will stop applying it.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to disable lesson"),
  });

  const editMut = useMutation({
    mutationFn: (input: { original_text: string; replacement_text: string; reason: string }) =>
      setOverride({
        data: {
          original_text: input.original_text,
          action: "edited",
          replacement_text: input.replacement_text,
          reason: input.reason || null,
        },
      }),
    onSuccess: () => {
      toast.success("Lesson updated — the AI will use your revised wording.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to edit lesson"),
  });

  const restoreMut = useMutation({
    mutationFn: (original_text: string) => clearOverride({ data: { original_text } }),
    onSuccess: () => {
      toast.success("Restored — the AI will use the original lesson again.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to restore lesson"),
  });

  const rateMut = useMutation({
    mutationFn: (input: { original_text: string; vote: "helpful" | "unhelpful" | "clear" }) =>
      rateFeedback({ data: input }),
    onSuccess: (_data, vars) => {
      if (vars.vote === "helpful") toast.success("Marked helpful — the AI will weight this lesson more strongly.");
      else if (vars.vote === "unhelpful") toast.success("Marked unhelpful — the AI will require stronger evidence before acting on it.");
      else toast.success("Feedback cleared.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to record feedback"),
  });


  if (q.isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-primary" /> Learning memory
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) return null;

  const { stats, lessons_raw, lessons_overrides, lessons_as_of, as_of } = q.data;
  const wr = stats.win_rate != null ? `${(stats.win_rate * 100).toFixed(0)}%` : "—";
  const ar = stats.avg_return_pct != null ? `${stats.avg_return_pct.toFixed(2)}%` : "—";

  const overrideFor = (text: string): OverrideView =>
    lessons_overrides.find((o) => o.original_text === text) as OverrideView;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" /> Learning memory
          </span>
          <span className="text-xs font-normal text-muted-foreground">as of {as_of}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Trades reviewed" value={String(stats.evaluable)} />
          <Stat label={`Win rate (${stats.horizon_days}d fwd)`} value={wr} />
          <Stat label="Avg return" value={ar} />
          <Stat label="Window" value={`${stats.window_days}d`} />
        </div>

        {(stats.best || stats.worst) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {stats.best && (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Best call:</span>
                <span className="font-medium">{stats.best.symbol}</span>
                <span className="ml-auto text-primary">+{stats.best.return_pct.toFixed(2)}%</span>
              </div>
            )}
            {stats.worst && (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <TrendingDown className="h-4 w-4 text-destructive" />
                <span className="text-muted-foreground">Worst call:</span>
                <span className="font-medium">{stats.worst.symbol}</span>
                <span className="ml-auto text-destructive">{stats.worst.return_pct.toFixed(2)}%</span>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            Lessons the AI is applying
            {lessons_as_of && (
              <span className="text-xs font-normal text-muted-foreground">
                (updated {lessons_as_of})
              </span>
            )}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Edit a lesson to reword it, or mark it as unhelpful to stop the AI applying it. Changes take effect on the next run.
          </p>
          {lessons_raw.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough trade outcomes yet — the AI needs at least 5 evaluable trades before it writes lessons.
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {lessons_raw.map((l, i) => {
                const ov = overrideFor(l);
                const isEditing = editing?.text === l;
                const busy =
                  (disableMut.isPending && disableMut.variables === l) ||
                  (restoreMut.isPending && restoreMut.variables === l) ||
                  (editMut.isPending && editMut.variables?.original_text === l);

                return (
                  <li key={i} className="rounded-md border bg-muted/40 p-2">
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <div className="flex-1 space-y-1">
                        {ov?.action === "disabled" && (
                          <div className="flex items-center gap-2">
                            <Badge variant="destructive" className="text-[10px]">Disabled</Badge>
                            <span className="text-xs text-muted-foreground">Not applied by the AI.</span>
                          </div>
                        )}
                        {ov?.action === "edited" && (
                          <div className="flex items-center gap-2">
                            <Badge className="text-[10px]">Edited</Badge>
                            <span className="text-xs text-muted-foreground">AI uses your revised wording.</span>
                          </div>
                        )}
                        <div className={ov?.action === "disabled" ? "line-through text-muted-foreground" : ""}>
                          {l}
                        </div>
                        {ov?.action === "edited" && ov.replacement_text && (
                          <div className="rounded border border-primary/30 bg-primary/5 p-1.5 text-xs">
                            <span className="font-medium text-primary">Your version: </span>
                            {ov.replacement_text}
                          </div>
                        )}

                        {isEditing ? (
                          <div className="space-y-2 pt-1">
                            <Textarea
                              value={editing!.draft}
                              onChange={(e) => setEditing({ ...editing!, draft: e.target.value })}
                              rows={3}
                              className="text-sm"
                              placeholder="Reword this lesson so the AI applies your improved version."
                            />
                            <Input
                              value={editing!.reason}
                              onChange={(e) => setEditing({ ...editing!, reason: e.target.value })}
                              placeholder="Why is the original wrong? (optional)"
                              className="text-xs"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() =>
                                  editMut.mutate({
                                    original_text: l,
                                    replacement_text: editing!.draft,
                                    reason: editing!.reason,
                                  })
                                }
                                disabled={!editing!.draft.trim() || editMut.isPending}
                              >
                                <Check className="mr-1 h-3 w-3" /> Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditing(null)}
                                disabled={editMut.isPending}
                              >
                                <X className="mr-1 h-3 w-3" /> Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1 pt-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() =>
                                setEditing({
                                  text: l,
                                  draft: ov?.replacement_text ?? l,
                                  reason: "",
                                })
                              }
                            >
                              <Pencil className="mr-1 h-3 w-3" /> Edit
                            </Button>
                            {ov?.action !== "disabled" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                disabled={busy}
                                onClick={() => disableMut.mutate(l)}
                              >
                                <Ban className="mr-1 h-3 w-3" /> Mark unhelpful
                              </Button>
                            )}
                            {ov && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                disabled={busy}
                                onClick={() => restoreMut.mutate(l)}
                              >
                                <RotateCcw className="mr-1 h-3 w-3" /> Restore original
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {stats.per_symbol.length > 0 && (
          <div>
            <div className="mb-2 text-sm font-medium">Per-symbol track record</div>
            <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {stats.per_symbol.map((p) => (
                <div key={p.symbol} className="flex items-center justify-between rounded border px-2 py-1">
                  <span className="font-medium">{p.symbol}</span>
                  <span className="text-muted-foreground">
                    {p.n} · {(p.win_rate * 100).toFixed(0)}% win ·{" "}
                    <span className={p.avg_return_pct >= 0 ? "text-primary" : "text-destructive"}>
                      {p.avg_return_pct >= 0 ? "+" : ""}
                      {p.avg_return_pct.toFixed(2)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}
