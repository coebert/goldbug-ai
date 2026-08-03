import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getTodaysDecisionSummary,
  type DecisionSummary,
  type DecisionSummaryEntry,
} from "@/lib/decision-summary.functions";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Ban,
  Clock,
  Filter,
} from "lucide-react";
import { formatUkDate, formatUkTime } from "@/lib/uk-time";
import { cn } from "@/lib/utils";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  currency: string;
}

const BLOCK_LABEL: Record<string, string> = {
  cooldown: "Post-loss cooldown",
  gap_guard: "Overnight-gap guard",
  gross_exposure: "Gross-exposure cap",
  asset_class_cap: "Asset-class cap",
  correlation_cluster: "Correlation-cluster cap",
  per_symbol_cap: "Per-symbol cap",
  min_trade_size: "Below minimum trade size",
  circuit_breaker: "Circuit breaker",
  retail_mania: "Retail-mania guardrail",
  other: "Other guardrail",
};

/**
 * Parse the compact `formatManiaExplanation()` string emitted by
 * `src/lib/microstructure/retail-mania.ts` back into displayable rows.
 * Format: "retail-mania guardrail (tier, score N.N): verb — Label detail (+w); ..."
 */
type ManiaBreakdown = {
  tier: string;
  score: string;
  verb: string;
  components: Array<{ label: string; detail: string; weight: string }>;
};

function parseManiaReason(reason: string): ManiaBreakdown | null {
  const head = reason.match(/^retail-mania guardrail \(([^,]+), score ([\d.]+)\):\s*([^—]+?)\s*—\s*(.+)$/i);
  if (!head) return null;
  const [, tier, score, verb, tail] = head;
  const components = tail
    .split(";")
    .map((s) => s.trim())
    .map((seg) => {
      const m = seg.match(/^(.*?)\s+(.+?)\s*\(\+([\d.]+)\)\s*$/);
      if (!m) return null;
      return { label: m[1].trim(), detail: m[2].trim(), weight: m[3] };
    })
    .filter((x): x is { label: string; detail: string; weight: string } => x !== null);
  if (components.length === 0) return null;
  return { tier: tier.trim(), score, verb: verb.trim(), components };
}

