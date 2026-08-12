// Reported director / PDMR share dealings for the symbols this book holds.
//
// General news wires never carry RNS director-dealing notifications, so this
// card is the only place an insider sale in a large position surfaces. Rows
// are ranked by severity: a discretionary open-market sale by a named CEO
// matters, a tax-withholding disposal on vested shares mostly does not.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { UserMinus, RefreshCw, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getInsiderDealings, type InsiderDealingsFeed } from "@/lib/insider-dealings.functions";
import type { InsiderDealingEvent } from "@/lib/insider-dealings";
import { InsiderDealingDetailPanel } from "@/components/insider-dealing-detail-panel";
import { cn } from "@/lib/utils";

function flavourLabel(e: InsiderDealingEvent): string {
  if (e.flavour === "tax") return "Tax / vesting";
  if (e.flavour === "award") return "Award related";
  if (e.flavour === "discretionary") return "Open market";
  return "Unclassified";
}

function severityTone(e: InsiderDealingEvent): string {
  if (e.direction === "buy") return "text-emerald-400 border-emerald-500/40";
  if (e.severity >= 0.6) return "text-destructive border-destructive/50";
  if (e.severity >= 0.3) return "text-amber-400 border-amber-500/40";
  return "text-muted-foreground border-border";
}

export function InsiderDealingsCard({ className }: { className?: string }) {
  const [feed, setFeed] = useState<InsiderDealingsFeed | null>(null);
  const [selected, setSelected] = useState<InsiderDealingEvent | null>(null);

  const load = useMutation({
    mutationFn: (refresh: boolean) =>
      getInsiderDealings({ data: { sinceDays: 21, refresh } }) as Promise<InsiderDealingsFeed>,
    onSuccess: (d) => setFeed(d),
  });

  // Load stored events once on mount, without hitting the upstream feeds.
  const loadedRef = useRef(false);
  const mutate = load.mutate;
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    mutate(false);
  }, [mutate]);

  const events = feed?.events ?? [];
  // The AI scan's own read comes first: anything it rejected as not-an-insider
  // -dealing is hidden, and confirmed signals outrank keyword severity.
  const ranked = events
    .filter((e) => e.ai_verdict !== "noise")
    .sort((a, b) => {
      const rank = (v: (typeof a)["ai_verdict"]) => (v === "signal" ? 2 : v == null ? 1 : 0);
      return rank(b.ai_verdict) - rank(a.ai_verdict) || b.severity - a.severity;
    })
    .slice(0, 8);
  const scan = feed?.last_scan ?? null;


  return (
    <Card className={cn("border-border/60", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserMinus className="h-4 w-4 text-muted-foreground" />
          Insider &amp; director dealings
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => load.mutate(true)}
          disabled={load.isPending}
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", load.isPending && "animate-spin")} />
          {load.isPending ? "Checking…" : "Check now"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Reported share sales and purchases by executives of the companies you hold. Tax and
          vesting disposals are scored down; open-market sales by a CEO or CFO are scored up.
        </p>

        {ranked.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
            {load.isPending
              ? "Scanning regulatory news for your holdings…"
              : "No reported director dealings for your holdings in the last three weeks."}
          </p>
        ) : (
          <ul className="space-y-2">
            {ranked.map((e, i) => (
              <li key={`${e.symbol}-${i}-${e.headline.slice(0, 24)}`}>
                <button
                  type="button"
                  onClick={() => setSelected(e)}
                  aria-label={`Show filing detail for ${e.symbol}`}
                  className="w-full rounded-md border border-border/60 bg-muted/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {e.symbol}
                  </Badge>
                  <Badge variant="outline" className={cn("text-[11px]", severityTone(e))}>
                    {e.direction === "buy" ? "Buy" : "Sell"} · {flavourLabel(e)}
                  </Badge>
                  {e.role ? (
                    <span className="text-[11px] text-muted-foreground">
                      {e.person ? `${e.person} · ` : ""}
                      {e.role}
                    </span>
                  ) : null}
                  {e.event_date ? (
                    <span className="ml-auto text-[11px] text-muted-foreground">{e.event_date}</span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-sm leading-snug">{e.headline}</p>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  {e.shares != null ? <span>{e.shares.toLocaleString()} shares</span> : null}
                  <span>signal nudge {e.sentiment_nudge.toFixed(3)}</span>
                  {e.url ? (
                    <span className="inline-flex items-center gap-1">
                      source <ExternalLink className="h-3 w-3" />
                    </span>
                  ) : null}
                  <span className="ml-auto text-primary">details →</span>
                </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <InsiderDealingDetailPanel
        event={selected}
        symbolEvents={selected ? events.filter((e) => e.symbol === selected.symbol) : []}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </Card>
  );
}
