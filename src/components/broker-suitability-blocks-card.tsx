import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardList, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  clearBrokerInstrumentBlock,
  listBrokerInstrumentBlocks,
  recheckBrokerInstrumentBlocks,
  type BrokerBlockDTO,
} from "@/lib/broker-instrument-blocks.functions";
import { Progress } from "@/components/ui/progress";
import { buildSaxoChecklist } from "@/lib/saxo-product-categories";
import { computeUnblockProgress } from "@/lib/saxo-unblock-progress";
import {
import { publishRationaleRefresh } from "@/lib/rationale-refresh";
  decideAutoRecheck,
  readLastAutoRecheck,
  writeLastAutoRecheck,
} from "@/lib/saxo-auto-recheck";

const DONE_STORAGE_KEY = "saxo-unblock-progress";

/** Persisted so ticking a section survives a reload while you sit in Saxo. */
function useCompletedCategories() {
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DONE_STORAGE_KEY);
      if (raw) setDone(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* ignore unreadable storage */
    }
  }, []);

  const toggle = (id: string, value: boolean) =>
    setDone((prev) => {
      const next = { ...prev, [id]: value };
      try {
        window.localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore unwritable storage */
      }
      return next;
    });

  return { done, toggle };
}

const REASON_COPY: Record<
  string,
  { label: string; what: string; next: string[] }
> = {
  suitability: {
    label: "Suitability test needed",
    what:
      "Saxo classes this as a complex product (ETC/ETN, leveraged or derivative). Orders are refused until the account passes the appropriateness/suitability questionnaire for that product category.",
    next: [
      "Sign in to Saxo and open Account → Profile → Investor profile / Appropriateness test.",
      "Complete the knowledge & experience questionnaire for the relevant product category (e.g. ETCs / commodities).",
      "Come back here and clear the block so the AI can trade the instrument again.",
    ],
  },
  not_tradable: {
    label: "Not tradable on this account",
    what:
      "The instrument is not available on this Saxo account type or market data/exchange access is missing.",
    next: [
      "Check the instrument is listed for your account type in Saxo's trading platform.",
      "Add the exchange subscription or ask Saxo support to enable it.",
      "Clear the block once Saxo confirms the instrument is tradable.",
    ],
  },
  not_permitted: {
    label: "Trading permission missing",
    what:
      "The account does not hold the trading permission required for this product (e.g. derivatives or margin products).",
    next: [
      "Request the additional trading permission in your Saxo account settings.",
      "Wait for Saxo to approve the upgrade (usually the same working day).",
      "Clear the block after approval.",
    ],
  },
};

function copyFor(reason: string) {
  return (
    REASON_COPY[reason] ?? {
      label: reason,
      what: "The broker refused orders for this instrument on this account.",
      next: ["Contact Saxo support to confirm why the instrument is restricted."],
    }
  );
}

