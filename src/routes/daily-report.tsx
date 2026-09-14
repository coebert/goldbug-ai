import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ListTree,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { TradeRationalePanel } from "@/components/trade-rationale-panel";
import { formatUkDate } from "@/lib/uk-time";
import {
  getDailyAiReport,
  type DailyReportFxLeg,
  type DailyReportItem,
} from "@/lib/daily-report.functions";
import type { DailyReportEquity, EquityMover } from "@/lib/daily-report-equity";
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

/**
 * FX funding legs are not ordinary positions: the currency they bought already
 * sits in the cash wallet, so only the unrealised P&L is live equity. The
 * report says that in words and links straight to the holdings card.
 */
function FxLegSection({ legs, portfolioId }: { legs: DailyReportFxLeg[]; portfolioId: string }) {
  if (legs.length === 0) return null;
  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Currency (FX) funding legs
        </h3>
        <Link
          to="/portfolio/$id"
          params={{ id: portfolioId }}
          hash="holdings"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
        >
          View in holdings
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="space-y-2">
        {legs.map((leg) => {
          const gain = (leg.unrealisedPnl ?? 0) >= 0;
          return (
            <li key={leg.symbol} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{leg.symbol}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {leg.direction}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  entry {leg.entryRate.toFixed(4)}
                  {leg.currentRate != null
                    ? ` · now ${leg.currentRate.toFixed(4)}`
                    : " · current rate unavailable"}
                </div>
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    leg.unrealisedPnl == null
                      ? "text-muted-foreground"
                      : gain
                        ? "text-emerald-500"
                        : "text-rose-400",
                  )}
                >
                  {leg.unrealisedPnl == null
                    ? "—"
                    : `${gain ? "+" : "−"}${money(Math.abs(leg.unrealisedPnl), leg.quoteCcy)}`}
                </div>
                <div className="text-[11px] text-muted-foreground">unrealised P&L</div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        The cash these legs raised is already counted in the account balance, so only the profit or
        loss above changes your equity.
      </p>
    </div>
  );
}

function MoverRow({ mover, currency }: { mover: EquityMover; currency: string }) {
  const up = mover.contribution >= 0;
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="font-medium">{mover.symbol}</span>
      <span className={cn("tabular-nums", up ? "text-emerald-500" : "text-rose-400")}>
        {up ? "+" : "−"}
        {money(Math.abs(mover.contribution), currency)}
        {mover.pricePct != null && (
          <span className="ml-1 text-muted-foreground">
            ({mover.pricePct >= 0 ? "+" : "−"}
            {Math.abs(mover.pricePct).toFixed(2)}%)
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Why the account is worth more (or less) than it was, what drove it, whether
 * that looks likely to persist, and the limits the move already feeds.
 */
function EquitySection({ equity }: { equity: DailyReportEquity }) {
  if (!equity?.hasData || !equity.day) {
    return (
      <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
        No measured change in account value was recorded for this date.
      </p>
    );
  }
  const ccy = equity.currency;
  const up = equity.day.pnl >= 0;
  const r = equity.reaction;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Why the account value moved
      </h3>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-[11px] text-muted-foreground">Account value</div>
          <div className="text-sm font-semibold tabular-nums">{money(equity.equity, ccy)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">Today</div>
          <div
            className={cn(
              "text-sm font-semibold tabular-nums",
              up ? "text-emerald-500" : "text-rose-400",
            )}
          >
            {up ? "+" : "−"}
            {money(Math.abs(equity.day.pnl), ccy)}
            {equity.day.pct != null && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({equity.day.pct >= 0 ? "+" : "−"}
                {Math.abs(equity.day.pct).toFixed(2)}%)
              </span>
            )}
          </div>
        </div>
        {equity.week && (
          <div>
            <div className="text-[11px] text-muted-foreground">Past week</div>
            <div className="text-sm font-semibold tabular-nums">
              {equity.week.pnl >= 0 ? "+" : "−"}
              {money(Math.abs(equity.week.pnl), ccy)}
            </div>
          </div>
        )}
        {equity.month && (
          <div>
            <div className="text-[11px] text-muted-foreground">Past month</div>
            <div className="text-sm font-semibold tabular-nums">
              {equity.month.pnl >= 0 ? "+" : "−"}
              {money(Math.abs(equity.month.pnl), ccy)}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {equity.split.positions != null && (
          <Badge variant="outline" className="text-[10px]">
            Holdings {equity.split.positions >= 0 ? "+" : "−"}
            {money(Math.abs(equity.split.positions), ccy)}
          </Badge>
        )}
        {equity.split.fxLegs != null && equity.split.fxLegs !== 0 && (
          <Badge variant="outline" className="text-[10px]">
            Currency legs {equity.split.fxLegs >= 0 ? "+" : "−"}
            {money(Math.abs(equity.split.fxLegs), ccy)}
          </Badge>
        )}
        {equity.split.fees != null && equity.split.fees !== 0 && (
          <Badge variant="outline" className="text-[10px]">
            Charges {money(equity.split.fees, ccy)}
          </Badge>
        )}
      </div>

      {(equity.helped.length > 0 || equity.hurt.length > 0) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {equity.helped.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Helped most</div>
              <ul className="space-y-1">
                {equity.helped.map((m) => (
                  <MoverRow key={m.symbol} mover={m} currency={ccy} />
                ))}
              </ul>
            </div>
          )}
          {equity.hurt.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Hurt most</div>
              <ul className="space-y-1">
                {equity.hurt.map((m) => (
                  <MoverRow key={m.symbol} mover={m} currency={ccy} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 space-y-1">
        <div className="text-[11px] font-medium text-muted-foreground">
          Is this likely to continue?
        </div>
        <p className="text-xs leading-relaxed">{equity.persistence.text}</p>
      </div>

      <div className="mt-3 space-y-1">
        <div className="text-[11px] font-medium text-muted-foreground">How the AI is reacting</div>
        <ul className="space-y-0.5 text-xs leading-relaxed text-muted-foreground">
          {r.drawdownPct != null && (
            <li>
              {r.drawdownPct.toFixed(2)}% below its best-ever value
              {r.drawdownLimitPct != null
                ? ` — it stops buying altogether at ${r.drawdownLimitPct.toFixed(1)}%`
                : ""}
              .
            </li>
          )}
          {r.cashPct != null && (
            <li>
              {r.cashPct.toFixed(0)}% of the account is still in cash
              {r.targetPerNamePct != null
                ? `, and each new position is sized towards ${r.targetPerNamePct.toFixed(0)}% of the account`
                : ""}
              .
            </li>
          )}
          {r.dailyNotionalLimit != null && (
            <li>It may spend at most {money(r.dailyNotionalLimit, ccy)} in a single day.</li>
          )}
          {r.haltActive && (
            <li className="text-amber-500">
              New buying is currently halted{r.haltReason ? ` — ${r.haltReason}` : ""}.
            </li>
          )}
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </div>
  );
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

              <EquitySection equity={p.equity} />

              <FxLegSection legs={p.fxLegs} portfolioId={p.portfolioId} />

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
