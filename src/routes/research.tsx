import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { FileText } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell, PageSection } from "@/components/layout/page-shell";
import { CardShell } from "@/components/layout/card-shell";
import { SectionIndex } from "@/components/nav/section-index";

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
  <div className={`${h} skeleton-shimmer w-full`} aria-hidden="true" />
);

const RESEARCH_SECTIONS = [
  { id: "scanners", label: "Scanners" },
  { id: "backtests", label: "Backtests" },
  { id: "learned", label: "Learned rules" },
] as const;

function ResearchPage() {
  const email = useSessionEmail();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <PageShell
        title="Research"
        purpose="Scanners and backtests. Nothing here places a trade — it only tests ideas."
        actions={
          <Link
            to="/simulation-report"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
          >
            <FileText className="h-4 w-4 text-primary" aria-hidden /> Simulation report
          </Link>
        }
      >
        <SectionIndex items={RESEARCH_SECTIONS} />

        <PageSection
          id="scanners"
          title="Scanners"
          description="What matches the AI's setups in today's market."
        >
          <CardShell
            anchor="reclaim-scan"
            title="Market scanner"
            subtitle="Shares matching the post-reclaim setup the AI learned, with a chart for each match."
            level={1}
          >
            <Suspense fallback={fallback("h-48")}>
              <ReclaimScanCard />
            </Suspense>
          </CardShell>
        </PageSection>

        <PageSection
          id="backtests"
          title="Backtests"
          description="Did the idea actually pay, after costs?"
        >
          <div className="space-y-4">
            <CardShell
              anchor="setup-backtest"
              title="Setup backtest"
              subtitle="How often that setup actually paid, over the last few years."
              level={2}
            >
              <Suspense fallback={fallback("h-64")}>
                <SetupBacktestCard />
              </Suspense>
            </CardShell>

            <CardShell
              anchor="risk-levels"
              title="Risk levels at a glance"
              subtitle="Risk, drawdown and diversification for each risk level, side by side."
              level={2}
            >
              <RiskLevelMetricsCard />
            </CardShell>
          </div>
        </PageSection>

        <PageSection
          id="learned"
          title="Learned rules"
          description="What past markets taught the AI, and how it applies them now."
        >
          <div className="space-y-4">
            <CardShell
              anchor="macro-lessons"
              title="What the AI learned from 20 years of news"
              subtitle="Two decades of drawdowns and the headlines behind them, turned into rules."
              level={3}
            >
              <Suspense fallback={fallback("h-64")}>
                <MacroLessonsCard />
              </Suspense>
            </CardShell>

            <CardShell
              anchor="exec-post-lessons"
              title="What the AI learned from CEO posts"
              subtitle="Past posts studied against the price path that followed."
              level={3}
            >
              <Suspense fallback={fallback("h-64")}>
                <ExecPostLessonsCard />
              </Suspense>
            </CardShell>
          </div>
        </PageSection>
      </PageShell>
    </div>
  );
}

