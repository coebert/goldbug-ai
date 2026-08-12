import { Suspense, lazy } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdvancedSection } from "@/components/advanced-section";
import { Metric } from "@/components/portfolio-detail/metric";
import { PerformanceDashboardCard } from "@/components/performance-dashboard-card";
import { VanguardBenchmarkCard } from "@/components/vanguard-benchmark-card";
import { RelativeStrengthCard } from "@/components/relative-strength-card";
import { FrictionKpiCard } from "@/components/friction-kpi-card";
import { CoverageTrendCard } from "@/components/coverage-trend-card";
import { BatchingBacktestCard } from "@/components/batching-backtest-card";
import { CostScenarioBacktestCard } from "@/components/cost-scenario-backtest-card";
import { EquityChangeBreakdownCard } from "@/components/equity-change-breakdown-card";
import { DailyEquityChangesCard } from "@/components/daily-equity-changes-card";
import { TailHedgeCard } from "@/components/tail-hedge-card";
import { TailHedgeReportCard } from "@/components/tail-hedge-report-card";
import type { BacktestMetrics, TradeRow } from "@/lib/backtest-metrics";

const WalletAffordabilityCard = lazy(() =>
  import("@/components/wallet-affordability-card").then((m) => ({
    default: m.WalletAffordabilityCard,
  })),
);
const WalletHistoryCard = lazy(() =>
  import("@/components/wallet-history-card").then((m) => ({ default: m.WalletHistoryCard })),
);
const MultiCurrencyExposureCard = lazy(() =>
  import("@/components/multi-currency-exposure-card").then((m) => ({
    default: m.MultiCurrencyExposureCard,
  })),
);
const BacktestResultsCard = lazy(() =>
  import("@/components/backtest-results-card").then((m) => ({ default: m.BacktestResultsCard })),
);
const BacktestRunHistoryCard = lazy(() =>
  import("@/components/backtest-run-history-card").then((m) => ({
    default: m.BacktestRunHistoryCard,
  })),
);

type EquityRow = { snapshot_date: string; total_value: number; source?: string | null };

/**
 * The Overview tab's "Look deeper" stack: performance, value changes, cash,
 * crash protection and backtests. Presentational extraction from the
 * portfolio detail route — no data fetching or valuation logic lives here.
 */
