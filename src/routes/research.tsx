import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { FileText } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AdvancedSection } from "@/components/advanced-section";
import { useSessionEmail } from "@/lib/use-session-email";
import { RiskLevelMetricsCard } from "@/components/risk-level-metrics-card";

const ReclaimScanCard = lazy(() =>
  import("@/components/market/reclaim-scan-card").then((m) => ({ default: m.ReclaimScanCard })),
);
const SetupBacktestCard = lazy(() =>
  import("@/components/market/setup-backtest-card").then((m) => ({ default: m.SetupBacktestCard })),
);
const MacroLessonsCard = lazy(() =>
  import("@/components/macro-lessons-card").then((m) => ({ default: m.MacroLessonsCard })),
);
const ExecPostLessonsCard = lazy(() =>
  import("@/components/exec-post-lessons-card").then((m) => ({ default: m.ExecPostLessonsCard })),
);

export const Route = createFileRoute("/research")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Research — Aegis" },
      {
        name: "description",
        content:
          "Scanners, backtests and learned rules — test an idea before the AI trades it.",
      },
      { property: "og:title", content: "Research — Aegis" },
      {
        property: "og:description",
        content: "Scanners, backtests and the rules the AI learned from past markets.",
      },
    ],
  }),
  component: ResearchPage,
});

const fallback = (h: string) => (
  <div className={`${h} rounded-2xl border border-border bg-card/50`} aria-hidden="true" />
);

function ResearchPage() {
  const email = useSessionEmail();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <main className="mx-auto min-w-0 max-w-6xl px-4 py-5 sm:py-8 2xl:max-w-7xl">
        <header className="mb-5 min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Research</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            Scanners and backtests. Nothing here places a trade — it only tests ideas.
          </p>
        </header>

        <div className="mb-4">
          <Link
            to="/simulation-report"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted"
          >
            <FileText className="h-4 w-4 text-primary" aria-hidden /> Simulation report
          </Link>
        </div>

        <div className="space-y-3">
          <AdvancedSection
            title="Market scanner"
            summary="Shares matching the post-reclaim setup the AI learned, with a chart for each match."
            defaultOpen
          >
            <Suspense fallback={fallback("h-48")}>
              <ReclaimScanCard />
            </Suspense>
          </AdvancedSection>

          <AdvancedSection
            title="Setup backtest"
            summary="How often that setup actually paid, over the last few years."
            defaultOpen={false}
          >
            <Suspense fallback={fallback("h-64")}>
              <SetupBacktestCard />
            </Suspense>
          </AdvancedSection>

          <AdvancedSection
            title="Risk levels at a glance"
            summary="Risk, drawdown and diversification for each risk level, side by side."
            defaultOpen={false}
          >
            <RiskLevelMetricsCard />
          </AdvancedSection>

          <AdvancedSection
            title="What the AI learned from 20 years of news"
            summary="Two decades of drawdowns and the headlines behind them, turned into rules."
            defaultOpen={false}
          >
            <Suspense fallback={fallback("h-64")}>
              <MacroLessonsCard />
            </Suspense>
          </AdvancedSection>

          <AdvancedSection
            title="What the AI learned from CEO posts"
            summary="Past posts studied against the price path that followed."
            defaultOpen={false}
          >
            <Suspense fallback={fallback("h-64")}>
              <ExecPostLessonsCard />
            </Suspense>
          </AdvancedSection>
        </div>
      </main>
    </div>
  );
}
