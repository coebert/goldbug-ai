import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { formatUkDate } from "@/lib/uk-time";
import { getDailyAiReport, type DailyReportItem } from "@/lib/daily-report.functions";
import { cn } from "@/lib/utils";

const TITLE = "Daily AI report — Aegis";
const DESC =
  "What the AI considered today, why it bought or sold, and why it passed on everything else.";

export const Route = createFileRoute("/daily-report")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DailyReportPage,
});

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function money(n: number | null, ccy: string): string {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)} ${ccy}`;
  }
}

function ItemRow({
  item,
  currency,
  tone,
  portfolioId,
  date,
}: {
  item: DailyReportItem;
  currency: string;
  tone: "buy" | "sell" | "hold" | "pass";
  portfolioId: string;
  date: string;
}) {
  const [open, setOpen] = useState(false);
  const toneClass =
    tone === "buy"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "sell"
        ? "border-destructive/30 bg-destructive/5"
        : tone === "hold"
          ? "border-border bg-muted/20"
          : "border-amber-500/25 bg-amber-500/5";
  const why = tone === "pass" ? item.passedReason : item.rationale;
  return (
    <li className={cn("rounded-lg border p-3", toneClass)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{item.symbol}</span>
        {item.action && (
          <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
            {item.action}
          </Badge>
        )}
        {item.outcome && (
          <Badge variant="outline" className="text-[10px] capitalize">
            {item.outcome}
          </Badge>
        )}
        {item.notional != null && (
          <span className="ml-auto text-xs text-muted-foreground">
            {money(item.notional, currency)}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {why || "No reason recorded for this decision."}
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="mt-1 h-7 px-2 text-[11px]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ListTree className="mr-1 h-3.5 w-3.5" />
        {open ? "Hide rationale" : "Signals & events"}
      </Button>
      {open && (
        <div className="mt-2 rounded-md border bg-background/60 p-2">
          <TradeRationalePanel portfolioId={portfolioId} symbol={item.symbol} date={date} />
        </div>
      )}
    </li>
  );
}

function Section({
  title,
  items,
  currency,
  tone,
  portfolioId,
  date,
}: {
  title: string;
  items: DailyReportItem[];
  currency: string;
  tone: "buy" | "sell" | "hold" | "pass";
  portfolioId: string;
  date: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="space-y-2">
        {items.slice(0, 40).map((i, idx) => (
          <ItemRow
            key={`${i.symbol}-${idx}`}
            item={i}
            currency={currency}
            tone={tone}
            portfolioId={portfolioId}
            date={date}
          />
        ))}
      </ul>
      {items.length > 40 && (
        <p className="text-xs text-muted-foreground">+ {items.length - 40} more not shown.</p>
      )}
    </div>
  );
}

function DailyReportPage() {
  const [date, setDate] = useState(todayIso());
  const fetchReport = useServerFn(getDailyAiReport);

  const query = useQuery({
    queryKey: ["daily-ai-report", date],
    queryFn: () => fetchReport({ data: { date } }),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-4 pb-24">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Daily AI report</h1>
          <p className="text-sm text-muted-foreground">{DESC}</p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDate((d) => shiftIso(d, -1))}
            aria-label="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-medium">{formatUkDate(date)}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDate((d) => shiftIso(d, 1))}
            disabled={date >= todayIso()}
            aria-label="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDate(todayIso())} disabled={date === todayIso()}>
            Today
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh report"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
          </Button>
        </div>

        {query.isLoading && <div className="h-40 animate-pulse rounded-lg bg-muted" aria-hidden />}
        {query.error && (
          <p className="text-sm text-destructive">
            Couldn't build the report: {(query.error as Error).message}
          </p>
        )}

        {query.data?.portfolios.length === 0 && !query.isLoading && (
          <p className="text-sm text-muted-foreground">No portfolios to report on.</p>
        )}

        {query.data?.portfolios.map((p) => (
          <Card key={p.portfolioId}>
            <CardHeader className="space-y-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                {p.name}
                {p.mode && (
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {p.mode}
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {p.considered} asset{p.considered === 1 ? "" : "s"} considered · {p.bought.length} bought ·{" "}
                {p.sold.length} sold · {p.passed.length} passed
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-relaxed">{p.narrative}</p>
              {p.runExplanation && (
                <p className="rounded-md border bg-muted/30 p-2 text-xs leading-relaxed text-muted-foreground">
                  Engine note: {p.runExplanation}
                </p>
              )}

              {p.passReasonCounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {p.passReasonCounts.slice(0, 6).map((r) => (
                    <Badge key={r.reason} variant="outline" className="text-[10px]">
                      {r.reason} · {r.count}
                    </Badge>
                  ))}
                </div>
              )}

              {p.considered > 0 && <Separator />}

              {(
                [
                  ["Bought", p.bought, "buy"],
                  ["Sold", p.sold, "sell"],
                  ["Held", p.held, "hold"],
                  ["Passed on", p.passed, "pass"],
                ] as const
              ).map(([title, items, tone]) => (
                <Section
                  key={tone}
                  title={title}
                  items={items}
                  currency={p.currency}
                  tone={tone}
                  portfolioId={p.portfolioId}
                  date={date}
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </main>
    </div>
  );
}
