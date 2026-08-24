import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, TrendingDown, TrendingUp } from "lucide-react";
import type { ModeSummaryPair } from "@/lib/mode-summary";
import { ukHour, ukZoneAbbr } from "@/lib/uk-time";
import { ModeSummaryTile } from "./mode-summary-tile";

/**
 * Hero "Today" band — the scan-first answer to
 * "how am I doing right now?". Combines real + simulated equity into
 * a single display-typography headline, with the live next-run
 * countdown pinned on the right. The per-mode tiles remain beneath it
 * (they carry contract-tested formatting; see
 * real-money-equity-formatting.contract.test.tsx).
 */
export function TodayHero({
  summary,
  mixedCurrency = false,
  currencies = [],
}: {
  summary: ModeSummaryPair;
  mixedCurrency?: boolean;
  currencies?: string[];
}) {
  const nextRun = useNextRunCountdown();
  if (!summary) {
    return (
      <section className="mb-6 rounded-2xl border border-border/70 bg-surface-2 px-4 py-5 shadow-[var(--shadow-card)] sm:px-6 sm:py-6">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Today</div>
        <div className="mt-1 font-display text-2xl font-bold tracking-tight sm:text-3xl">
          No equity snapshots yet
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a portfolio and run the AI to see combined equity here.
        </p>
      </section>
    );
  }

  // Real money leads: the headline figure is the broker-held equity.
  const realNow = safe(summary.real.now);
  const realPnl = safe(summary.real.pnl);
  // Use the same deposit-adjusted percentage as the tile below, otherwise a
  // day with a deposit shows two different percentages on one screen.
  const realPct = safe(summary.real.pct);

  const positive = realPnl >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;
  const simNow = safe(summary.sim.now);
  const simPnl = safe(summary.sim.pnl);
  const simPositive = simPnl >= 0;
  const combinedNow = realNow + simNow;


  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-border/70 bg-surface-2 shadow-[var(--shadow-card)]">
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6 sm:py-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Today · real money equity</span>
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium normal-case text-foreground/70">
              {summary.real.count} portfolio{summary.real.count === 1 ? "" : "s"} at your broker
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <span className="font-display text-[1.75rem] font-bold leading-none tracking-tight tabular-nums break-all sm:text-4xl">
              {formatGBP(realNow)}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
                positive ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"
              }`}
              aria-label={`Change since yesterday: ${positive ? "up" : "down"} ${Math.abs(realPct).toFixed(2)} percent`}
            >
              <TrendIcon className="h-3 w-3" aria-hidden />
              {positive ? "+" : ""}
              {realPct.toFixed(2)}%
            </span>
            <span
              className={`text-xs tabular-nums ${positive ? "text-success" : "text-destructive"}`}
            >
              {positive ? "+" : ""}
              {formatGBP(realPnl)} vs yesterday
            </span>
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground tabular-nums">
            Practice money: {formatGBP(simNow)}{" "}
            <span className={simPositive ? "text-success" : "text-destructive"}>
              ({simPositive ? "+" : ""}
              {formatGBP(simPnl)})
            </span>{" "}
            · Combined {formatGBP(combinedNow)}
          </div>
          {mixedCurrency && (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-500 sm:inline-flex"
              role="status"
              aria-live="polite"
              title="Portfolios use different currencies; combined equity is the raw sum without FX conversion."
            >
              <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0">
                Combined figure is an un-converted sum — portfolios span {currencies.join(", ")}.
              </span>
            </div>
          )}

        </div>
        <div className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-surface-sunken px-3 py-2.5 sm:w-auto sm:shrink-0 sm:py-2">
          <Clock className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Next AI run</div>
            <div className="font-display text-sm font-semibold tabular-nums">
              {nextRun.label} <span className="ml-1 text-xs font-normal text-muted-foreground">in {nextRun.eta}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-2 border-t border-border/60 px-4 py-3 sm:grid-cols-2 sm:gap-3 sm:px-6 sm:py-4">

        <ModeSummaryTile
          label="Real money"
          sublabel="Held at your broker"
          tone="real"
          money={summary.real.now}
          pnl={summary.real.pnl}
          pct={summary.real.pct}
          count={summary.real.count}
        />
        <div className="opacity-70">
          <ModeSummaryTile
            label="Practice money"
            sublabel="Pretend cash, real prices"
            tone="sim"
            money={summary.sim.now}
            pnl={summary.sim.pnl}
            pct={summary.sim.pct}
            count={summary.sim.count}
          />
        </div>
      </div>

    </section>
  );
}

function safe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function formatGBP(n: number): string {
  const safeN = Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : 0;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(safeN);
}

/** Live countdown to the next hourly UK AI run. */
function useNextRunCountdown() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const nextHour = (ukHour(now) + 1) % 24;
    const label = `${String(nextHour).padStart(2, "0")}:00 ${ukZoneAbbr(now)}`;
    const nextDate = new Date(now);
    nextDate.setMinutes(0, 0, 0);
    nextDate.setHours(nextDate.getHours() + 1);
    const remaining = Math.max(0, nextDate.getTime() - now.getTime());
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const eta = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    return { label, eta };
  }, [now]);
}
