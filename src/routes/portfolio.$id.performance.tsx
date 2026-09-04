import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { StrategyPerformanceCard } from "@/components/strategy-performance-card";

const BacktestVsRealCard = lazy(() =>
  import("@/components/backtest-vs-real-card").then((m) => ({ default: m.BacktestVsRealCard })),
);

const TITLE = "Strategy performance — Aegis";
const DESC =
  "Annualised return, Sharpe and drawdowns for the live account, next to the backtest versus real P&L comparison.";

export const Route = createFileRoute("/portfolio/$id/performance")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PerformancePage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function PerformancePage() {
  const { id } = Route.useParams();
  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <PortfolioTabs id={id} />
        <Link
          to="/portfolio/$id/"
          params={{ id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Back to portfolio
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Strategy performance</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            How the strategy has actually done on real money: the return per year it is running at,
            how much risk it took to get there, and the worst stretches along the way. Deposits and
            withdrawals are netted out first, so nothing here is your own money arriving. Below,
            the same period measured against the saved backtest.
          </p>
        </div>
        <StrategyPerformanceCard portfolioId={id} />
        <Suspense
          fallback={<div className="h-40 animate-pulse rounded-lg border bg-muted/30" />}
        >
          <BacktestVsRealCard portfolioId={id} currency="GBP" />
        </Suspense>
      </main>
    </div>
  );
}