export function OverviewLookDeeperSection({
  id,
  p,
  equity,
  trades,
  depositEvents,
  baselineStartingCash,
  advancedLevel,
  tab,
  lastBtMetrics,
  lastBtDays,
  backtestRunToken,
  ready,
}: {
  id: string;
  p: {
    currency?: string | null;
    risk_level?: string | null;
  } | null;
  equity: EquityRow[];
  trades: TradeRow[];
  depositEvents: Array<{ date: string; amount: number }>;
  baselineStartingCash: number;
  advancedLevel: boolean;
  tab: string;
  lastBtMetrics: BacktestMetrics | null;
  lastBtDays: number | null;
  backtestRunToken: number;
  ready: boolean;
}) {
  return (
      <div id="portfolio-look-deeper" className="mb-6 scroll-mt-32 space-y-3">
        <div>
          <h3 className="font-display text-base font-semibold tracking-tight">Look deeper</h3>
          <p className="text-xs text-muted-foreground">
            Optional detail. Nothing here needs your attention day to day.
          </p>
        </div>
        <AdvancedSection
          title="How this portfolio is performing"
          summary="Return, risk and how it compares with a simple index fund."
          defaultOpen={advancedLevel}
        >
      {p && (
        <div className="mb-4">
          <PerformanceDashboardCard
            startingCash={baselineStartingCash}
            currency={String(p.currency ?? "GBP")}
            equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
            trades={trades as unknown as import("@/lib/backtest-metrics").TradeRow[]}
            deposits={depositEvents}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <VanguardBenchmarkCard
            startingCash={baselineStartingCash}
            currency={String(p.currency ?? "GBP")}
            equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
            deposits={depositEvents}
            riskLevel={p.risk_level}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <RelativeStrengthCard
            portfolioId={id}
            currency={String(p.currency ?? "GBP")}
            enabled={ready}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <FrictionKpiCard
            portfolioId={id}
            currency={String(p.currency ?? "GBP")}
            enabled={ready}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <div id="coverage-trend" className="scroll-mt-24">
            <CoverageTrendCard />
          </div>
        </div>
      )}
      {p && (
        <div className="mb-4">
          <BatchingBacktestCard
            portfolioId={id}
            currency={String(p.currency ?? "GBP")}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <CostScenarioBacktestCard
            portfolioId={id}
            currency={String(p.currency ?? "GBP")}
          />
        </div>
      )}

        </AdvancedSection>
        <AdvancedSection
          title="What changed your value"
          summary="Day by day, separating trading gains from money you paid in."
          defaultOpen={advancedLevel}
        >
      {p && (
        <div className="mb-4">
          <EquityChangeBreakdownCard
            equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
            deposits={depositEvents}
            currency={String(p.currency ?? "GBP")}
          />
        </div>
      )}
      {p && (
        <div className="mb-4">
          <DailyEquityChangesCard
            equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
            deposits={depositEvents}
            currency={String(p.currency ?? "GBP")}
          />
        </div>
      )}
        </AdvancedSection>
        <AdvancedSection
          title="Cash, currencies and spending power"
          summary="What is left to spend, in which currency, and how that has moved."
          defaultOpen={advancedLevel}
        >
      {p && (
        <div className="mb-4">
          <Suspense
            fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}
          >
            <WalletAffordabilityCard portfolioId={id} active={tab === "overview"} />
          </Suspense>
        </div>
      )}
      {p && (
        <div className="mb-4">
          <Suspense
            fallback={<div className="h-48 rounded-xl border bg-card" aria-hidden />}
          >
            <MultiCurrencyExposureCard portfolioId={id} active={tab === "overview"} />
          </Suspense>
        </div>
      )}
      {p && (
        <div className="mb-4">
          <Suspense
            fallback={<div className="h-64 rounded-xl border bg-card" aria-hidden />}
          >
            <WalletHistoryCard portfolioId={id} active={tab === "overview"} />
          </Suspense>
        </div>
      )}
        </AdvancedSection>
        <AdvancedSection
          title="Crash protection"
          summary="The hedge that cushions the portfolio when markets fall sharply."
          defaultOpen={advancedLevel}
        >
      <div className="mb-6">
        <TailHedgeCard portfolioId={id} currency={String(p?.currency ?? "GBP")} />
      </div>
      <div className="mb-6">
        <TailHedgeReportCard portfolioId={id} currency={String(p?.currency ?? "GBP")} />
      </div>
        </AdvancedSection>
        <AdvancedSection
          title="Practice runs on past data"
          summary="Backtests — how this strategy would have done in the past."
          defaultOpen={advancedLevel}
        >
      {lastBtMetrics && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Backtest metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Total return"
                value={`${lastBtMetrics.totalReturnPct.toFixed(2)}%`}
                tone={lastBtMetrics.totalReturnPct >= 0 ? "up" : "down"}
              />
              <Metric
                label="Max drawdown"
                value={`${lastBtMetrics.maxDrawdownPct.toFixed(2)}%`}
                tone="down"
                hint={
                  lastBtMetrics.maxDrawdownCI
                    ? `95% CI ${lastBtMetrics.maxDrawdownCI.low.toFixed(2)}% … ${lastBtMetrics.maxDrawdownCI.high.toFixed(2)}%`
                    : lastBtMetrics.maxDrawdownPeakDate &&
                        lastBtMetrics.maxDrawdownTroughDate
                      ? `${lastBtMetrics.maxDrawdownPeakDate} → ${lastBtMetrics.maxDrawdownTroughDate}`
                      : undefined
                }
              />
              <Metric
                label="Sharpe (ann.)"
                value={lastBtMetrics.sharpe.toFixed(2)}
                tone={lastBtMetrics.sharpe >= 0 ? "up" : "down"}
                hint={
                  lastBtMetrics.sharpeCI
                    ? `95% CI ${lastBtMetrics.sharpeCI.low.toFixed(2)} … ${lastBtMetrics.sharpeCI.high.toFixed(2)}`
                    : undefined
                }
              />
              <Metric
                label="Win rate"
                value={
                  lastBtMetrics.winRatePct != null
                    ? `${lastBtMetrics.winRatePct.toFixed(0)}%`
                    : "—"
                }
                hint={`${lastBtMetrics.wins}W / ${lastBtMetrics.losses}L / ${lastBtMetrics.trades} trades`}
              />
              <Metric
                label="Volatility (ann.)"
                value={`${lastBtMetrics.volatilityPct.toFixed(2)}%`}
              />
              <Metric
                label="Best day"
                value={`${lastBtMetrics.bestDayPct.toFixed(2)}%`}
                tone="up"
              />
              <Metric
                label="Worst day"
                value={`${lastBtMetrics.worstDayPct.toFixed(2)}%`}
                tone="down"
              />
              <Metric
                label="Realized PnL"
                value={lastBtMetrics.grossRealizedPnl.toFixed(2)}
                tone={lastBtMetrics.grossRealizedPnl >= 0 ? "up" : "down"}
              />
            </div>
          </CardContent>
        </Card>
      )}
      {backtestRunToken > 0 && lastBtDays != null && (
        <Suspense
          fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}
        >
          <BacktestResultsCard
            portfolioId={id}
            days={lastBtDays}
            runToken={backtestRunToken}
            currency={p?.currency ?? "USD"}
          />
        </Suspense>
      )}
      <Suspense fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}>
        <BacktestRunHistoryCard portfolioId={id} portfolioRiskLevel={p?.risk_level ?? undefined} />
      </Suspense>
        </AdvancedSection>
      </div>
  );
}
