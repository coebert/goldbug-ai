import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PerformanceAnalyticsCard } from "@/components/performance-analytics-card";
import { IntendedVsExecutedCard } from "@/components/intended-vs-executed-card";
import { SectorExposureChart } from "@/components/sector-exposure-chart";


import { ExecutionQualityCard } from "@/components/execution-quality-card";
import { AlgoRegimeHistoryCard } from "@/components/algo-regime-history-card";
import { AlgoRegimeCalibrationCard } from "@/components/algo-regime-calibration-card";
import { AlgoRegimeBacktestCard } from "@/components/algo-regime-backtest-card";
import { BreakoutBacktestCard } from "@/components/breakout-backtest-card";
import { BreakoutOverlayCard } from "@/components/breakout-overlay-card";
import { AlgoRegimeRiskEnvelopeCard } from "@/components/algo-regime-risk-envelope-card";

export const Route = createFileRoute("/portfolio/$id/analytics")({
  head: () => ({
    meta: [
      { title: "Performance Analytics — Aegis" },
      { name: "description", content: "Equity curve, drawdown and PnL attribution across regime, sizing, exit and execution phases." },
      { property: "og:title", content: "Performance Analytics — Aegis" },
      { property: "og:description", content: "Equity curve, drawdown and PnL attribution across regime, sizing, exit and execution phases." },
    ],
  }),
  component: AnalyticsPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>Retry</Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function AnalyticsPage() {
  const { id } = Route.useParams();
  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl p-4 md:p-6 space-y-4">
        <Link
          to="/portfolio/$id"
          params={{ id }}
          className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3 w-3" /> Back to portfolio
        </Link>
        <h1 className="text-xl font-semibold">Performance analytics</h1>
        <PerformanceAnalyticsCard portfolioId={id} />
        <IntendedVsExecutedCard portfolioId={id} />
        <SectorExposureChart portfolioId={id} />


        <ExecutionQualityCard portfolioId={id} />
        <AlgoRegimeHistoryCard portfolioId={id} />
        <AlgoRegimeCalibrationCard portfolioId={id} />
        <AlgoRegimeRiskEnvelopeCard portfolioId={id} />
        <AlgoRegimeBacktestCard portfolioId={id} />
        <BreakoutBacktestCard portfolioId={id} />
        <BreakoutOverlayCard portfolioId={id} />

      </main>
    </div>
  );
}
