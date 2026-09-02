import { lazy, Suspense } from "react";
import { DecisionCard } from "@/components/portfolio-detail/decision-card";
import { OrderExplanationsBackfillCard } from "@/components/order-explanations-backfill-card";
import type { TradingStyle } from "@/lib/trading-style";

const TodaysDecisionSummaryCard = lazy(() =>
  import("@/components/todays-decision-summary-card").then((m) => ({
    default: m.TodaysDecisionSummaryCard,
  })),
);
const TradeAuditLogCard = lazy(() =>
  import("@/components/trade-audit-log-card").then((m) => ({ default: m.TradeAuditLogCard })),
);
const TradeErrorDashboardCard = lazy(() =>
  import("@/components/trade-error-dashboard-card").then((m) => ({
    default: m.TradeErrorDashboardCard,
  })),
);
const TradeOutcomePanelCard = lazy(() =>
  import("@/components/trade-outcome-panel-card").then((m) => ({
    default: m.TradeOutcomePanelCard,
  })),
);
const ConfidenceTimelineCard = lazy(() =>
  import("@/components/confidence-timeline-card").then((m) => ({
    default: m.ConfidenceTimelineCard,
  })),
);

export type DecisionRow = {
  id: string;
  run_date: string;
  briefing: string | null;
  rationale: string | null;
  portfolio_value: number | string | null;
  raw: unknown;
};

const CardFallback = <div className="h-40 rounded-xl border bg-card" aria-hidden />;

export function DecisionsSection({
  portfolioId,
  currency,
  tradingStyle,
  decisions,
}: {
  portfolioId: string;
  currency: string;
  tradingStyle: TradingStyle;
  decisions: DecisionRow[];
}) {
  return (
    <div className="space-y-4">
      <Suspense fallback={CardFallback}>
        <TodaysDecisionSummaryCard portfolioId={portfolioId} currency={currency} />
      </Suspense>
      <OrderExplanationsBackfillCard portfolioId={portfolioId} />

      {decisions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No AI decisions yet. Run one day or a backtest to see the AI's reasoning here.
        </p>
      )}
      {decisions.map((d) => (
        <DecisionCard
          key={d.id}
          decision={d}
          currency={currency}
          tradingStyle={tradingStyle}
        />
      ))}
    </div>
  );
}

export function ConfidenceSection({ decisions }: { decisions: DecisionRow[] }) {
  return (
    <Suspense fallback={CardFallback}>
      <ConfidenceTimelineCard decisions={decisions} />
    </Suspense>
  );
}

export function AuditSection({
  portfolioId,
  portfolioName,
  active,
}: {
  portfolioId: string;
  portfolioName: string;
  active: boolean;
}) {
  return (
    <Suspense fallback={CardFallback}>
      <TradeAuditLogCard portfolioId={portfolioId} portfolioName={portfolioName} active={active} />
    </Suspense>
  );
}

export function ErrorsSection({ portfolioId, active }: { portfolioId: string; active: boolean }) {
  return (
    <Suspense fallback={CardFallback}>
      <div className="space-y-4">
        <TradeOutcomePanelCard portfolioId={portfolioId} active={active} />
        <TradeErrorDashboardCard portfolioId={portfolioId} active={active} />
      </div>
    </Suspense>
  );
}