function outcomeBadge(outcome: string | null) {
  const map: Record<string, { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }> = {
    filled: { label: "Filled", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30", Icon: CheckCircle2 },
    placed: { label: "Placed", className: "bg-sky-500/15 text-sky-500 border-sky-500/30", Icon: CheckCircle2 },
    partial: { label: "Partial", className: "bg-sky-500/15 text-sky-500 border-sky-500/30", Icon: CheckCircle2 },
    pending: { label: "Pending", className: "bg-amber-500/15 text-amber-500 border-amber-500/30", Icon: Clock },
    hold: { label: "Hold", className: "bg-muted text-muted-foreground border-border", Icon: MinusCircle },
    skipped: { label: "Skipped", className: "bg-muted text-muted-foreground border-border", Icon: MinusCircle },
    blocked: { label: "Blocked", className: "bg-orange-500/15 text-orange-500 border-orange-500/30", Icon: Ban },
    rejected: { label: "Rejected", className: "bg-destructive/15 text-destructive border-destructive/30", Icon: XCircle },
    error: { label: "Error", className: "bg-destructive/15 text-destructive border-destructive/30", Icon: XCircle },
    cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground border-border", Icon: MinusCircle },
  };
  const entry = outcome ? map[outcome] : undefined;
  if (!entry) return null;
  const { label, className, Icon } = entry;
  return (
    <Badge variant="outline" className={cn("gap-1 whitespace-nowrap", className)}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function actionBadge(action: string | null) {
  if (!action) return null;
  const style =
    action === "buy"
      ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
      : action === "sell"
        ? "bg-destructive/15 text-destructive border-destructive/30"
        : "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cn("uppercase tracking-wide", style)}>
      {action}
    </Badge>
  );
}

type Filter = "all" | "traded" | "blocked" | "hold";

function filterEntries(entries: DecisionSummaryEntry[], f: Filter): DecisionSummaryEntry[] {
  if (f === "all") return entries;
  if (f === "traded") {
    return entries.filter((e) =>
      e.outcome === "filled" || e.outcome === "placed" || e.outcome === "partial" || e.outcome === "pending",
    );
  }
  if (f === "blocked") {
    return entries.filter((e) => e.outcome === "blocked" || e.outcome === "rejected" || e.outcome === "skipped");
  }
  return entries.filter((e) => e.action === "hold" || e.outcome === "hold");
}

export function TodaysDecisionSummaryCard({ portfolioId, currency }: Props) {
  const fetchSummary = useServerFn(getTodaysDecisionSummary);
  const [filter, setFilter] = useState<Filter>("all");

  const query = useQuery({
    queryKey: ["todays-decision-summary", portfolioId],
    queryFn: () => fetchSummary({ data: { portfolioId } }),
    staleTime: 30_000,
    refetchInterval: POLL.SEMI_LIVE,
  });

  const summary: DecisionSummary | undefined = query.data;
  const filtered = useMemo(
    () => (summary ? filterEntries(summary.entries, filter) : []),
    [summary, filter],
  );

  const blockCategoryChips = summary
    ? Object.entries(summary.byBlockCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
    : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Today's decision summary
          </CardTitle>
          {summary && (
            <p className="mt-1 text-xs text-muted-foreground">
              Run date {formatUkDate(summary.runDate)} · {summary.totalConsidered} asset
              {summary.totalConsidered === 1 ? "" : "s"} considered
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          aria-label="Refresh today's decision summary"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && (
          <div className="h-20 animate-pulse rounded-md bg-muted" aria-hidden />
        )}
        {query.error && (
          <p className="text-sm text-destructive">
            Couldn't load summary: {(query.error as Error).message}
          </p>
        )}

        {summary && (
          <>
            <p className="text-sm leading-relaxed">{summary.headline}</p>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border bg-muted/30 p-2">
                <div className="text-lg font-semibold text-emerald-500">{summary.tradedCount}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Traded</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2">
                <div className="text-lg font-semibold text-orange-500">{summary.blockedCount}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Blocked</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2">
                <div className="text-lg font-semibold">{summary.holdCount}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Held</div>
              </div>
            </div>

            {blockCategoryChips.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Why the AI didn't trade more</p>
                <div className="flex flex-wrap gap-1.5">
                  {blockCategoryChips.map(([cat, n]) => (
                    <Badge key={cat} variant="outline" className="gap-1 border-orange-500/30 bg-orange-500/10 text-orange-500">
                      <Ban className="h-3 w-3" />
                      {BLOCK_LABEL[cat] ?? cat}
                      <span className="ml-0.5 rounded bg-orange-500/20 px-1 text-[10px]">{n}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {summary.entries.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {(
                    [
                      ["all", `All (${summary.totalConsidered})`],
                      ["traded", `Traded (${summary.tradedCount})`],
                      ["blocked", `Blocked (${summary.blockedCount})`],
                      ["hold", `Held (${summary.holdCount})`],
                    ] as [Filter, string][]
                  ).map(([f, label]) => (
                    <Button
                      key={f}
                      size="sm"
                      variant={filter === f ? "default" : "outline"}
                      className="h-7 shrink-0 px-2.5 text-xs"
                      onClick={() => setFilter(f)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <div className="divide-y rounded-md border">
                  {filtered.length === 0 && (
                    <p className="p-3 text-xs text-muted-foreground">
                      No assets match this filter.
                    </p>
                  )}
                  {filtered.map((e) => {
                    const reason =
                      e.blockReason ||
                      e.outcomeDetail ||
                      (e.rationale ? e.rationale.split(/\n|\. /)[0] : null) ||
                      (e.action === "hold" ? "No signal strong enough to act." : "—");
                    const mania =
                      e.blockCategory === "retail_mania" && e.blockReason
                        ? parseManiaReason(e.blockReason)
                        : null;
                    return (
                      <div key={e.symbol} className="flex flex-col gap-1.5 p-2.5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-sm font-semibold">{e.symbol}</span>
                            {actionBadge(e.action)}
                            {outcomeBadge(e.outcome)}
                            {e.blockCategory && (
                              <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-orange-500">
                                {BLOCK_LABEL[e.blockCategory] ?? e.blockCategory}
                              </Badge>
                            )}
                            {mania && (
                              <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-500">
                                {mania.tier} · score {mania.score}
                              </Badge>
                            )}
                          </div>
                          {mania ? (
                            <div className="space-y-1">
                              <p className="text-xs text-muted-foreground">
                                Retail-mania detector recommends{" "}
                                <span className="font-medium text-foreground">{mania.verb}</span>. Score components:
                              </p>
                              <ul className="ml-3 space-y-0.5 text-[11px] text-muted-foreground">
                                {mania.components.map((c, i) => (
                                  <li key={i} className="flex flex-wrap items-baseline gap-1.5">
                                    <span className="font-medium text-foreground">{c.label}</span>
                                    <span>{c.detail}</span>
                                    <span className="font-mono text-red-500">+{c.weight}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {reason}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                          {e.notional != null && (
                            <div>
                              {e.notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                              {e.instrumentCcy ?? currency}
                            </div>
                          )}
                          {e.decidedAt && <div>{formatUkTime(e.decidedAt)}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {summary.entries.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No assets were evaluated on {formatUkDate(summary.runDate)} yet. The next scheduled tick
                will populate this summary.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
