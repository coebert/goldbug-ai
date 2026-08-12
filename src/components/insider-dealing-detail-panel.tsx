// Detail panel for one insider-dealing alert: the filing as parsed, how the
// disposal was typed, which held ticker it matched, and the exact nudge that
// reaches the AI decision for that symbol.

import { ExternalLink, FileText, Scale, Target } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { InsiderDealingEvent } from "@/lib/insider-dealings";
import { explainInsiderEvent } from "@/lib/insider-dealing-explain";
import { cn } from "@/lib/utils";

function signed(n: number, digits = 3): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** Small horizontal bar showing where a 0..1 weight sits. */
function WeightRow({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{value.toFixed(2)}x</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/70"
          style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
        />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{note}</p>
    </div>
  );
}

export function InsiderDealingDetailPanel({
  event,
  symbolEvents,
  open,
  onOpenChange,
}: {
  event: InsiderDealingEvent | null;
  /** All recent filings for the same ticker, so the summed nudge is honest. */
  symbolEvents?: InsiderDealingEvent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ex = event ? explainInsiderEvent(event, symbolEvents ?? [event]) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {ex ? (
          <>
            <SheetHeader className="space-y-2 text-left">
              <SheetTitle className="text-base leading-snug">{ex.event.headline}</SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-[11px]">
                  {ex.match.symbol}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[11px]",
                    ex.disposal.mechanical
                      ? "border-border text-muted-foreground"
                      : ex.disposal.direction === "sell"
                        ? "border-destructive/50 text-destructive"
                        : "border-emerald-500/40 text-emerald-400",
                  )}
                >
                  {ex.disposal.label}
                </Badge>
                {ex.match.primary ? (
                  <Badge variant="outline" className="border-primary/40 text-[11px] text-primary">
                    Primary filing
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[11px]">
                    Reported
                  </Badge>
                )}
                </div>
              </SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-6">
              {/* Filing fields */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Filing fields
                </h3>
                <dl className="divide-y divide-border/60 rounded-md border border-border/60">
                  {ex.filing.map((f) => (
                    <div key={f.label} className="grid grid-cols-[9rem_1fr] gap-3 px-3 py-2">
                      <dt className="text-xs text-muted-foreground">{f.label}</dt>
                      <dd className="text-xs leading-snug break-words">
                        {f.value}
                        {f.hint ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">({f.hint})</span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
                {ex.event.url ? (
                  <a
                    href={ex.event.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                  >
                    Open the original filing <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </section>

              <Separator />

              {/* Disposal type + ticker match */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <Target className="h-4 w-4 text-muted-foreground" />
                  Parsed disposal type &amp; matched ticker
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{ex.disposal.reason}</p>
                <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs">
                  Matched <span className="font-mono">{ex.match.symbol}</span>
                  {ex.match.company ? ` (${ex.match.company})` : ""} from{" "}
                  <span className="text-muted-foreground">{ex.match.source}</span>.{" "}
                  {ex.match.primary
                    ? "Read straight from the regulatory filing, so the fields above are authoritative."
                    : "Derived from press reporting, so fields may be partial until the filing is read."}
                </div>
              </section>

              <Separator />

              {/* Nudge maths */}
              <section className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <Scale className="h-4 w-4 text-muted-foreground" />
                  Nudge applied to the AI decision
                </h3>

                <div className="grid gap-3 sm:grid-cols-3">
                  <WeightRow
                    label="Type weight"
                    value={ex.nudge.breakdown.flavourWeight}
                    note="Discretionary 1.0 · award 0.35 · tax 0.15"
                  />
                  <WeightRow
                    label="Role weight"
                    value={ex.nudge.breakdown.roleWeight}
                    note="CEO 1.0 · CFO 0.9 · Chair/COO 0.75 · other 0.6"
                  />
                  <WeightRow
                    label="Size weight"
                    value={ex.nudge.breakdown.sizeWeight}
                    note="£250k barely registers · £5m saturates"
                  />
                </div>

                <div className="rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
                  <div>
                    severity = {ex.nudge.breakdown.flavourWeight.toFixed(2)} ×{" "}
                    {ex.nudge.breakdown.roleWeight.toFixed(2)} × (0.5 + 0.5 ×{" "}
                    {ex.nudge.breakdown.sizeWeight.toFixed(2)}) ={" "}
                    <span className="font-semibold">{ex.nudge.breakdown.severity.toFixed(3)}</span>
                  </div>
                  <div>
                    this filing = {ex.event.direction === "sell" ? "-0.15" : "+0.10"} ×{" "}
                    {ex.nudge.breakdown.severity.toFixed(3)} ={" "}
                    <span className="font-semibold">{signed(ex.nudge.eventNudge)}</span>
                  </div>
                  <div>
                    {ex.match.symbol} total over {ex.nudge.symbolEvents} filing
                    {ex.nudge.symbolEvents === 1 ? "" : "s"} = {signed(ex.nudge.symbolRaw)}
                    {ex.nudge.capped
                      ? ` → clamped to ${signed(ex.nudge.symbolApplied)} (bounds ${ex.nudge.floor} .. +${ex.nudge.ceiling})`
                      : ""}
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Applied to news score</span>
                  <span
                    className={cn(
                      "font-mono text-sm font-semibold tabular-nums",
                      ex.nudge.symbolApplied < 0
                        ? "text-destructive"
                        : ex.nudge.symbolApplied > 0
                          ? "text-emerald-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {signed(ex.nudge.symbolApplied)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{ex.effect}</p>
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
