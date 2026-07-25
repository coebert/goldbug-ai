import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileJson, Loader2, Search } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildAuditEntries,
  downloadBlob,
  entriesToCsv,
  RULE_TAG_LABELS,
  type AuditEntry,
  type AuditRuleTag,
} from "@/lib/audit-log";
import { listAuditDecisions, type AuditDecisionPage } from "@/lib/audit.functions";

type StatusFilter = "all" | "executed" | "rejected";

const PAGE_SIZE = 50;

export function TradeAuditLogCard({
  portfolioId,
  portfolioName,
  active = true,
}: {
  portfolioId: string;
  portfolioName: string;
  /** Only fetch when the Audit tab is actually visible. */
  active?: boolean;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [symbol, setSymbol] = useState("");
  const [rule, setRule] = useState<AuditRuleTag | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const listFn = useServerFn(listAuditDecisions);

  const query = useInfiniteQuery({
    queryKey: ["audit-decisions", portfolioId, PAGE_SIZE],
    enabled: active && !!portfolioId,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      listFn({ data: { portfolioId, page: pageParam as number, pageSize: PAGE_SIZE } }) as Promise<AuditDecisionPage>,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 30_000,
  });

  const decisions = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.rows),
    [query.data],
  );
  const totalDecisions = query.data?.pages?.[0]?.total ?? 0;

  const entries = useMemo(() => buildAuditEntries(decisions), [decisions]);

  const filtered = useMemo(() => {
    const s = symbol.trim().toUpperCase();
    return entries.filter((e) => {
      if (status !== "all" && e.status !== status) return false;
      if (s && !e.symbol.includes(s)) return false;
      if (rule !== "all" && !e.ruleTags.includes(rule)) return false;
      return true;
    });
  }, [entries, status, symbol, rule]);

  const summary = useMemo(() => {
    const executed = entries.filter((e) => e.status === "executed").length;
    const rejected = entries.length - executed;
    return { loaded: entries.length, executed, rejected };
  }, [entries]);

  // IntersectionObserver-driven lazy fetch for the next page.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    const io = new IntersectionObserver(
      (entries2) => {
        for (const en of entries2) {
          if (en.isIntersecting) {
            query.fetchNextPage();
            break;
          }
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, query]);

  const exportCsv = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = portfolioName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "portfolio";
    downloadBlob(entriesToCsv(filtered), `audit-${slug}-${stamp}.csv`, "text/csv");
  };

  const exportJson = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = portfolioName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "portfolio";
    downloadBlob(JSON.stringify(filtered, null, 2), `audit-${slug}-${stamp}.json`, "application/json");
  };

  const initialLoading = query.isLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Trade audit log</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalDecisions > 0 ? (
                <>
                  {summary.loaded} loaded of ~{totalDecisions} decisions · {summary.executed} executed ·{" "}
                  {summary.rejected} blocked
                </>
              ) : initialLoading ? (
                <>Loading audit history…</>
              ) : (
                <>No decisions yet.</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={exportJson} disabled={!filtered.length}>
              <FileJson className="h-3.5 w-3.5 mr-1.5" /> JSON
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter symbol…"
              className="pl-7 h-9"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="executed">Executed only</SelectItem>
              <SelectItem value="rejected">Rejected only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={rule} onValueChange={(v) => setRule(v as AuditRuleTag | "all")}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rules</SelectItem>
              {(Object.keys(RULE_TAG_LABELS) as AuditRuleTag[]).map((t) => (
                <SelectItem key={t} value={t}>{RULE_TAG_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {initialLoading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="py-6 text-center text-sm text-destructive">
            Failed to load audit history.{" "}
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {entries.length === 0
              ? "No audit entries recorded yet."
              : "No loaded entries match these filters. Load more below to keep searching."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2 text-right">Conv.</th>
                  <th className="px-3 py-2 text-left">Rules & news factors</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const key = `${e.decisionId}:${e.orderIndex}`;
                  const isOpen = expanded === key;
                  return (
                    <AuditRow
                      key={key}
                      entry={e}
                      isOpen={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : key)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Lazy-load sentinel + explicit fallback */}
        {!initialLoading && query.hasNextPage && (
          <div ref={sentinelRef} className="flex justify-center py-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Loading…
                </>
              ) : (
                <>Load more ({totalDecisions - summary.loaded} remaining)</>
              )}
            </Button>
          </div>
        )}
        {!initialLoading && !query.hasNextPage && summary.loaded > 0 && (
          <p className="text-center text-xs text-muted-foreground py-2">
            End of audit history.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({
  entry,
  isOpen,
  onToggle,
}: {
  entry: AuditEntry;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const aligned = entry.newsFactors.filter((n) => n.alignment === "aligned").length;
  const opposing = entry.newsFactors.filter((n) => n.alignment === "opposing").length;
  return (
    <>
      <tr
        className="border-t border-border cursor-pointer hover:bg-muted/40"
        onClick={onToggle}
      >
        <td className="px-3 py-2 tabular-nums whitespace-nowrap">{entry.runDate}</td>
        <td className="px-3 py-2 font-medium">{entry.symbol}</td>
        <td className={`px-3 py-2 ${entry.side === "buy" ? "text-primary" : "text-accent"}`}>
          {entry.side.toUpperCase()}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{entry.quantity.toFixed(4)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{entry.value.toFixed(2)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
          {entry.conviction != null ? entry.conviction.toFixed(2) : "—"}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {entry.ruleTags.map((t) => (
              <Badge
                key={t}
                variant={t === "executed" ? "secondary" : "destructive"}
                className="text-[10px]"
              >
                {RULE_TAG_LABELS[t]}
              </Badge>
            ))}
            {aligned > 0 && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400">
                {aligned} news aligned
              </Badge>
            )}
            {opposing > 0 && (
              <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-400">
                {opposing} news opposing
              </Badge>
            )}
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-border bg-muted/30">
          <td colSpan={7} className="px-3 py-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Reason recorded</div>
                <p className="text-sm break-words">{entry.reason || "—"}</p>
                {entry.rejectedReason && (
                  <p className="text-sm text-destructive mt-1 break-words">
                    Blocked: {entry.rejectedReason}
                  </p>
                )}
                {entry.signalWeights && (
                  <>
                    <div className="text-xs uppercase text-muted-foreground mt-3 mb-1">
                      Signal weights
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(entry.signalWeights).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="text-[10px]">
                          {k}: {v.toFixed(2)}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">
                  News factors applied ({entry.newsFactors.length})
                </div>
                {entry.newsFactors.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No headline mentioning {entry.symbol} influenced this decision.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {entry.newsFactors.map((n, i) => (
                      <li key={i} className="flex gap-2">
                        <span
                          className={
                            n.alignment === "aligned"
                              ? "text-emerald-400"
                              : "text-red-400"
                          }
                        >
                          {n.alignment === "aligned" ? "▲" : "▼"}
                        </span>
                        <span className="flex-1">
                          {n.headline}
                          {n.source ? (
                            <span className="text-muted-foreground"> — {n.source}</span>
                          ) : null}
                          {n.sentiment != null ? (
                            <span className="text-muted-foreground">
                              {" "}
                              (sent {n.sentiment.toFixed(2)})
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {entry.guardrails && (
                  <>
                    <div className="text-xs uppercase text-muted-foreground mt-3 mb-1">
                      Guardrails snapshot
                    </div>
                    <pre className="text-[10px] leading-tight bg-muted/50 rounded p-2 overflow-x-auto max-h-40">
                      {JSON.stringify(entry.guardrails, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