function BlockRow({
  block,
  onClear,
  clearing,
}: {
  block: BrokerBlockDTO;
  onClear: () => void;
  clearing: boolean;
}) {
  const copy = copyFor(block.reason);
  return (
    <div className="min-w-0 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="break-all font-mono text-sm font-semibold text-foreground">
          {block.symbol}
        </span>
        <Badge variant="outline" className="border-amber-500/40 text-amber-500">
          {copy.label}
        </Badge>
        <span className="w-full text-xs text-muted-foreground sm:w-auto">
          {block.hitCount} rejection{block.hitCount === 1 ? "" : "s"} · last{" "}
          {new Date(block.lastSeenAt).toLocaleDateString("en-GB")}
        </span>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{block.detail ?? copy.what}</p>

      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What to do next
      </p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {copy.next.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
          <a
            href="https://www.home.saxo/en-gb"
            target="_blank"
            rel="noreferrer noopener"
          >
            Open Saxo <ExternalLink className="ml-1 h-3.5 w-3.5" />
          </a>
        </Button>
        <Button
          size="sm"
          onClick={onClear}
          disabled={clearing}
          className="h-auto w-full whitespace-normal py-2 text-center sm:w-auto"
        >
          {clearing ? "Clearing…" : "I've completed this — unblock"}
        </Button>
      </div>
    </div>
  );
}

function SaxoChecklist({
  blocks,
  onUnblockSymbols,
  clearing,
  onCompletedCountChange,
}: {
  blocks: BrokerBlockDTO[];
  onUnblockSymbols: (symbols: string[]) => void;
  clearing: boolean;
  onCompletedCountChange?: (count: number) => void;
}) {
  const items = buildSaxoChecklist(blocks);
  const { done, toggle } = useCompletedCategories();
  const progress = computeUnblockProgress(items, done);

  const completedCount = progress.completedCategories;
  useEffect(() => {
    onCompletedCountChange?.(completedCount);
  }, [completedCount, onCompletedCountChange]);

  if (items.length === 0) return null;

  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ClipboardList className="h-4 w-4 shrink-0 text-amber-500" />
        Saxo sections to complete ({progress.completedCategories}/{progress.totalCategories})
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Tick a section once you have completed it at Saxo, then unblock its symbols here.
      </p>

      <Progress value={progress.percent} className="mt-2.5 h-2" />
      <p className="mt-1.5 text-xs text-muted-foreground">
        {progress.symbolsWaiting.length === 0
          ? "All sections ticked — unblock the symbols below."
          : `${progress.symbolsWaiting.length} symbol${
              progress.symbolsWaiting.length === 1 ? "" : "s"
            } still waiting on a Saxo test: `}
        {progress.symbolsWaiting.length > 0 && (
          <span className="break-all font-mono">{progress.symbolsWaiting.join(" · ")}</span>
        )}
      </p>

      <ul className="mt-3 space-y-2.5">
        {progress.categories.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-2.5">
            <Checkbox
              id={`saxo-cat-${item.id}`}
              checked={item.completed}
              onCheckedChange={(v) => toggle(item.id, v === true)}
              className="mt-0.5 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor={`saxo-cat-${item.id}`} className="block min-w-0 cursor-pointer">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={
                      item.completed
                        ? "text-sm font-medium text-muted-foreground line-through"
                        : "text-sm font-medium text-foreground"
                    }
                  >
                    {item.title}
                  </span>
                  {item.completed ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/40 text-emerald-500"
                    >
                      Test done
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                      Waiting
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">{item.where}</span>
                <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
                  {item.symbols.join(" · ")}
                </span>
              </label>
              {item.completed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={clearing}
                  className="mt-1.5 h-auto w-full whitespace-normal py-1.5 text-xs sm:w-auto"
                  onClick={() => onUnblockSymbols(item.symbols)}
                >
                  {clearing
                    ? "Unblocking…"
                    : `Unblock ${item.symbols.length} symbol${
                        item.symbols.length === 1 ? "" : "s"
                      }`}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BrokerSuitabilityBlocksCard() {
  const qc = useQueryClient();
  const list = useServerFn(listBrokerInstrumentBlocks);
  const clear = useServerFn(clearBrokerInstrumentBlock);
  const recheck = useServerFn(recheckBrokerInstrumentBlocks);

  const q = useQuery({
    queryKey: ["broker-instrument-blocks"],
    queryFn: () => list(),
  });

  const mut = useMutation({
    mutationFn: (symbolKey: string) => clear({ data: { symbolKey } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broker-instrument-blocks"] });
      publishRationaleRefresh("broker-assessments", "instrument block cleared");
    },
  });

  const recheckMut = useMutation({
    mutationFn: () => recheck(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broker-instrument-blocks"] });
      publishRationaleRefresh("broker-assessments", "broker re-check complete");
    },
  });

  const blocks = q.data?.blocks ?? [];

  // Auto re-check: ticking a Saxo section off the checklist is the closest
  // signal we get that an assessment was just updated, so re-probe the broker
  // straight away instead of waiting for a manual tap.
  const [autoRan, setAutoRan] = useState(false);
  const prevCompleted = useRef<number | null>(null);
  const recheckRef = useRef(recheckMut);
  recheckRef.current = recheckMut;

  const handleCompletedCountChange = useCallback(
    (count: number) => {
      const prev = prevCompleted.current;
      prevCompleted.current = count;
      if (prev === null || count <= prev) return;

      const decision = decideAutoRecheck({
        lastRunAt: readLastAutoRecheck(),
        now: Date.now(),
        blockCount: blocks.length,
        completedCategories: count,
        busy: recheckRef.current.isPending,
      });
      if (!decision.run) return;

      writeLastAutoRecheck(Date.now());
      setAutoRan(true);
      recheckRef.current.mutate();
    },
    [blocks.length],
  );



  return (
    <Card>
      <CardHeader className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="min-w-0 break-words">Broker checks blocking trades</span>
        </CardTitle>
        <div className="flex w-fit shrink-0 flex-wrap items-center gap-2">
          {blocks.length > 0 && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-500">
              {blocks.length} blocked
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => recheckMut.mutate()}
            disabled={recheckMut.isPending}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${recheckMut.isPending ? "animate-spin" : ""}`}
            />
            {recheckMut.isPending ? "Re-checking…" : "Re-check Saxo blocks"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {autoRan && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw
              className={`h-3.5 w-3.5 shrink-0 ${recheckMut.isPending ? "animate-spin" : ""}`}
            />
            {recheckMut.isPending
              ? "Saxo assessment ticked — re-checking your blocked list automatically…"
              : "Auto re-check ran after your Saxo assessment update."}
          </p>
        )}
        {recheckMut.isError && (
          <p className="text-sm text-destructive">
            Re-check failed. Confirm two-factor and the Saxo connection, then try again.
          </p>
        )}
        {recheckMut.data && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <p className="font-medium text-foreground">{recheckMut.data.message}</p>
            {recheckMut.data.results.length > 0 && (
              <ul className="mt-2 space-y-2 text-xs">
                {recheckMut.data.results.map((r) => {
                  const tone =
                    r.outcome === "cleared"
                      ? "text-emerald-500"
                      : r.outcome === "blocked"
                        ? "text-amber-500"
                        : "text-muted-foreground";
                  const detail = [
                    r.brokerCode,
                    r.brokerMessage,
                    ...(r.brokerDetails ?? []),
                  ].filter(Boolean) as string[];
                  return (
                    <li
                      key={r.symbolKey}
                      className="break-words rounded-md border border-border/60 bg-background/40 p-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-foreground">{r.symbol}</span>
                        <span className={`font-medium uppercase ${tone}`}>{r.outcome}</span>
                        {r.reason && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {r.reason.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-muted-foreground">{r.note}</p>
                      {detail.length > 0 && (
                        <p className="mt-1 font-mono text-[11px] leading-snug text-muted-foreground/90">
                          Saxo said: {detail.join(" · ")}
                          {r.brokerPreCheckResult ? ` (precheck: ${r.brokerPreCheckResult})` : ""}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

          </div>
        )}

        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading broker blocks…</p>
        )}

        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not load broker blocks.
          </p>
        )}

        {!q.isLoading && !q.error && blocks.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            No suitability or permission checks are blocking trades right now.
          </p>
        )}

        {blocks.length > 0 && (
          <SaxoChecklist
            blocks={blocks}
            clearing={mut.isPending}
            onUnblockSymbols={(symbols) => {
              for (const symbol of symbols) {
                const match = blocks.find((b) => b.symbol === symbol);
                if (match) mut.mutate(match.symbolKey);
              }
            }}
            onCompletedCountChange={handleCompletedCountChange}
          />
        )}

        {blocks.map((b) => (
          <BlockRow
            key={b.symbolKey}
            block={b}
            clearing={mut.isPending && mut.variables === b.symbolKey}
            onClear={() => mut.mutate(b.symbolKey)}
          />
        ))}
      </CardContent>
    </Card>
  );
}
