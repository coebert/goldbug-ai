// Dashboard banner for a deteriorating broker-charge coverage trend.
//
// The cost-sync banner fires on a bad ingest pass. This one fires on the
// shape of the last three 7-day windows: coverage under the floor, or two
// consecutive windows of decline. Graded client-side from the same trend the
// coverage chart draws, so banner and chart can never disagree.
//
// The whole body is a link to the offending portfolio's coverage chart, and
// it prints the two windows the verdict was computed from — dates included —
// so the number can be checked rather than taken on trust.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ArrowRight, TrendingDown, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { getCoverageTrend } from "@/lib/fee-coverage-trend.functions";
import {
  evaluateCoverageTrendAlert,
  formatCoverageWindow,
  COVERAGE_TREND_WINDOW_DAYS,
  type CoverageWindowSummary,
} from "@/lib/coverage-trend-alert";
import { cn } from "@/lib/utils";

function WindowRow({ label, window: w }: { label: string; window: CoverageWindowSummary }) {
  return (
    <div className="flex items-baseline justify-between gap-3 tabular-nums">
      <span className="opacity-80">
        {label} <span className="opacity-70">{formatCoverageWindow(w)}</span>
      </span>
      <span className="font-medium">
        {w.coveragePct == null ? "—" : `${w.coveragePct}%`}
        <span className="ml-1 opacity-70">
          ({w.gradedDays} day{w.gradedDays === 1 ? "" : "s"})
        </span>
      </span>
    </div>
  );
}

export function CoverageTrendAlertBanner({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const fetchTrend = useServerFn(getCoverageTrend);

  const { data } = useQuery({
    queryKey: ["coverage-trend", "alert", COVERAGE_TREND_WINDOW_DAYS],
    queryFn: () => fetchTrend({ data: { days: 30, windowDays: COVERAGE_TREND_WINDOW_DAYS } }),
    staleTime: 300_000,
    refetchInterval: 600_000,
  });

  const series = data?.portfolios.find((s) => s.portfolioId === portfolioId);
  const alert = useMemo(
    () => (series ? evaluateCoverageTrendAlert(series, { windowDays: COVERAGE_TREND_WINDOW_DAYS }) : null),
    [series],
  );

  if (dismissed || !alert?.shouldAlert) return null;

  const critical = alert.severity === "critical";
  const severe = critical || alert.severity === "warning";
  const [recent, prior] = alert.windows;

  return (
    <Alert
      variant="destructive"
      className={cn(
        critical
          ? "border-red-500/60 bg-red-500/10 text-red-100"
          : severe
            ? "border-amber-500/50 bg-amber-500/5 text-amber-100"
            : "border-sky-500/50 bg-sky-500/5 text-sky-100",
        className,
      )}
    >
      <TrendingDown className="h-4 w-4" />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="rounded-sm border border-current/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {alert.severity}
          </span>
          <span>
            {alert.title}
            {series?.label ? ` — ${series.label}` : ""}
          </span>
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Dismiss coverage trend alert"
          className="h-6 w-6 shrink-0 opacity-70 hover:opacity-100"
          onClick={() => setDismissed(true)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AlertTitle>
      <AlertDescription className="text-xs">
        <Link
          to="/portfolio/$id"
          params={{ id: portfolioId }}
          hash="coverage-trend"
          className="block rounded-sm outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-current"
          aria-label={`Open the coverage trend chart for ${series?.label ?? "this portfolio"}`}
        >
          <JargonText>{alert.body}</JargonText>

          <div className="mt-2 space-y-1 rounded-md border border-current/20 bg-black/10 p-2">
            <WindowRow label={`Last ${COVERAGE_TREND_WINDOW_DAYS}d`} window={recent} />
            <WindowRow label={`Previous ${COVERAGE_TREND_WINDOW_DAYS}d`} window={prior} />
          </div>

          <span className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-2">
            View coverage trend <ArrowRight className="h-3 w-3" />
          </span>
        </Link>
      </AlertDescription>
    </Alert>
  );
}
