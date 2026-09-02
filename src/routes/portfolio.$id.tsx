import { ChartFrame } from "@/components/chart-frame";
import { SectionIndex } from "@/components/nav/section-index";
import { OverviewLookDeeperSection } from "@/components/portfolio-detail/sections/overview-look-deeper";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { RiskSection, type RiskSectionPortfolio } from "@/components/portfolio-detail/sections/risk-section";
import { SymbolTicker } from "@/components/symbol-ticker";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getPortfolio,
  runOneDay,
  runBacktest,
  resetPortfolio,
  getBenchmarkSeries,
} from "@/lib/trading.functions";
import { explainDecisionOrder, type ExplainOrderInput } from "@/lib/order-explanations.functions";
import { reconcilePortfolio } from "@/lib/live.functions";
import { getCurrentRegime } from "@/lib/regime.functions";
import { OrderConfidenceBadge } from "@/components/order-confidence-badge";
import type { ConfidenceRegime } from "@/lib/order-confidence";
import { JargonText } from "@/components/jargon-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppHeader } from "@/components/app-header";
import { useIncludeDeposits } from "@/lib/use-include-deposits";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Line,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Slider } from "@/components/ui/slider";
import {
  ArrowLeft,
  PlayCircle,
  RotateCcw,
  Zap,
  ChevronDown,
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Newspaper,
  Activity,
  CalendarClock,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  FileText,
  BarChart3,
  Settings2,
  Sparkles,
  Pencil,
  Banknote,
  AlertTriangle,
} from "lucide-react";
import { RenamePortfolioDialog } from "@/components/rename-portfolio-dialog";
import { AddSimFundsDialog } from "@/components/add-sim-funds-dialog";
import { SimFundHistoryCard } from "@/components/sim-fund-history-card";
// Heavy tab bodies are code-split via React.lazy to keep the main
// portfolio route chunk lean on mobile.
const TradeAuditLogCard = lazy(() =>
  import("@/components/trade-audit-log-card").then((m) => ({ default: m.TradeAuditLogCard })),
);
const CorporateActionsCard = lazy(() =>
  import("@/components/corporate-actions-card").then((m) => ({
    default: m.CorporateActionsCard,
  })),
);

const ConfidenceTimelineCard = lazy(() =>
  import("@/components/confidence-timeline-card").then((m) => ({
    default: m.ConfidenceTimelineCard,
  })),
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
const TodaysDecisionSummaryCard = lazy(() =>
  import("@/components/todays-decision-summary-card").then((m) => ({
    default: m.TodaysDecisionSummaryCard,
  })),
);

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

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { DecisionCard } from "@/components/portfolio-detail/decision-card";
import { OrderExplanationsBackfillCard } from "@/components/order-explanations-backfill-card";

import { Metric } from "@/components/portfolio-detail/metric";
import { formatMetricValue } from "@/components/portfolio-detail/format";

import { RiskControlsCard } from "@/components/risk-controls-card";
import { SwingModeToggle } from "@/components/swing-mode-toggle";
import { TradingModeBadge } from "@/components/trading-mode-badge";
import { RiskCurveComparisonCard } from "@/components/risk-curve-comparison-card";
import { clampDialLevel } from "@/lib/risk-aggressiveness";
import { RiskHaltBanner } from "@/components/risk-halt-banner";
import { ConcentrationAlertCard } from "@/components/concentration-alert-card";
import { InsiderDealingsCard } from "@/components/insider-dealings-card";
import { PolicyDecisionExplainCard } from "@/components/policy-decision-explain-card";
import { PolicyRegimeTimelineCard } from "@/components/policy-regime-timeline-card";
import { SignalWeightHistoryCard } from "@/components/signal-weight-history-card";
import { InsiderEventStudyCard } from "@/components/insider-event-study-card";
import { InsiderNudgeReplayCard } from "@/components/insider-nudge-replay-card";
import { PolicyNudgeReplayCard } from "@/components/policy-nudge-replay-card";
import { PolicyNudgeSweepCard } from "@/components/policy-nudge-sweep-card";

import { PrecheckCashAlertBanner } from "@/components/precheck-cash-alert-banner";
import { CostSyncAlertBanner } from "@/components/cost-sync-alert-banner";
import { CoverageTrendAlertBanner } from "@/components/coverage-trend-alert-banner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { AdvancedSection } from "@/components/advanced-section";
import { ExperienceLevelToggle } from "@/components/experience-level-toggle";
import { useIsAdvanced } from "@/lib/use-experience-level";

import { ExecutionCalibrationCard } from "@/components/execution-calibration-card";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { ModeBadge } from "@/components/mode-badge";
import { LiveToggle } from "@/components/live-toggle";
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from "@/components/ui/tooltip";
import { RegimePanel } from "@/components/regime-panel";
import { FearIndexCard } from "@/components/fear-index-card";
import { LearningPanel } from "@/components/learning-panel";
import { LiveTradingCard } from "@/components/live-trading-card";
import { SignalDecayCard } from "@/components/signal-decay-card";
import { StressPanelCard } from "@/components/stress-panel-card";
import { LearningDiagnosticsCard } from "@/components/learning-diagnostics-card";
import { ShadowVariantCard } from "@/components/shadow-variant-card";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChartPreset } from "@/lib/chart-axis";

import {
  shortChartDate,
  formatDateTick,
  formatValueTick,
  formatTooltipValue,
  formatSignedPct,
  formatSignedNum,
  formatMetric,
  heroMetricRows,
  COMPARE_METRIC_ROWS,
  yAxisLabel,
  compareGridHeader,
  tooltipModeChip,
} from "@/lib/portfolio-performance-format";
import { formatMoney, formatMoneyAmount } from "@/lib/format-money";

import { CorrelationHeatmapCard } from "@/components/correlation-heatmap-card";
import { LiveHoldingsCard, type HoldingSeriesInfo } from "@/components/live-holdings-card";
import { TailHedgeCard } from "@/components/tail-hedge-card";
import { TailHedgeReportCard } from "@/components/tail-hedge-report-card";
import { CashReconciliationLogCard } from "@/components/cash-reconciliation-log-card";
import { ReconcileFillsCard } from "@/components/reconcile-fills-card";
import { PriceUnitAuditCard } from "@/components/price-unit-audit-card";
import { ValuationConsistencyAlert } from "@/components/valuation-consistency-alert";
import { InstrumentCcyAlert } from "@/components/instrument-ccy-alert";
import { CurrencyDiagnosticsBanner } from "@/components/currency-diagnostics-banner";
import { FxAuditCard } from "@/components/fx-audit-card";
import { FxCashAtRiskCard } from "@/components/fx-cash-at-risk-card";

import { FxTradeDrilldownCard } from "@/components/fx-trade-drilldown-card";

import { CommodityExposureCard } from "@/components/commodity-exposure-card";
import { InvestableUniverseCard } from "@/components/investable-universe-card";
import { CommodityBacktestCard } from "@/components/commodity-backtest-card";
import { CryptoBacktestCard } from "@/components/crypto-backtest-card";

import { CommodityLiquiditySimulatorCard } from "@/components/commodity-liquidity-simulator-card";
import { PerformanceDashboardCard } from "@/components/performance-dashboard-card";
import { VanguardBenchmarkCard } from "@/components/vanguard-benchmark-card";
import { RelativeStrengthCard } from "@/components/relative-strength-card";
import { FrictionKpiCard } from "@/components/friction-kpi-card";
import { CoverageTrendCard } from "@/components/coverage-trend-card";
import { BatchingBacktestCard } from "@/components/batching-backtest-card";
import { CostScenarioBacktestCard } from "@/components/cost-scenario-backtest-card";

import { EquityChangeBreakdownCard } from "@/components/equity-change-breakdown-card";
import { DailyEquityChangesCard } from "@/components/daily-equity-changes-card";
import { capitalAt, EquityPctChart } from "@/components/equity-pct-chart";
const EquityCompositionCard = lazy(() =>
  import("@/components/equity-composition-card").then((m) => ({
    default: m.EquityCompositionCard,
  })),
);

import { getHoldingsHistory } from "@/lib/holdings-history.functions";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";
const BacktestResultsCard = lazy(() =>
  import("@/components/backtest-results-card").then((m) => ({ default: m.BacktestResultsCard })),
);
const BacktestRunHistoryCard = lazy(() =>
  import("@/components/backtest-run-history-card").then((m) => ({
    default: m.BacktestRunHistoryCard,
  })),
);
import { saveRun as saveBacktestRun } from "@/lib/backtest-run-save";

import { getBacktestSeries } from "@/lib/backtest-series.functions";

import { EventOverlay, EventOverlayControls } from "@/components/event-overlay";
import { eventsInRange, eventColor } from "@/lib/global-events";
import { Explain, ExplainIcon } from "@/components/explain";
import type { TermId } from "@/lib/glossary";
import { formatUk, ukZoneAbbr } from "@/lib/uk-time";
import {
  AXIS_LINE,
  AXIS_LINE_STROKE,
  AXIS_TICK,
  CHART_NEUTRAL_SERIES,
  GRID_PROPS,
  LEGEND_PROPS,
  OKABE_ITO,
  REFERENCE_LINE,
  TICK_LINE,
} from "@/lib/chart-palette";
import { qk } from "@/lib/query-keys";

