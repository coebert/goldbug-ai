// Consolidated Risk tab for the portfolio detail page.
//
// Stage 3 of the redesign: safety limits, concentration, currency risk and
// stress scenarios used to be scattered across the Summary, Errors and
// Diagnostics tabs. They all answer the same question — "how much can this
// portfolio lose, and what stops it?" — so they now live in one place,
// grouped and lazily mounted. Presentation only: every card keeps its own
// data fetching, query keys and behaviour.

import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { PageSection } from "@/components/layout/page-shell";
import { ConcentrationAlertCard } from "@/components/concentration-alert-card";
import { ExecutionCalibrationCard } from "@/components/execution-calibration-card";
import { FxAuditCard } from "@/components/fx-audit-card";
import { FxCashAtRiskCard } from "@/components/fx-cash-at-risk-card";
import { RiskControlsCard } from "@/components/risk-controls-card";
import { RiskCurveComparisonCard } from "@/components/risk-curve-comparison-card";
import { StressPanelCard } from "@/components/stress-panel-card";
import { SwingModeToggle } from "@/components/swing-mode-toggle";

const FxHealthCard = lazy(() =>
  import("@/components/fx-health-card").then((m) => ({ default: m.FxHealthCard })),
);
const FxIntentsCard = lazy(() =>
  import("@/components/fx-intents-card").then((m) => ({ default: m.FxIntentsCard })),
);
const FxIntentPnlCard = lazy(() =>
  import("@/components/fx-intent-pnl-card").then((m) => ({ default: m.FxIntentPnlCard })),
);
const RiskSimulatorCard = lazy(() =>
  import("@/components/risk-simulator-card").then((m) => ({ default: m.RiskSimulatorCard })),
);
const ManualFxConvertCard = lazy(() =>
  import("@/components/manual-fx-convert-card").then((m) => ({ default: m.ManualFxConvertCard })),
);

function CardFallback() {
  return <div className="h-40 rounded-xl border bg-card" aria-hidden />;
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<CardFallback />}>{children}</Suspense>;
}

export type RiskSectionPortfolio = {
  id: string;
  name?: string | null;
  mode: string;
  currency: string;
  current_cash: number | null;
  cash_by_ccy?: unknown;
  fx_enabled?: boolean | null;
  fx_execution_mode?: string | null;
  risk_config: unknown;
};

export function RiskSection({
  id,
  p,
  totalValue,
  holdings,
  holdingsSeries,
  active,
  clampDialLevel,
}: {
  id: string;
  p: RiskSectionPortfolio;
  totalValue: number;
  holdings: Parameters<typeof ConcentrationAlertCard>[0]["holdings"];
  holdingsSeries: Parameters<typeof ConcentrationAlertCard>[0]["series"];
  active: boolean;
  clampDialLevel: (v: unknown) => number;
}) {
  const live = p.mode === "live_sim" || p.mode === "live_prod";
  const execConfig = p.risk_config as {
    execution_params?: Parameters<typeof ExecutionCalibrationCard>[0]["execParams"];
    execution_calibration?: Parameters<typeof ExecutionCalibrationCard>[0]["calibration"];
    risk_level?: number;
  } | null;

  return (
    <div className="space-y-8">
      <PageSection
        id="risk-limits"
        title="Safety limits"
        description="The rules that cap how much the AI can put at risk on any one day."
      >
        <div className="space-y-4">
          <SwingModeToggle
            portfolioId={id}
            riskConfig={p.risk_config}
            equity={totalValue}
            currency={p.currency}
          />
          <RiskControlsCard portfolioId={id} riskConfig={p.risk_config} baseCurrency={p.currency} />
          <RiskCurveComparisonCard
            portfolioId={id}
            currentLevel={clampDialLevel(execConfig?.risk_level)}
          />
          <ExecutionCalibrationCard
            portfolioId={id}
            execParams={execConfig?.execution_params ?? null}
            calibration={execConfig?.execution_calibration ?? null}
          />
        </div>
      </PageSection>

      <PageSection
        id="risk-concentration"
        title="Concentration"
        description="How much of the portfolio sits in a single position, sector or currency."
      >
        <ConcentrationAlertCard
          holdings={holdings}
          series={holdingsSeries}
          totalValue={totalValue}
          currency={p.currency}
          mode={p.mode}
        />
      </PageSection>

      <PageSection
        id="risk-currency"
        title="Currency risk"
        description="Open funding legs, their health, and what they have cost or earned."
      >
        <div className="space-y-4">
          <Lazy>
            <FxHealthCard portfolioId={id} active={active} />
          </Lazy>
          {live && (
            <>
              <FxAuditCard portfolioId={id} active={active} />
              <FxCashAtRiskCard portfolioId={id} />
            </>
          )}
          {p.fx_enabled === true && (
            <>
              <Lazy>
                <FxIntentsCard portfolioId={id} active={active} />
              </Lazy>
              <Lazy>
                <FxIntentPnlCard portfolioId={id} active={active} />
              </Lazy>
              <Lazy>
                <ManualFxConvertCard portfolio={p} />
              </Lazy>
            </>
          )}
          <Link
            to="/portfolio/$id/fx-risk"
            params={{ id }}
            className="inline-block text-xs text-primary hover:underline"
          >
            Open the FX risk dashboard — rate history, decision log, backtest &amp; stress test →
          </Link>
        </div>
      </PageSection>

      <PageSection
        id="risk-stress"
        title="Stress scenarios"
        description="What a market shock would do to this portfolio, and whether the guardrails would catch it."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <StressPanelCard portfolioId={id} currency={p.currency} />
          {p.fx_enabled === true && (
            <Lazy>
              <RiskSimulatorCard portfolioId={id} active={active} />
            </Lazy>
          )}
        </div>
      </PageSection>
    </div>
  );
}
