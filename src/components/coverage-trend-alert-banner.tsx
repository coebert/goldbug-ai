// Dashboard banner for a deteriorating broker-charge coverage trend.
//
// The cost-sync banner fires on a bad ingest pass. This one fires on the
// shape of the last three 7-day windows: coverage under the floor, or two
// consecutive windows of decline. Graded client-side from the same trend the
// coverage chart draws, so banner and chart can never disagree.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TrendingDown, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { getCoverageTrend } from "@/lib/fee-coverage-trend.functions";
import {
  evaluateCoverageTrendAlert,
  COVERAGE_TREND_WINDOW_DAYS,
} from "@/lib/coverage-trend-alert";
import { cn } from "@/lib/utils";

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

  const alert = useMemo(() => {
    const series = data?.portfolios.find((s) => s.portfolioId === portfolioId);
    if (!series) return null;
    return evaluateCoverageTrendAlert(series, { windowDays: COVERAGE_TREND_WINDOW_DAYS });
  }, [data, portfolioId]);

  if (dismissed || !alert?.shouldAlert) return null;

  const severe = alert.severity === "warning" || alert.severity === "critical";

  return (
    <Alert
      variant="destructive"
      className={cn(
        severe
          ? "border-amber-500/50 bg-amber-500/5 text-amber-100"
          : "border-sky-500/50 bg-sky-500/5 text-sky-100",
        className,
      )}
    >
      <TrendingDown className="h-4 w-4" />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>{alert.title}</span>
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
        <JargonText>{alert.body}</JargonText>
        <div className="mt-2 opacity-80 tabular-nums">
          Last {COVERAGE_TREND_WINDOW_DAYS}d {alert.recentPct ?? "—"}%
          {alert.priorPct != null ? ` · previous ${alert.priorPct}%` : ""}
          {alert.earlierPct != null ? ` · before that ${alert.earlierPct}%` : ""}
        </div>
      </AlertDescription>
    </Alert>
  );
}