type PortfolioTab =
  | "overview"
  | "trades"
  | "decisions"
  | "audit"
  | "errors"
  | "confidence"
  | "risk"
  | "diagnostics"
  | "reports";
const PORTFOLIO_TABS: PortfolioTab[] = [
  "overview",
  "trades",
  "decisions",
  "audit",
  "errors",
  "confidence",
  "risk",
  "diagnostics",
  "reports",
];

export const Route = createFileRoute("/portfolio/$id")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { tab?: PortfolioTab } => {
    const t = String(search.tab ?? "overview") as PortfolioTab;
    return { tab: PORTFOLIO_TABS.includes(t) ? t : "overview" };
  },
  head: ({ params }) => ({
    meta: [
      { title: `Portfolio ${params.id.slice(0, 6)} — Aegis` },
      { name: "description", content: "AI paper trading portfolio dashboard." },
    ],
  }),
  component: PortfolioPage,
});

const SIMPLE_TABS: PortfolioTab[] = ["overview", "trades", "decisions", "risk"];

const PORTFOLIO_SECTIONS = [
  { id: "equity", label: "Equity" },
  { id: "composition", label: "Composition" },
  { id: "holdings", label: "Holdings" },
  { id: "actions", label: "Actions" },
  { id: "portfolio-look-deeper", label: "Look deeper" },
] as const;

function PortfolioPage() {
  const { id } = Route.useParams();
  const { tab: searchTab } = Route.useSearch();
  const rawTab: PortfolioTab = searchTab ?? "overview";
  const advancedLevel = useIsAdvanced();
  // In Simple mode the expert tabs aren't rendered, so a deep link to one
  // would leave the tab strip with no active trigger — fall back to Summary.
  const tab: PortfolioTab =
    advancedLevel || SIMPLE_TABS.includes(rawTab) ? rawTab : "overview";
  const navigate = useNavigate();
  const setTab = (next: PortfolioTab) =>
    navigate({ to: "/portfolio/$id", params: { id }, search: { tab: next }, replace: true });

  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tradeSort, setTradeSort] = useState<{
    key: "date" | "symbol" | "side" | "qty" | "price" | "value";
    dir: "asc" | "desc";
  }>({ key: "date", dir: "desc" });
  const [showAdvancedDiag, setShowAdvancedDiag] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const isMobile = useIsMobile();
  const chartPreset = useChartPreset();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setReady(true);
      setEmail(data.session?.user.email ?? null);
      if (!data.session) navigate({ to: "/auth" });
    });
  }, [navigate]);

  const get = useServerFn(getPortfolio);
  const q = useQuery({
    queryKey: qk.portfolio.detail(id),
    queryFn: () => get({ data: { id } }),
    enabled: ready,
  });

  // Auto-refresh live portfolios from the broker while the user has the page
  // open. Two layers keep the tile in sync with Saxo without waiting for the
  // nightly cron:
  //   1. Realtime: subscribe to live_orders + live_fills for this portfolio.
  //      Any INSERT/UPDATE triggers an immediate reconcile so a broker fill
  //      appears within ~1s of hitting the DB, and starts a "hot" window.
  //   2. Adaptive polling: while hot (recent order activity) reconcile every
  //      30s; otherwise fall back to a 5-minute pulse. This catches broker-
  //      side fills that arrive without a Lovable-issued order webhook.
  const reconcileFn = useServerFn(reconcilePortfolio);
  const mode = q.data?.portfolio?.mode;
  const isLiveMode = mode === "live_prod" || mode === "live_sim";
  useEffect(() => {
    if (!ready || !isLiveMode) return;
    let cancelled = false;
    let hotUntil = 0;
    let timer: number | null = null;

    const runReconcile = async (reason: string) => {
      try {
        await reconcileFn({ data: { portfolioId: id } });
        if (cancelled) return;
        qc.invalidateQueries({ queryKey: qk.portfolio.detail(id) });
        qc.invalidateQueries({ queryKey: ["holdings-history", id] });
        qc.invalidateQueries({ queryKey: ["live-orders", id] });
        qc.invalidateQueries({ queryKey: qk.trades.forPortfolio(id) });
      } catch (e) {
        console.warn(`auto broker reconcile failed (${reason})`, e);
      }
    };

    const schedule = () => {
      if (cancelled) return;
      const hot = Date.now() < hotUntil;
      const delay = hot ? 30_000 : 5 * 60_000;
      timer = window.setTimeout(async () => {
        await runReconcile(hot ? "hot-pulse" : "idle-pulse");
        schedule();
      }, delay);
    };

    const goHot = (reason: string) => {
      // Keep pulsing fast for 5 minutes after the last order/fill event so
      // partial fills, cancellations, and settlement side-effects all land.
      hotUntil = Date.now() + 5 * 60_000;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      runReconcile(reason).then(schedule);
    };

    // Initial reconcile + baseline schedule.
    runReconcile("mount").then(schedule);

    const channel = supabase
      .channel(`portfolio-live-${id}`)
      .on(
        "postgres_changes" as never,
        { event: "*", schema: "public", table: "live_orders", filter: `portfolio_id=eq.${id}` },
        (payload: { eventType: string }) => goHot(`live_orders:${payload.eventType}`),
      )
      .on(
        "postgres_changes" as never,
        { event: "*", schema: "public", table: "live_fills", filter: `portfolio_id=eq.${id}` },
        (payload: { eventType: string }) => goHot(`live_fills:${payload.eventType}`),
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isLiveMode, id]);

  const getHistory = useServerFn(getHoldingsHistory);
  const holdingsHistoryQ = useQuery({
    queryKey: ["holdings-history", id],
    queryFn: () => getHistory({ data: { portfolioId: id } }),
    enabled: ready,
    refetchInterval: 60 * 60 * 1000,
  });

  const qc = useQueryClient();
  const runDayFn = useServerFn(runOneDay);
  const runBtFn = useServerFn(runBacktest);
  const getBtSeriesFn = useServerFn(getBacktestSeries);

  const resetFn = useServerFn(resetPortfolio);
  const [days, setDays] = useState(7);
  const [eventsOn, setEventsOn] = useState(true);
  const [eventSev, setEventSev] = useState<1 | 2 | 3>(2);
  const [benchmark, setBenchmark] = useState<string>("SPY");
  const [compareMode, setCompareMode] = useState<"raw" | "pct">(() => {
    if (typeof window === "undefined") return "raw";
    const v = window.localStorage.getItem("aegis.compareMode");
    return v === "pct" ? "pct" : "raw";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.compareMode", compareMode);
    }
  }, [compareMode]);
  const [chartContrast, setChartContrast] = useState<"standard" | "high" | "light" | "cb">(() => {
    if (typeof window === "undefined") return "standard";
    const v = window.localStorage.getItem("aegis.chartContrast");
    return v === "high" || v === "light" || v === "cb" ? v : "standard";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.chartContrast", chartContrast);
    }
  }, [chartContrast]);
  const [riskFreeRate, setRiskFreeRate] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem("aegis.riskFreeRate"));
    return Number.isFinite(v) ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.riskFreeRate", String(riskFreeRate));
    }
  }, [riskFreeRate]);
  const chartTheme = useMemo(() => {
    if (chartContrast === "high") {
      return {
        equity: "#7dfcff",
        equityFillTop: 0.55,
        equityFillBottom: 0.05,
        benchmark: "#ffd257",
        drawdown: "#ff6b6b",
        peak: "#f8fafc",
        gridOpacity: 0.6,
        axis: "#f8fafc",
        axisText: "#f8fafc",
        strokeWidth: 3,
        surface: "transparent",
      } as const;
    }
    if (chartContrast === "light") {
      return {
        equity: "#0e7490",
        equityFillTop: 0.35,
        equityFillBottom: 0,
        benchmark: "#b45309",
        drawdown: "#b91c1c",
        peak: "#334155",
        gridOpacity: 0.35,
        axis: "#334155",
        axisText: "#0f172a",
        strokeWidth: 2.5,
        surface: "#f8fafc",
      } as const;
    }
    if (chartContrast === "cb") {
      // Okabe–Ito palette: distinguishable across deuteranopia, protanopia, tritanopia.
      return {
        equity: OKABE_ITO.skyBlue,
        equityFillTop: 0.5,
        equityFillBottom: 0.05,
        benchmark: OKABE_ITO.orange,
        drawdown: OKABE_ITO.vermillion,
        peak: "#E8E8E8",
        gridOpacity: 0.55,
        axis: "#CFCFCF",
        axisText: "#F1F1F1",
        strokeWidth: 3,
        surface: "transparent",
      } as const;
    }
    return {
      equity: "#22d3ee",
      equityFillTop: 0.35,
      equityFillBottom: 0,
      benchmark: "#f59e0b",
      drawdown: "var(--destructive)",
      peak: CHART_NEUTRAL_SERIES,
      gridOpacity: 0.35,
      axis: AXIS_LINE_STROKE,
      axisText: "var(--foreground)",
      strokeWidth: 2.5,
      surface: "transparent",
    } as const;
  }, [chartContrast]);

  const runDay = useMutation({
    mutationFn: () => runDayFn({ data: { portfolio_id: id } }),
    onSuccess: (r) => {
      const rejected = (r.executed ?? []).filter((e) => e.rejected).length;
      toast.success(
        `AI ran. ${r.executedCount} filled${rejected ? `, ${rejected} rejected` : ""}. Showing decision trail…`,
      );
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(id) });
      setTab("decisions");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [lastBtMetrics, setLastBtMetrics] = useState<
    import("@/lib/backtest-metrics").BacktestMetrics | null
  >(null);
  const [backtestRunToken, setBacktestRunToken] = useState(0);
  const [lastBtDays, setLastBtDays] = useState<number | null>(null);
  const runBt = useMutation({
    mutationFn: () => runBtFn({ data: { portfolio_id: id, days } }),
    onSuccess: async (r) => {
      const m = r.metrics;
      setLastBtMetrics(m ?? null);
      setLastBtDays(days);
      setBacktestRunToken((n) => n + 1);
      if (m) {
        const winPart = m.winRatePct != null ? ` · Win ${m.winRatePct.toFixed(0)}%` : "";
        toast.success(
          `Backtest done. Return ${m.totalReturnPct.toFixed(2)}% · MDD ${m.maxDrawdownPct.toFixed(2)}% · Sharpe ${m.sharpe.toFixed(2)}${winPart}`,
        );
        // Fetch the equity series for this window so the run-history overlay
        // charts have per-run points to draw. We snapshot into localStorage
        // because there is no per-run entity server-side — each backtest
        // recomputes off the shared equity_snapshots table.
        let equity: { snapshot_date: string; total_value: number }[] | undefined;
        try {
          const series = await getBtSeriesFn({ data: { portfolio_id: id, days } });
          equity = series.equity ?? undefined;
        } catch {
          // Overlay is a nice-to-have; falling back to metrics-only is fine.
        }
        saveBacktestRun({
          ranAt: new Date().toISOString(),
          portfolioId: id,
          riskLevel: (q.data?.portfolio?.risk_level as string | undefined) ?? "unknown",
          days,
          metrics: m,
          equity,
        }).catch((err) => {
          console.error("Failed to persist backtest run", err);
        });
      } else {
        toast.success(`Backtest done. Final value ~ ${r.finalValue.toFixed(2)}`);
      }
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const reset = useMutation({
    mutationFn: () => resetFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Portfolio reset");
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(id) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const equity = q.data?.equity ?? [];
  const equityData = useMemo(() => {
    let peak = -Infinity;
    return equity.map((e) => {
      const value = Number(e.total_value);
      peak = Math.max(peak, value);
      const drawdown = peak > 0 ? ((value - peak) / peak) * 100 : 0;
      return {
        date: e.snapshot_date as string,
        value,
        peak,
        drawdown, // negative or zero
        underwater: value < peak ? value : null, // for area shading
      };
    });
  }, [equity]);

  const benchFn = useServerFn(getBenchmarkSeries);
  const fromDate = equityData[0]?.date;
  const toDate = equityData[equityData.length - 1]?.date;
  const benchQ = useQuery({
    queryKey: ["benchmark", benchmark, fromDate, toDate],
    queryFn: () => benchFn({ data: { symbol: benchmark, from: fromDate!, to: toDate! } }),
    enabled: benchmark !== "none" && !!fromDate && !!toDate && equityData.length >= 2,
    staleTime: 5 * 60 * 1000,
  });

  const startingCashForChart = Number(q.data?.portfolio?.starting_cash ?? 0);
  const chartData = useMemo(() => {
    if (benchmark === "none" || !benchQ.data?.series?.length) return equityData;
    const bmap = new Map(benchQ.data.series.map((r) => [r.date, r.close]));
    // Find first close on/before the first equity date to normalise
    const dates = [...bmap.keys()].sort();
    let base: number | null = null;
    for (const d of dates) {
      if (d <= equityData[0].date) base = bmap.get(d)!;
      else break;
    }
    if (base == null) base = bmap.get(dates[0])!;
    let lastBench: number | null = base;
    return equityData.map((row) => {
      // Latest close on/before this equity date
      for (const d of dates) {
        if (d <= row.date) lastBench = bmap.get(d)!;
        else break;
      }
      const benchmark_value =
        lastBench != null && base != null ? startingCashForChart * (lastBench / base) : null;
      return { ...row, benchmark: benchmark_value };
    });
  }, [equityData, benchQ.data, benchmark, startingCashForChart]);

  const [includeDeposits, setIncludeDeposits] = useIncludeDeposits();

  // starting_cash minus any deposits already absorbed into it, so passive
  // benchmarks don't double-count the same top-up.
  const baselineStartingCash = useMemo(() => {
    const v = Number(q.data?.baselineStartingCash);
    return Number.isFinite(v) ? v : Number(q.data?.portfolio?.starting_cash ?? 0);
  }, [q.data?.baselineStartingCash, q.data?.portfolio?.starting_cash]);

  const depositEvents = useMemo(
    () => (q.data?.deposits ?? []) as Array<{ date: string; amount: number }>,
    [q.data?.deposits],
  );

  /**
   * Invested capital on a given date, using exactly the same rule as the
   * equity-% chart and every equity tile: baseline pot + deposits on or before
   * that date. With `includeDeposits` on, the user has asked to see the raw
   * curve, so the base stays at the full contributed pot.
   */
  const baseAt = useCallback(
    (date: string) =>
      includeDeposits ? startingCashForChart : capitalAt(baselineStartingCash, depositEvents, date),
    [includeDeposits, startingCashForChart, baselineStartingCash, depositEvents],
  );

  const displayChartData = useMemo(() => {
    if (compareMode === "raw") return chartData;
    return chartData.map((row) => {
      const r = row as typeof row & { benchmark?: number | null };
      const base = baseAt(row.date);
      if (!(base > 0)) return row;
      return {
        ...row,
        value: ((row.value - base) / base) * 100,
        peak: ((row.peak - base) / base) * 100,
        drawdown: row.drawdown,
        benchmark:
          r.benchmark != null ? ((r.benchmark - base) / base) * 100 : (r.benchmark ?? null),
      };
    });
  }, [chartData, compareMode, baseAt]);

  const perfMetrics = useMemo(() => {
    const rows = chartData.filter((r) => Number.isFinite(r.value));
    if (rows.length < 2) return null;
    const portVals = rows.map((r) => r.value);
    const benchVals = rows.map((r) => (r as { benchmark?: number | null }).benchmark ?? null);
    const hasBench =
      benchmark !== "none" && benchVals.every((v) => v != null && Number.isFinite(v));

    const dailyReturns = (vals: number[]) => {
      const out: number[] = [];
      for (let i = 1; i < vals.length; i++) {
        const prev = vals[i - 1];
        if (prev > 0) out.push(vals[i] / prev - 1);
      }
      return out;
    };
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const stdev = (xs: number[]) => {
      if (xs.length < 2) return 0;
      const m = mean(xs);
      const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
      return Math.sqrt(v);
    };
    const maxDD = (vals: number[]) => {
      let peak = -Infinity;
      let worst = 0;
      for (const v of vals) {
        peak = Math.max(peak, v);
        if (peak > 0) worst = Math.min(worst, (v - peak) / peak);
      }
      return worst * 100; // negative %
    };
    const compute = (vals: number[]) => {
      const rets = dailyReturns(vals);
      const totalReturn = vals[0] > 0 ? (vals[vals.length - 1] / vals[0] - 1) * 100 : 0;
      const years = Math.max(rets.length / 252, 1 / 252);
      const growth = vals[0] > 0 ? vals[vals.length - 1] / vals[0] : 1;
      const annReturn = (Math.pow(growth, 1 / years) - 1) * 100;
      const annVol = stdev(rets) * Math.sqrt(252) * 100;
      return { totalReturn, annReturn, annVol, maxDrawdown: maxDD(vals), rets };
    };
    const port = compute(portVals);
    const bench = hasBench ? compute(benchVals as number[]) : null;

    let correlation: number | null = null;
    if (bench) {
      const n = Math.min(port.rets.length, bench.rets.length);
      if (n >= 2) {
        const a = port.rets.slice(-n);
        const b = bench.rets.slice(-n);
        const ma = mean(a);
        const mb = mean(b);
        let num = 0;
        let da = 0;
        let db = 0;
        for (let i = 0; i < n; i++) {
          num += (a[i] - ma) * (b[i] - mb);
          da += (a[i] - ma) ** 2;
          db += (b[i] - mb) ** 2;
        }
        const denom = Math.sqrt(da * db);
        correlation = denom > 0 ? num / denom : null;
      }
    }
    return { port, bench, correlation };
  }, [chartData, benchmark]);

  const p = q.data?.portfolio;
  const holdings = q.data?.holdings ?? [];
  const trades = q.data?.trades ?? [];
  const decisions = q.data?.decisions ?? [];

  const holdingsSeries = useMemo(() => {
    const map: Record<string, HoldingSeriesInfo> = {};
    for (const h of holdingsHistoryQ.data ?? []) {
      map[h.symbol] = {
        closes: h.closes,
        hourly: h.hourly,
        hourlyAt: h.hourlyAt,
        hourlyStale: h.hourlyStale,

        currentPrice: h.currentPrice,
        pctChangeSincePurchase: h.pctChangeSincePurchase,
        valueChangeSincePurchase: h.valueChangeSincePurchase,
        opened_at: h.opened_at,
      };
    }
    return map;
  }, [holdingsHistoryQ.data]);

  // Single authoritative source of the three headline numbers. When an
  // equity snapshot exists it wins (both `total_value` and `cash` come from
  // the FX/GBX-normalised snapshot, so `invested = total_value − cash` cannot
  // disagree with the equity tile). The fallback path is only used when the
  // portfolio has no snapshots yet (first tick, brand-new account).
  const latestSnapshot = equity.length ? equity[equity.length - 1] : null;
  const {
    totalValue,
    cash: cashAuthoritative,
    invested: holdingsValue,
  } = useMemo(
    () =>
      derivePortfolioMetrics({
        latestSnapshot,
        currentCash: p?.current_cash ?? 0,
        holdings,
      }),
    [latestSnapshot, p?.current_cash, holdings],
  );
  const startingCash = Number(p?.starting_cash ?? 0);
  const pnl = totalValue - startingCash;
  const pnlPct = startingCash > 0 ? (pnl / startingCash) * 100 : 0;

  const sortedTrades = useMemo(() => {
    const arr = [...trades];
    const dir = tradeSort.dir === "asc" ? 1 : -1;
    const val = (t: (typeof trades)[number]) => {
      switch (tradeSort.key) {
        case "date":
          return `${t.trade_date} ${t.executed_at ?? ""}`;
        case "symbol":
          return t.symbol;
        case "side":
          return t.side;
        case "qty":
          return Number(t.quantity);
        case "price":
          return Number(t.price);
        case "value":
          return Number(t.value);
      }
    };
    arr.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
    return arr;
  }, [trades, tradeSort]);

  const underfunded = useMemo(() => {
    const latest = decisions[0] as { raw?: unknown } | undefined;
    if (!latest) return null;
    const raw = (latest.raw ?? {}) as {
      guardrails?: {
        affordability?: {
          per_symbol_budget?: number;
          min_trade_value?: number;
          universe_total?: number;
          candidates_kept?: number;
          notes?: string[];
        };
      };
    };
    const a = raw.guardrails?.affordability;
    if (!a) return null;
    if ((a.candidates_kept ?? 0) > 0) return null;
    if ((a.universe_total ?? 0) === 0) return null;
    return {
      budget: a.per_symbol_budget ?? 0,
      minTradeValue: a.min_trade_value ?? 0,
      notes: a.notes ?? [],
    };
  }, [decisions]);

  if (!ready) return null;

  return (
    <div className="min-h-dvh">
      <AppHeader email={email} />
      {/* Two sticky bars stack on this page (tab bar + section index), so
          anchor jumps must clear both, not just one. */}
      <main
        className="panels-responsive mx-auto w-full min-w-0 max-w-6xl overflow-x-hidden px-3 py-6 sm:px-4 2xl:max-w-7xl"
        style={{ "--sticky-stack-h": "calc(var(--subnav-h) * 2)" } as CSSProperties}
      >
        <PortfolioTabs id={id} />
        <SectionIndex
          items={PORTFOLIO_SECTIONS}
          offset={44}
          top="calc(var(--app-header-h) + var(--subnav-h))"
        />
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> All portfolios
        </Link>

        {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {p && (
          <>
            <div className="scroll-below-sticky mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 pt-1 sm:flex sm:flex-wrap sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight sm:text-2xl">
                    {p.name}
                  </h1>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label="Rename portfolio"
                    onClick={() => setRenameOpen(true)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {p.mode !== "live_prod" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 gap-1"
                      onClick={() => setAddFundsOpen(true)}
                    >
                      <Banknote className="h-4 w-4" /> Add funds
                    </Button>
                  )}
                  <ModeBadge mode={p.mode} />
                  <TradingModeBadge portfolioId={p.id} riskConfig={p.risk_config} />
                  <LiveToggle
                    portfolioId={p.id}
                    mode={p.mode}
                    livePaused={(p as { live_paused?: boolean | null }).live_paused}
                  />
                </div>

                <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  {p.currency} {startingCash.toFixed(0)}{" "}
                  <Explain term="starting_pot">starting pot</Explain> ·{" "}
                  <Explain term="risk_level">{p.risk_level} risk</Explain>
                </p>
                {p.mode === "live_prod" ? (
                  <p className="mt-1 text-[11px] font-medium leading-snug text-destructive sm:text-xs">
                    ⚠ <Explain term="live_prod">Real money</Explain> — approved orders route to your
                    live broker account.
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground sm:text-xs">
                    This portfolio uses{" "}
                    <span className="font-medium text-foreground">pretend money</span> — nothing you
                    do here touches your bank or Saxo account.{" "}
                    {p.mode === "live_sim" ? (
                      <>
                        (<Explain term="live_sim">paper-traded against live prices</Explain>)
                      </>
                    ) : (
                      <>
                        (<Explain term="backtest">historical backtest only</Explain>)
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="text-xl font-semibold leading-tight tabular-nums sm:text-3xl">
                  {formatMoney(totalValue, p.currency)}
                </span>
                <span
                  className={`text-[11px] font-medium tabular-nums sm:text-sm ${
                    pnl >= 0 ? "text-primary" : "text-destructive"
                  }`}
                >
                  {pnl >= 0 ? "+" : ""}
                  {formatMoneyAmount(pnl)} ({pnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>

            {underfunded && (
              <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      Portfolio underfunded — no affordable instruments
                    </p>
                    <p className="text-muted-foreground">
                      The latest AI run found no tradeable symbols. Per-symbol budget is{" "}
                      <span className="font-medium text-foreground">
                        {p.currency} {underfunded.budget.toFixed(2)}
                      </span>{" "}
                      and the minimum trade value is{" "}
                      <span className="font-medium text-foreground">
                        {p.currency} {underfunded.minTradeValue.toFixed(2)}
                      </span>
                      . Try adding funds
                      {p.mode !== "live_prod" ? " to this portfolio" : " to your broker account"},
                      raising the max position size, or lowering the minimum trade value in Risk
                      controls.
                    </p>
                    {underfunded.notes.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        <JargonText>{underfunded.notes.slice(0, 2).join(" · ")}</JargonText>
                      </p>
                    )}
                    <div className="pt-1">
                      <Button size="sm" variant="outline" onClick={() => setTab("risk")}>
                        Open Risk controls
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div id="equity" className="scroll-below-sticky" />
            <EquityPctChart
              className="mb-4"
              portfolioId={id}
              equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
              startingCash={baselineStartingCash}
              deposits={depositEvents}
              inceptionDate={q.data?.inceptionDate ?? null}
              seriesStartDate={q.data?.seriesStartDate ?? null}
              trades={trades as unknown as import("@/lib/chart-trade-markers").MarkerTrade[]}
            />

            <Suspense fallback={<div className="mb-4 h-64 animate-pulse rounded-md bg-muted/40" />}>
              <div id="composition" className="mb-4 scroll-below-sticky">
                <EquityCompositionCard portfolioId={id} />
              </div>
            </Suspense>


            <div className="mt-2 flex justify-end">
              <ExperienceLevelToggle />
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as PortfolioTab)} className="mt-2">

              {/* Mobile: single-row horizontally scrollable strip with snap so
                  the tab set doesn't consume 3–4 vertical rows on 375px.
                  Desktop keeps the wrap-free flex layout. */}
              <TabsList className="-mx-4 flex w-auto max-w-none justify-start gap-1 h-auto overflow-x-auto scroll-smooth snap-x snap-mandatory px-4 p-1 md:mx-0 md:w-full md:max-w-full md:flex-nowrap md:overflow-x-auto md:px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <TabsTrigger value="overview" className="min-h-10 shrink-0 snap-start">
                  Summary
                </TabsTrigger>
                <TabsTrigger value="trades" className="min-h-10 shrink-0 snap-start">
                  Buys &amp; sells ({trades.length})
                </TabsTrigger>
                <TabsTrigger value="decisions" className="min-h-10 shrink-0 snap-start">
                  Why ({decisions.length})
                </TabsTrigger>
                <TabsTrigger value="risk" className="min-h-10 shrink-0 snap-start">
                  Risk
                </TabsTrigger>
                {/* Expert-only tabs. Hidden in Simple mode so a newcomer sees
                    four choices instead of nine — the Simple/Advanced switch
                    above brings them straight back. */}
                {advancedLevel && (
                  <>
                    <TabsTrigger value="audit" className="min-h-10 shrink-0 snap-start">
                      Audit trail
                    </TabsTrigger>
                    <TabsTrigger value="errors" className="min-h-10 shrink-0 snap-start">
                      Errors
                    </TabsTrigger>
                    <TabsTrigger value="confidence" className="min-h-10 shrink-0 snap-start">
                      Confidence
                    </TabsTrigger>
                    <TabsTrigger value="diagnostics" className="min-h-10 shrink-0 snap-start">
                      Diagnostics
                    </TabsTrigger>
                    <TabsTrigger value="reports" className="min-h-10 shrink-0 snap-start">
                      Reports
                    </TabsTrigger>
                  </>
                )}
              </TabsList>


              <TabsContent value="overview" className="mt-4">
                <CurrencyDiagnosticsBanner
                  portfolioId={id}
                  portfolioCurrency={p.currency}
                  mode={p.mode}
                />
                <RiskHaltBanner portfolioId={id} className="mb-4 mt-4" />
                <SignalWeightHistoryCard portfolioId={id} className="mb-4" />
                <PolicyRegimeTimelineCard portfolioId={id} className="mb-4" />
                <div className="mb-4">
                  <PolicyDecisionExplainCard portfolioId={id} />
                </div>
                <InsiderDealingsCard className="mb-4" />
                <InsiderEventStudyCard className="mb-4" />
                <InsiderNudgeReplayCard className="mb-4" />
                <PolicyNudgeReplayCard className="mb-4" />
                <PolicyNudgeSweepCard className="mb-4" />

                <PrecheckCashAlertBanner portfolioId={id} className="mb-4" />
                <CostSyncAlertBanner portfolioId={id} className="mb-4" />
                <CoverageTrendAlertBanner portfolioId={id} className="mb-4" />

                <ValuationConsistencyAlert portfolioId={id} className="mb-4" />
                <InstrumentCcyAlert portfolioId={id} className="mb-4" />
                <ReconcileFillsCard portfolioId={id} className="mb-4" />
                <PriceUnitAuditCard portfolioId={id} className="mb-4" />
                <div id="holdings" className="mb-6 scroll-below-sticky">
                  <LiveHoldingsCard
                    holdings={holdings}
                    currency={p.currency}
                    cash={cashAuthoritative}
                    cashByCcy={
                      (p as { cash_by_ccy?: Record<string, number> | null }).cash_by_ccy ?? null
                    }
                    totalValue={totalValue}
                    invested={holdingsValue}
                    mode={p.mode}
                    series={holdingsSeries}
                    portfolioId={id}
                  />
                </div>
                {p.broker && (
                  <div className="mb-6">
                    <Suspense
                      fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}
                    >
                      <CorporateActionsCard portfolioId={id} active={tab === "overview"} />
                    </Suspense>
                  </div>
                )}

                <Card id="actions" className="mb-6 scroll-below-sticky">
                  <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    <UITooltipProvider delayDuration={100}>
                      <UITooltip>
                        <UITooltipTrigger asChild>
                          <Button
                            onClick={() => runDay.mutate()}
                            disabled={runDay.isPending || runBt.isPending}
                          >
                            <Zap className="mr-1 h-4 w-4" />
                            {runDay.isPending ? "Running…" : "Run one day now"}
                          </Button>
                        </UITooltipTrigger>
                        <UITooltipContent className="max-w-xs">
                          Manually triggers ONE AI decision cycle right now (fetches latest prices +
                          news, asks the AI, applies guardrails, records any resulting trades). Same
                          thing the hourly cron does when the portfolio is Active — use this to test
                          or force a run without waiting for the next hour. Doesn't touch real money
                          unless the portfolio is in Real money mode.
                        </UITooltipContent>
                      </UITooltip>
                    </UITooltipProvider>
                    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
                      <span className="text-xs text-muted-foreground">Backtest days:</span>
                      <div className="w-32">
                        <Slider
                          value={[days]}
                          onValueChange={([v]) => setDays(v)}
                          min={3}
                          max={20}
                          step={1}
                        />
                      </div>
                      <span className="w-6 text-right text-sm tabular-nums">{days}</span>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => runBt.mutate()}
                      disabled={runBt.isPending || runDay.isPending}
                    >
                      <PlayCircle className="mr-1 h-4 w-4" />
                      {runBt.isPending ? "Backtesting…" : `Run ${days}-day backtest`}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmReset(true)}
                      disabled={reset.isPending}
                    >
                      <RotateCcw className="mr-1 h-4 w-4" /> Reset
                    </Button>
                    <Link to="/long-horizon/$id" params={{ id }}>
                      <Button variant="outline">
                        <CalendarClock className="mr-1 h-4 w-4" /> Long-horizon backtest
                      </Button>
                    </Link>
                    <Link to="/walk-forward/$id" params={{ id }}>
                      <Button variant="outline">
                        <CalendarClock className="mr-1 h-4 w-4" /> Walk-forward test
                      </Button>
                    </Link>

                    {(runDay.isPending || runBt.isPending) && (
                      <span className="text-xs text-muted-foreground">
                        Fetching prices, reading news, asking the AI…
                      </span>
                    )}
                  </CardContent>
                </Card>

                <OverviewLookDeeperSection
                  id={id}
                  p={p}
                  equity={equity as { snapshot_date: string; total_value: number; source?: string | null }[]}
                  trades={trades as unknown as import("@/lib/backtest-metrics").TradeRow[]}
                  depositEvents={depositEvents}
                  baselineStartingCash={baselineStartingCash}
                  advancedLevel={advancedLevel}
                  tab={tab}
                  lastBtMetrics={lastBtMetrics}
                  lastBtDays={lastBtDays}
                  backtestRunToken={backtestRunToken}
                  ready={ready}
                />

                {(() => {
                  const cb = p.circuit_breaker as {
                    paused?: boolean;
                    reason?: string;
                    tripped_at?: string;
                  } | null;
                  if (!cb?.paused) return null;
                  return (
                    <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
                      <div className="font-medium text-destructive">
                        Circuit breaker active — AI paused
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        <JargonText>{`${cb.reason ?? "Auto-paused"}${cb.tripped_at ? ` (since ${cb.tripped_at.slice(0, 10)})` : ""}. Stop-loss/take-profit still enforced. Adjust risk controls or clear the breaker to resume new trades.`}</JargonText>
                      </div>
                    </div>
                  );
                })()}

                <div className="mb-6">
                  <LiveTradingCard portfolioId={id} />
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <Card className="lg:col-span-2">
                    <CardHeader className="gap-3">
                      <CardTitle className="text-base">Equity curve</CardTitle>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <div className="flex items-center gap-2">

                          <label className="text-xs font-normal text-muted-foreground">
                            Benchmark
                          </label>
                          <select
                            value={benchmark}
                            onChange={(e) => setBenchmark(e.target.value)}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs font-normal"
                          >
                            <option value="none">None</option>
                            <option value="SPY">SPY (S&amp;P 500)</option>
                            <option value="QQQ">QQQ (Nasdaq 100)</option>
                            <option value="ACWI">ACWI (Global)</option>
                            <option value="AGG">AGG (US Bonds)</option>
                            <option value="GLD">GLD (Gold)</option>
                            <option value="BTC-USD">BTC-USD</option>
                          </select>
                        </div>
                        <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">

                            {(["standard", "high", "light", "cb"] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setChartContrast(mode)}
                                className={`px-2 py-1 font-normal capitalize transition-colors ${
                                  chartContrast === mode
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:text-foreground"
                                }`}
                                title={
                                  mode === "cb"
                                    ? "Colorblind-safe palette (Okabe–Ito)"
                                    : `${mode} contrast`
                                }
                                aria-label={
                                  mode === "cb" ? "Colorblind-safe palette" : `${mode} contrast`
                                }
                              >
                                {mode === "cb" ? "Colorblind" : mode}
                              </button>
                            ))}
                          </div>
                          <label
                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                            title="Annual risk-free rate used in Sharpe ratio"
                          >
                            <span>Rf</span>
                            <input
                              type="number"
                              step="0.1"
                              value={riskFreeRate}
                              onChange={(e) => setRiskFreeRate(Number(e.target.value) || 0)}
                              className="w-14 bg-transparent text-foreground tabular-nums outline-none"
                              aria-label="Risk-free rate (annual %)"
                            />
                            <span>%</span>
                          </label>
                          <div
                            className="inline-flex overflow-hidden rounded-md border border-border text-xs"
                            role="group"
                            aria-label="Benchmark compare mode"
                          >
                            {(["raw", "pct"] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setCompareMode(mode)}
                                className={`px-2 py-1 font-normal transition-colors ${
                                  compareMode === mode
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:text-foreground"
                                }`}
                                title={
                                  mode === "pct" ? "Normalized: % indexed to start" : "Raw value"
                                }
                              >
                                {mode === "pct" ? "% vs start" : "Raw"}
                              </button>
                            ))}
                          </div>
                          <EventOverlayControls
                            domainDates={equityData.map((d) => d.date)}
                            enabled={eventsOn}
                            onToggle={setEventsOn}
                            minSeverity={eventSev}
                            onSeverityChange={setEventSev}
                          />
                      </div>
                    </CardHeader>

                    {perfMetrics && (
                      <div className="mx-6 mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {(
                          [
                            {
                              label: "CAGR",
                              term: "cagr" as TermId,
                              value: perfMetrics.port.annReturn,
                              suffix: "%",
                              signed: true,
                              negative: false,
                            },
                            {
                              label: "Volatility (ann.)",
                              term: "volatility" as TermId,
                              value: perfMetrics.port.annVol,
                              suffix: "%",
                              signed: false,
                              negative: false,
                            },
                            {
                              label: `Sharpe (rf=${riskFreeRate}%)`,
                              term: "sharpe" as TermId,
                              value:
                                perfMetrics.port.annVol > 0
                                  ? (perfMetrics.port.annReturn - riskFreeRate) /
                                    perfMetrics.port.annVol
                                  : null,
                              suffix: "",
                              signed: true,
                              negative: false,
                            },
                            {
                              label: "Max drawdown",
                              term: "max_drawdown" as TermId,
                              value: perfMetrics.port.maxDrawdown,
                              suffix: "%",
                              signed: false,
                              negative: true,
                            },
                          ] as const
                        ).map((m) => {
                          const bv =
                            m.label === "CAGR"
                              ? perfMetrics.bench?.annReturn
                              : m.label === "Volatility (ann.)"
                                ? perfMetrics.bench?.annVol
                                : m.label === "Max drawdown"
                                  ? perfMetrics.bench?.maxDrawdown
                                  : perfMetrics.bench && perfMetrics.bench.annVol > 0
                                    ? (perfMetrics.bench.annReturn - riskFreeRate) /
                                      perfMetrics.bench.annVol
                                    : null;
                          const fmt = (v: number | null | undefined) =>
                            formatMetricValue(v, m.signed, m.suffix);

                          const color = (v: number | null | undefined) => {
                            if (v == null) return "text-muted-foreground";
                            if (m.negative) return v < 0 ? "text-destructive" : "text-foreground";
                            if (!m.signed) return "text-foreground";
                            return v >= 0 ? "text-primary" : "text-destructive";
                          };
                          return (
                            <div
                              key={m.label}
                              className="min-w-0 rounded-md border border-border/70 bg-muted/30 p-3"
                            >
                              <div className="flex min-w-0 items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                <span className="truncate">{m.label}</span>
                                <span className="shrink-0">
                                  <ExplainIcon term={m.term} />
                                </span>
                              </div>
                              <div
                                title={fmt(m.value)}
                                className={`mt-0.5 truncate tabular-nums text-base font-semibold leading-tight sm:text-lg ${color(m.value)}`}
                              >
                                {fmt(m.value)}
                              </div>
                              {perfMetrics.bench && (
                                <div className="truncate tabular-nums text-[11px] text-muted-foreground">
                                  {benchmark}: <span className={color(bv)}>{fmt(bv)}</span>
                                </div>
                              )}
                            </div>
                          );

                        })}
                      </div>
                    )}
                    {perfMetrics && (
                      <div className="mx-6 mb-3 rounded-md border border-border/70 bg-muted/30 p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                          <span className="min-w-0 truncate">
                            Performance vs {benchmark === "none" ? "benchmark" : benchmark}
                          </span>
                          {perfMetrics.correlation != null && (
                            <span className="shrink-0 tabular-nums">
                              Correlation:{" "}
                              <span className="font-medium text-foreground">
                                {perfMetrics.correlation.toFixed(2)}
                              </span>
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-5">

                          {(
                            [
                              {
                                label: "Total return",
                                key: "totalReturn",
                                suffix: "%",
                                signed: true,
                                negative: false,
                                derived: false,
                              },
                              {
                                label: "Annualized return",
                                key: "annReturn",
                                suffix: "%",
                                signed: true,
                                negative: false,
                                derived: false,
                              },
                              {
                                label: "Volatility (ann.)",
                                key: "annVol",
                                suffix: "%",
                                signed: false,
                                negative: false,
                                derived: false,
                              },
                              {
                                label: "Max drawdown",
                                key: "maxDrawdown",
                                suffix: "%",
                                signed: false,
                                negative: true,
                                derived: false,
                              },
                              {
                                label: "Return / Vol",
                                key: "rvr",
                                suffix: "",
                                signed: true,
                                negative: false,
                                derived: true,
                              },
                            ] as const
                          ).map((m) => {
                            const fmt = (v: number | null | undefined) =>
                              formatMetricValue(v, m.signed, m.suffix);

                            const derived = (obj: { annReturn: number; annVol: number } | null) =>
                              obj && obj.annVol > 0 ? obj.annReturn / obj.annVol : null;
                            const pick = (obj: typeof perfMetrics.port | null) => {
                              if (!obj) return null;
                              const v = (obj as unknown as Record<string, unknown>)[m.key];
                              return typeof v === "number" ? v : null;
                            };
                            const pv = m.derived
                              ? derived(perfMetrics.port)
                              : pick(perfMetrics.port);
                            const bv = m.derived
                              ? derived(perfMetrics.bench)
                              : pick(perfMetrics.bench);
                            const color = (v: number | null) => {
                              if (v == null) return "text-muted-foreground";
                              if (m.negative) return v < 0 ? "text-destructive" : "text-foreground";
                              if (!m.signed) return "text-foreground";
                              return v >= 0 ? "text-primary" : "text-destructive";
                            };
                            return (
                              <div key={m.label} className="min-w-0">
                                <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {m.label}
                                </div>
                                <div
                                  title={fmt(pv)}
                                  className={`truncate tabular-nums font-medium ${color(pv)}`}
                                >
                                  {fmt(pv)}
                                </div>
                                {perfMetrics.bench && (
                                  <div className="truncate tabular-nums text-[11px] text-muted-foreground">
                                    {benchmark}: <span className={color(bv)}>{fmt(bv)}</span>
                                  </div>
                                )}
                              </div>

                            );
                          })}
                        </div>
                      </div>
                    )}
                    <CardContent
                      className="h-64 min-w-0 max-w-full overflow-hidden sm:h-80"

                      style={
                        chartTheme.surface !== "transparent"
                          ? { background: chartTheme.surface, borderRadius: 8 }
                          : undefined
                      }
                    >
                      {equityData.length < 2 ? (
                        <p className="pt-8 text-center text-sm text-muted-foreground">
                          Run a backtest or the daily AI to see the curve.
                        </p>
                      ) : (
                        <ChartFrame className="h-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart
                            data={displayChartData}
                            margin={{ ...chartPreset.margin, bottom: 28 }}
                          >
                            <defs>
                              <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                                <stop
                                  offset="0%"
                                  stopColor={chartTheme.drawdown}
                                  stopOpacity={0.28}
                                />
                                <stop
                                  offset="100%"
                                  stopColor={chartTheme.drawdown}
                                  stopOpacity={0.02}
                                />
                              </linearGradient>
                              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                                <stop
                                  offset="0%"
                                  stopColor={chartTheme.equity}
                                  stopOpacity={chartTheme.equityFillTop}
                                />
                                <stop
                                  offset="100%"
                                  stopColor={chartTheme.equity}
                                  stopOpacity={chartTheme.equityFillBottom}
                                />
                              </linearGradient>
                            </defs>
                            <CartesianGrid {...GRID_PROPS} />
                            <XAxis
                              dataKey="date"
                              tick={AXIS_TICK}
                              stroke={chartTheme.axis}
                              minTickGap={chartPreset.minTickGap}
                              tickFormatter={(v) => formatDateTick(v, isMobile)}
                              label={
                                isMobile
                                  ? undefined
                                  : {
                                      value: "Date",
                                      position: "insideBottom",
                                      offset: -2,
                                      fill: chartTheme.axisText,
                                      fontSize: 12,
                                    }
                              }
                              axisLine={AXIS_LINE}
                              tickLine={TICK_LINE}
                            />
                            <YAxis
                              domain={["auto", "auto"]}
                              width={isMobile ? 56 : 92}
                              tick={AXIS_TICK}
                              stroke={chartTheme.axis}
                              tickFormatter={(v) =>
                                formatValueTick(v, {
                                  currency: p.currency,
                                  isPct: compareMode === "pct",
                                  isMobile,
                                })
                              }
                              label={
                                isMobile
                                  ? undefined
                                  : {
                                      value: yAxisLabel(compareMode, p.currency),
                                      angle: -90,
                                      position: "insideLeft",
                                      offset: -2,
                                      style: { textAnchor: "middle" },
                                      fill: chartTheme.axisText,
                                      fontSize: 12,
                                    }
                              }

                              axisLine={AXIS_LINE}
                              tickLine={TICK_LINE}
                            />

                            <Tooltip
                              cursor={{ stroke: chartTheme.axis, strokeDasharray: "3 3" }}
                              wrapperStyle={{ zIndex: 40, maxWidth: "min(85vw, 320px)" }}
                              content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null;
                                const row = payload[0].payload as {
                                  value: number;
                                  peak: number;
                                  drawdown: number;
                                  benchmark?: number | null;
                                };
                                const isPct = compareMode === "pct";
                                const fmtVal = (v: number) =>
                                  isPct
                                    ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
                                    : `${p.currency} ${v.toFixed(2)}`;
                                // Measure against invested capital on that
                                // date (baseline pot + deposits so far) — the
                                // same rule the equity-% chart and every
                                // equity tile use, so a top-up never reads as
                                // profit and the "start" line means the same
                                // thing everywhere.
                                const capital = baseAt(String(label));
                                const pnlFromStart = isPct ? row.value : row.value - capital;
                                const pnlPctFromStart = isPct
                                  ? row.value
                                  : capital > 0
                                    ? (pnlFromStart / capital) * 100
                                    : 0;
                                const benchPct =
                                  row.benchmark == null
                                    ? null
                                    : isPct
                                      ? row.benchmark
                                      : capital > 0
                                        ? ((row.benchmark - capital) / capital) * 100
                                        : null;
                                const active_events = eventsOn
                                  ? eventsInRange(String(label), String(label)).filter(
                                      (e) => e.severity >= eventSev,
                                    )
                                  : [];
                                return (
                                  <div className="max-w-[85vw] rounded-md border border-border bg-card p-2 text-[11px] shadow-md sm:text-xs">
                                    <div className="mb-1 font-medium">
                                      {label}{" "}
                                      <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        {isPct ? "% vs start" : "value"}
                                      </span>
                                    </div>
                                    <div className="tabular-nums">
                                      <span
                                        className="inline-block h-2 w-2 rounded-full mr-1.5"
                                        style={{ background: chartTheme.equity }}
                                      />
                                      Portfolio: {fmtVal(row.value)}
                                    </div>
                                    {!isPct && (
                                      <div className="tabular-nums text-muted-foreground pl-3.5">
                                        vs start: {pnlFromStart >= 0 ? "+" : ""}
                                        {pnlFromStart.toFixed(2)} ({pnlPctFromStart.toFixed(2)}%)
                                        {capital - baselineStartingCash !== 0 && (
                                          <span
                                            className="ml-1"
                                            title={`Measured against ${p.currency} ${capital.toFixed(2)} of invested capital, including ${p.currency} ${Math.abs(capital - baselineStartingCash).toFixed(2)} of ${capital >= baselineStartingCash ? "deposits" : "withdrawals"}`}
                                          >
                                            · trading only
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    {row.benchmark != null && (
                                      <div className="tabular-nums mt-1">
                                        <span
                                          className="inline-block h-2 w-2 rounded-full mr-1.5"
                                          style={{ background: chartTheme.benchmark }}
                                        />
                                        {benchmark}: {fmtVal(row.benchmark)}
                                        {!isPct && benchPct != null && (
                                          <span className="text-muted-foreground">
                                            {" "}
                                            ({benchPct >= 0 ? "+" : ""}
                                            {benchPct.toFixed(2)}%)
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    <div className="tabular-nums text-muted-foreground mt-1">
                                      Peak: {fmtVal(row.peak)}
                                    </div>
                                    <div
                                      className={`tabular-nums ${row.drawdown < 0 ? "text-destructive" : "text-primary"}`}
                                    >
                                      Drawdown: {row.drawdown.toFixed(2)}%
                                    </div>
                                    {active_events.length > 0 && (
                                      <div className="mt-1 border-t border-border/60 pt-1">
                                        {active_events.map((e) => (
                                          <div
                                            key={e.id}
                                            style={{ color: eventColor(e.category) }}
                                            className="font-medium"
                                          >
                                            ● {e.label}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              }}
                            />
                            <ReferenceLine
                              {...REFERENCE_LINE}
                              y={compareMode === "pct" ? 0 : startingCash}
                              label={{
                                value: "start",
                                fill: chartTheme.axisText,
                                fontSize: 12,
                                position: "insideTopRight",
                              }}
                            />
                            {eventsOn && (
                              <EventOverlay
                                domainDates={equityData.map((d) => d.date)}
                                minSeverity={eventSev}
                                labelPosition="insideTop"
                              />
                            )}
                            <Area
                              type="monotone"
                              dataKey="peak"
                              stroke="none"
                              fill="url(#ddFill)"
                              fillOpacity={1}
                              isAnimationActive={false}
                              activeDot={false}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke="none"
                              fill="url(#equityFill)"
                              fillOpacity={1}
                              isAnimationActive={false}
                              activeDot={false}
                            />
                            <Line
                              type="monotone"
                              dataKey="peak"
                              stroke={chartTheme.peak}
                              strokeWidth={1}
                              strokeDasharray="2 3"
                              dot={false}
                              isAnimationActive={false}
                            />
                            <Line
                              type="monotone"
                              dataKey="value"
                              name="Portfolio"
                              stroke={chartTheme.equity}
                              strokeWidth={chartTheme.strokeWidth}
                              dot={false}
                              activeDot={{
                                r: 5,
                                fill: chartTheme.equity,
                                stroke: "var(--background)",
                                strokeWidth: 2,
                              }}
                            />
                            {benchmark !== "none" && (
                              <Line
                                type="monotone"
                                dataKey="benchmark"
                                name={`${benchmark} (normalised)`}
                                stroke={chartTheme.benchmark}
                                strokeWidth={Math.max(2, chartTheme.strokeWidth - 0.5)}
                                strokeDasharray="4 3"
                                dot={false}
                                connectNulls
                                isAnimationActive={false}
                                activeDot={{
                                  r: 4,
                                  fill: chartTheme.benchmark,
                                  stroke: "var(--background)",
                                  strokeWidth: 2,
                                }}
                              />
                            )}
                            <Legend
                              verticalAlign="bottom"
                              height={28}
                              iconType="plainline"
                              {...LEGEND_PROPS}
                              wrapperStyle={{
                                ...LEGEND_PROPS.wrapperStyle,
                                color: chartTheme.axisText,
                                paddingTop: 8,
                              }}
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                        </ChartFrame>
                      )}
                    </CardContent>
                  </Card>

                  <CommodityExposureCard
                    holdings={holdings}
                    decisions={decisions}
                    currency={p.currency}
                    totalValue={totalValue}
                    series={holdingsSeries}
                  />
                </div>

                <div className="mt-6">
                  <CommodityLiquiditySimulatorCard />
                </div>

                <div className="mt-6">
                  <InvestableUniverseCard />
                </div>

                <div className="mt-6">
                  <CommodityBacktestCard portfolioId={id} />
                </div>

                <div className="mt-6">
                  <CryptoBacktestCard portfolioId={id} />
                </div>

                {(p.mode === "live_sim" || p.mode === "live_prod") && (
                  <div className="mt-6 space-y-4">
                    <FxTradeDrilldownCard portfolioId={id} active={tab === "overview"} />

                    <CashReconciliationLogCard portfolioId={id} />
                  </div>
                )}


                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <RegimePanel />
                  <FearIndexCard portfolioId={id} active={tab === "overview"} currency={p.currency} />

                  <LearningPanel portfolioId={p.id} />
                </div>
              </TabsContent>

              <TabsContent value="risk" className="mt-4">
                <RiskSection
                  id={id}
                  p={p as unknown as RiskSectionPortfolio}
                  totalValue={totalValue}
                  holdings={holdings}
                  holdingsSeries={holdingsSeries}
                  active={tab === "risk"}
                  clampDialLevel={(v: unknown) => clampDialLevel(v as number | undefined)}
                />
              </TabsContent>

              <TabsContent value="decisions" className="mt-4 space-y-4">
                <Suspense fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}>
                  <TodaysDecisionSummaryCard portfolioId={p.id} currency={p.currency} />
                </Suspense>
                <OrderExplanationsBackfillCard portfolioId={p.id} />

                {decisions.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No AI decisions yet. Run one day or a backtest to see the AI's reasoning here.
                  </p>
                )}
                {decisions.map((d) => (
                  <DecisionCard
                    key={d.id}
                    decision={d}
                    currency={p.currency}
                    tradingStyle={
                      (p.risk_config as { trading_style?: string } | null)?.trading_style ===
                      "swing"
                        ? "swing"
                        : "position"
                    }
                  />
                ))}
              </TabsContent>

              <TabsContent value="audit" className="mt-4">
                <Suspense fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}>
                  <TradeAuditLogCard
                    portfolioId={p.id}
                    portfolioName={p.name}
                    active={tab === "audit"}
                  />
                </Suspense>
              </TabsContent>

              <TabsContent value="errors" className="mt-4">
                <Suspense fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}>
                  <div className="space-y-4">
                    <TradeOutcomePanelCard portfolioId={p.id} active={tab === "errors"} />
                    <TradeErrorDashboardCard portfolioId={p.id} active={tab === "errors"} />
                  </div>
                </Suspense>
              </TabsContent>

              <TabsContent value="confidence" className="mt-4">
                <Suspense fallback={<div className="h-40 rounded-xl border bg-card" aria-hidden />}>
                  <ConfidenceTimelineCard decisions={decisions} />
                </Suspense>
              </TabsContent>

              <TabsContent value="trades" className="mt-4">
                <ReconcileFillsCard portfolioId={id} className="mb-4" />
                {trades.length === 0 && (
                  <p className="text-sm text-muted-foreground">No trades yet.</p>
                )}
                {trades.length > 0 && (
                  <>
                    {/* Desktop / tablet: sortable table with sticky header */}
                    <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur text-xs uppercase text-muted-foreground">
                          <tr>
                            {(
                              [
                                {
                                  key: "date",
                                  label: `Date & time (${ukZoneAbbr()})`,
                                  align: "left",
                                },
                                { key: "symbol", label: "Symbol", align: "left" },
                                { key: "side", label: "Side", align: "left" },
                                { key: "qty", label: "Qty", align: "right" },
                                { key: "price", label: "Price", align: "right" },
                                { key: "value", label: "Value", align: "right" },
                              ] as const
                            ).map((col) => {
                              const active = tradeSort.key === col.key;
                              const Icon = active
                                ? tradeSort.dir === "asc"
                                  ? ArrowUp
                                  : ArrowDown
                                : ArrowUpDown;
                              return (
                                <th
                                  key={col.key}
                                  className={`px-3 py-2 select-none ${col.align === "right" ? "text-right" : "text-left"}`}
                                >
                                  <button
                                    type="button"
                                    className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
                                    onClick={() =>
                                      setTradeSort((s) =>
                                        s.key === col.key
                                          ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
                                          : {
                                              key: col.key,
                                              dir:
                                                col.key === "date" ||
                                                col.key === "value" ||
                                                col.key === "qty" ||
                                                col.key === "price"
                                                  ? "desc"
                                                  : "asc",
                                            },
                                      )
                                    }
                                  >
                                    {col.label}
                                    <Icon className="h-3 w-3 opacity-70" />
                                  </button>
                                </th>
                              );
                            })}
                            <th className="px-3 py-2 text-left">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedTrades.map((t) => {
                            const executedAt = t.executed_at ? new Date(t.executed_at) : null;
                            const timeUk =
                              executedAt && !isNaN(executedAt.getTime())
                                ? formatUk(executedAt, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                    hour12: false,
                                  })
                                : null;
                            const zoneUk =
                              executedAt && !isNaN(executedAt.getTime())
                                ? ukZoneAbbr(executedAt)
                                : "";
                            return (
                              <tr key={t.id} className="border-t border-border">
                                <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                                  <span>{t.trade_date}</span>
                                  {timeUk && (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      {timeUk} {zoneUk}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 font-medium">
                                  <SymbolTicker symbol={t.symbol} />
                                </td>
                                <td
                                  className={`px-3 py-2 ${t.side === "buy" ? "text-primary" : "text-accent"}`}
                                >
                                  {t.side.toUpperCase()}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {Number(t.quantity).toFixed(4)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {Number(t.price).toFixed(2)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {Number(t.value).toFixed(2)}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                  <JargonText>{t.reason}</JargonText>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile: accordion cards — tap to expand full details */}
                    <div className="md:hidden space-y-2">
                      {sortedTrades.map((t) => {
                        const executedAt = t.executed_at ? new Date(t.executed_at) : null;
                        const timeUk =
                          executedAt && !isNaN(executedAt.getTime())
                            ? formatUk(executedAt, {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                hour12: false,
                              })
                            : null;
                        const zoneUk =
                          executedAt && !isNaN(executedAt.getTime()) ? ukZoneAbbr(executedAt) : "";
                        return (
                          <details
                            key={t.id}
                            className="group rounded-lg border border-border bg-card text-sm [&_summary::-webkit-details-marker]:hidden"
                          >
                            <summary className="flex cursor-pointer list-none items-center gap-2 p-3">
                              <Badge
                                className={`shrink-0 ${t.side === "buy" ? "bg-primary/15 text-primary hover:bg-primary/15" : "bg-accent/15 text-accent hover:bg-accent/15"}`}
                              >
                                {t.side.toUpperCase()}
                              </Badge>
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {t.symbol}
                              </span>
                              <span className="shrink-0 tabular-nums font-semibold">
                                {Number(t.value).toFixed(2)}
                              </span>
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="border-t border-border px-3 py-2 space-y-1.5">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                                <span>
                                  {t.trade_date}
                                  {timeUk ? ` · ${timeUk} ${zoneUk}` : ""}
                                </span>
                                <span>Qty {Number(t.quantity).toFixed(4)}</span>
                                <span>@ {Number(t.price).toFixed(2)}</span>
                              </div>
                              {t.reason && (
                                <p className="text-xs text-muted-foreground break-words">
                                  <JargonText>{t.reason}</JargonText>
                                </p>
                              )}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="diagnostics" className="mt-4 space-y-4">
                <DiagnosticsPanel portfolioId={p.id} />
                <Collapsible open={showAdvancedDiag} onOpenChange={setShowAdvancedDiag}>
                  <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${showAdvancedDiag ? "rotate-180" : ""}`}
                    />
                    {showAdvancedDiag ? "Hide" : "Show"} advanced diagnostics (signal decay,
                    correlations, stress, learning delta, shadow variants)
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-4">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <SignalDecayCard portfolioId={p.id} />
                      <CorrelationHeatmapCard portfolioId={p.id} />
                      
                      <LearningDiagnosticsCard portfolioId={p.id} />
                      <ShadowVariantCard portfolioId={p.id} />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </TabsContent>

              <TabsContent value="reports" className="mt-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      {
                        to: "/portfolio/$id/analytics",
                        label: "Performance analytics",
                        desc: "Equity, drawdown and PnL attribution across regime, sizing, exit and execution phases.",
                        Icon: BarChart3,
                      },
                      {
                        to: "/portfolio/$id/attribution",
                        label: "Attribution",
                        desc: "Per-asset P&L contribution and factor breakdown.",
                        Icon: BarChart3,
                      },
                      {
                        to: "/portfolio/$id/sma-report",
                        label: "SMA crossover report",
                        desc: "Per-symbol SMA20/50 crosses, golden/death regime and the trades taken against that trend.",
                        Icon: BarChart3,
                      },
                      {
                        to: "/portfolio/$id/report",
                        label: "Report",
                        desc: "Downloadable performance report for this portfolio.",
                        Icon: FileText,
                      },
                      {
                        to: "/portfolio/$id/optimizer",
                        label: "Optimizer",
                        desc: "Re-run the AI with alternate risk profiles for comparison.",
                        Icon: Settings2,
                      },
                      {
                        to: "/long-horizon/$id",
                        label: "Long-horizon backtest",
                        desc: "Multi-decade rule-based simulation vs benchmarks.",
                        Icon: CalendarClock,
                      },
                    ] as const
                  ).map((r) => (
                    <Link key={r.to} to={r.to} params={{ id: p.id }} className="block">
                      <Card className="h-full transition-colors hover:border-primary/40">
                        <CardContent className="flex items-start gap-3 py-4">
                          <div className="mt-0.5 rounded-md bg-muted p-2">
                            <r.Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium">{r.label}</div>
                            <p className="text-xs text-muted-foreground">{r.desc}</p>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset portfolio?"
        description={
          <p>
            This resets the portfolio to its <span className="font-semibold">starting cash</span>{" "}
            and permanently deletes every trade, decision and equity point. This cannot be undone.
          </p>
        }
        requireText="RESET"
        confirmLabel="Reset portfolio"
        onConfirm={() => {
          setConfirmReset(false);
          reset.mutate();
        }}
      />
      {p && (
        <RenamePortfolioDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          portfolioId={p.id}
          currentName={p.name}
        />
      )}
      {p && p.mode !== "live_prod" && (
        <>
          <SimFundHistoryCard portfolioId={p.id} currency={p.currency} />
          <AddSimFundsDialog
            open={addFundsOpen}
            onOpenChange={setAddFundsOpen}
            portfolioId={p.id}
            portfolioName={p.name}
            currency={p.currency}
            currentCash={Number(p.current_cash)}
            startingCash={Number(p.starting_cash)}
            holdingsValue={holdingsValue}
          />
        </>
      )}
    </div>
  );
}


// Presentational pieces extracted into focused modules — behaviour unchanged.
export { formatMetricValue } from "@/components/portfolio-detail/format";
