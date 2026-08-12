import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Sparkles } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,

  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getSymbolHistory } from "@/lib/market-symbol-history.functions";
import { getChartAnnotations } from "@/lib/chart-annotations.functions";
import type { ChartAnnotation } from "@/lib/chart-annotations";
import type {
  AnnotationWithDecisions,
  LinkedDecision,
} from "@/lib/annotation-decision-link";
import {
  HISTORY_RANGES,
  HISTORY_SYMBOLS,
  coerceRange,
  computeTrendStrength,
  computeTrendStrengthSeries,
  rangeLabel,
  smaKey,
  symbolMeta,
  type HistoryRange,
  type SmaPeriod,
  isKnownSymbol,
  type SymbolHistory,
} from "@/lib/market-symbol-history";
import { SymbolSearch } from "@/components/market/symbol-search";
import {
  TrendStrengthBadge,
  TrendStrengthSparkline,
  TrendStrengthStat,
} from "@/components/market/trend-strength-badge";
import {
  DEFAULT_SMA_PERIODS,
  PERIOD_STYLE,
  parseSmaPeriods,
  readStoredSmaPeriods,
  readStoredTrendBasis,
  resolveTrendBasis,
  storeTrendBasis,
  type TrendBasis,
  serialiseSmaPeriods,
  storeSmaPeriods,
  toggleSmaPeriod,
} from "@/lib/sma-display";
import { SmaPeriodToggles } from "@/components/market/sma-period-toggles";
import { BackRow } from "@/components/nav/back-row";
import { useYAxisWidth, compactTick Y_AXIS_WIDTH_MOBILE } from "@/lib/chart-axis";
import { RsiBadge, RsiPane } from "@/components/market/rsi-pane";
import { detectRsiDivergences, divergenceSummary } from "@/lib/rsi-divergence";
import { DIVERGENCE_LABEL, DIVERGENCE_TONE, type RsiDivergence } from "@/lib/rsi-divergence-style";
import {
  RSI_SIGNAL_MODES,
  RSI_SIGNAL_MODE_HINT,
  RSI_SIGNAL_MODE_LABEL,
  detectRsiSignals,
  isRsiSignalMode,
  rsiSignalSummary,
  type RsiSignal,
  type RsiSignalMode,
} from "@/lib/rsi-signals";
import { RSI_SIGNAL_TONE } from "@/lib/rsi-signal-style";
import { RsiBacktestPanel } from "@/components/market/rsi-backtest-panel";
import { AiChartReadCard } from "@/components/market/ai-chart-read-card";
import { DivergenceBacktestPanel } from "@/components/market/divergence-backtest-panel";
import type { RsiTrade } from "@/lib/rsi-backtest";
import type { DivergenceTrade } from "@/lib/rsi-divergence-backtest";
import {
  EMPTY_TRADE_OVERLAY,
  divergenceTradeId,
  divergenceTradeOverlay,
  mergeTradeOverlays,
  rsiTradeId,
  rsiTradeOverlay,
} from "@/lib/backtest-trade-markers";
import { TradeDetailDrawer } from "@/components/market/trade-detail-drawer";
import {
  divergenceTradeDetail,
  rsiTradeDetail,
  type TradeDetail,
} from "@/lib/trade-detail";
import {
  clipOverlayToWindow,
  focusOpacity,
  focusPoints,
  isFocused,
  type TradeFocus,
} from "@/lib/trade-focus";
import { tradeLegColor, tradeMarkerColor } from "@/lib/trade-marker-style";


import { TrendBasisSelect } from "@/components/market/trend-basis-select";
import {
  buildComparison,
  parseCompareParam,
  serialiseCompareParam,
  toggleCompareSymbol,
} from "@/lib/market-compare";
import { CompareOverlay } from "@/components/market/compare-overlay";
import { formatUkDate, formatUkDateTime } from "@/lib/uk-time";
import { formatMoney } from "@/lib/format-money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";


export const Route = createFileRoute("/market/$symbol")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { range: HistoryRange; compare?: string | undefined; sma?: string | undefined } => ({
    range: coerceRange(search.range),
    compare: serialiseCompareParam(parseCompareParam(search.compare)),
    sma: typeof search.sma === "string" ? serialiseSmaPeriods(parseSmaPeriods(search.sma)) : undefined,
  }),

  head: () => ({
    meta: [
      { title: "Market chart | Price history & trend" },
      {
        name: "description",
        content:
          "Full price history for a single market with selectable 30d to 3y ranges, 50/200-day averages, volatility and drawdown.",
      },
      { property: "og:title", content: "Market chart | Price history & trend" },
      {
        property: "og:description",
        content: "Drill into any Market pulse metric: price, trend averages, volatility and drawdown.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketSymbolPage,
});

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function num(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface-2 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 font-display text-lg font-bold tabular-nums ${
          tone === "up" ? "text-emerald-500" : tone === "down" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

const ANNOTATION_TONE: Record<string, string> = {
  spike_up: CHART_ROLE.positive,
  spike_down: CHART_ROLE.negative,
  golden_cross: CHART_ROLE.positive,
  death_cross: CHART_ROLE.negative,
  drawdown_trough: CHART_ROLE.negative,
  vol_regime: CHART_ROLE.highlight,
  range_high: CHART_ROLE.benchmark,
  range_low: CHART_ROLE.benchmark,
};

function AnnotationSources({ sources }: { sources: ChartAnnotation["sources"] }) {
  if (!sources?.length) {
    return (
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        No stored headlines within 2 days of this date — the wording comes from the price move alone.
      </p>
    );
  }

  return (
    <div className="mt-1.5 space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Headlines the AI saw
      </div>
      <ul className="space-y-1">
        {sources.map((n, i) => (
          <li key={`${n.date}-${i}`} className="text-xs leading-snug">
            <span className="tabular-nums text-muted-foreground">
              {n.at ? formatUkDateTime(n.at) : formatUkDate(`${n.date}T00:00:00Z`)}
            </span>
            {n.source ? <span className="text-muted-foreground"> · {n.source}</span> : null}
            <br />
            {n.url ? (
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-primary"
              >
                {n.headline}
              </a>
            ) : (
              <span>{n.headline}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}


function DecisionLinks({ decisions }: { decisions: LinkedDecision[] }) {
  if (!decisions?.length) {
    return (
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        No trading decision was taken within 3 days of this move.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Decisions this note fed into
      </div>
      <ul className="space-y-1">
        {decisions.map((d) => {
          const buy = d.action.toLowerCase() === "buy";
          const sell = d.action.toLowerCase() === "sell";
          return (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-1.5 text-xs leading-snug">
              <span
                className="rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  color: buy
                    ? CHART_ROLE.positive
                    : sell
                      ? CHART_ROLE.negative
                      : undefined,
                }}
              >
                {d.action}
              </span>
              <span className="font-medium">{d.symbol}</span>
              {d.notional ? (
                <span className="tabular-nums text-muted-foreground">
                  {formatMoney(d.notional, d.instrumentCcy ?? "GBP")}
                </span>
              ) : null}
              <span className="text-muted-foreground">· {d.outcome}</span>
              <span className="text-muted-foreground">
                · {formatUkDate(d.decidedAt)}
                {d.dayGap === 0 ? " (same day)" : ` (${d.dayGap}d away)`}
              </span>
              {d.sameInstrument ? (
                <span className="text-muted-foreground">· this instrument</span>
              ) : null}
              {d.rationale ? (
                <span className="basis-full text-muted-foreground">{d.rationale}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AnnotationList({
  annotations,
  loading,
}: {
  annotations: AnnotationWithDecisions[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  if (!annotations.length) return null;



  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> What moved this chart
      </h2>
      <ol className="space-y-2">
        {annotations.map((a, i) => (
          <li
            key={a.id}
            className="flex gap-3 rounded-xl border border-border/60 bg-surface-2 px-3 py-2.5"
          >
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-semibold tabular-nums"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">
                {a.date} · {a.label}
              </div>
              <p className="mt-0.5 text-sm">{a.note}</p>
              <AnnotationSources sources={a.sources} />
              <DecisionLinks decisions={a.decisions ?? []} />
            </div>

          </li>
        ))}
      </ol>
      <p className="text-[11px] text-muted-foreground">
        Notable moves are detected from the price series; the wording is AI-generated and may miss
        the real driver. Not financial advice.
      </p>
    </section>
  );
}

/** Plain-language read-out of the RSI zone buy/sell markers. */
function RsiSignalList({ signals, mode }: { signals: RsiSignal[]; mode: RsiSignalMode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground">
        RSI zone markers · {RSI_SIGNAL_MODE_LABEL[mode]} logic ({signals.length} in window)
      </h2>
      <p className="text-[11px] text-muted-foreground">{RSI_SIGNAL_MODE_HINT[mode]}</p>
      {signals.length ? (
        <ul className="space-y-1.5">
          {signals
            .slice(-5)
            .reverse()
            .map((s) => (
              <li key={`${s.kind}-${s.date}`} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={
                    s.kind === "buy"
                      ? "border-emerald-500/40 text-emerald-500"
                      : "border-destructive/40 text-destructive"
                  }
                >
                  {s.kind === "buy" ? "Buy" : "Sell"}
                </Badge>
                <span className="text-muted-foreground">
                  {formatUkDate(s.date)} · {rsiSignalSummary(s)}
                </span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No oversold/overbought {mode === "cross" ? "crosses" : "touches"} in this window.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Markers are momentum reference points, not instructions to trade. Not financial advice.
      </p>
    </section>
  );
}

/** Plain-language read-out of the divergences drawn on the charts. */
function DivergenceList({ divergences }: { divergences: RsiDivergence[] }) {
  if (!divergences.length) {
    return (
      <p className="text-xs text-muted-foreground">
        No RSI divergences in this window — price and momentum agree.
      </p>
    );
  }
  const recent = divergences.slice(-4).reverse();
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground">
        RSI divergences ({divergences.length} in window)
      </h2>
      <ul className="space-y-1.5">
        {recent.map((d) => (
          <li key={`${d.kind}-${d.from.date}-${d.to.date}`} className="flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={
                d.kind === "bullish"
                  ? "border-emerald-500/40 text-emerald-500"
                  : "border-destructive/40 text-destructive"
              }
            >
              {DIVERGENCE_LABEL[d.kind]}
            </Badge>
            <span className="text-muted-foreground">
              {formatUkDate(d.from.date)} → {formatUkDate(d.to.date)} · {divergenceSummary(d)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Divergence flags waning momentum, not a trade signal: confirm with a reclaim of the
        20-day average before acting. Not financial advice.
      </p>
    </section>
  );
}



function MarketSymbolPage() {
  const { symbol } = Route.useParams();
  const { range, compare: compareParam, sma: smaParam } = Route.useSearch();
  const yWidth = useYAxisWidth();

  // Averages default to whatever the home dashboard card is showing, so the
  // two views stay in sync; an explicit ?sma= wins (shareable links).
  const [trendBasis, setTrendBasis] = useState<TrendBasis>("auto");
  // RSI is opt-in and remembered locally, like the SMA selection.
  const [showRsi, setShowRsi] = useState(false);
  useEffect(() => {
    try {
      setShowRsi(window.localStorage.getItem("chart.rsi") === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleRsi = () => {
    setShowRsi((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("chart.rsi", next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };
  // Divergence overlay is its own toggle; enabling it opens the RSI pane too
  // so the two legs of the signal are visible together.
  const [showDiv, setShowDiv] = useState(false);
  useEffect(() => {
    try {
      setShowDiv(window.localStorage.getItem("chart.rsiDivergence") === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleDiv = () => {
    setShowDiv((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("chart.rsiDivergence", next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      if (next) {
        setShowRsi(true);
        try {
          window.localStorage.setItem("chart.rsi", "1");
        } catch {
          /* storage unavailable */
        }
      }
      return next;
    });
  };

  // RSI zone buy/sell markers: opt-in, with the cross/touch school remembered.
  const [showSignals, setShowSignals] = useState(false);
  const [signalMode, setSignalMode] = useState<RsiSignalMode>("cross");
  useEffect(() => {
    try {
      setShowSignals(window.localStorage.getItem("chart.rsiSignals") === "1");
      const m = window.localStorage.getItem("chart.rsiSignalMode");
      if (isRsiSignalMode(m)) setSignalMode(m);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleSignals = () => {
    setShowSignals((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("chart.rsiSignals", next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      if (next) {
        setShowRsi(true);
        try {
          window.localStorage.setItem("chart.rsi", "1");
        } catch {
          /* storage unavailable */
        }
      }
      return next;
    });
  };
  const pickSignalMode = (m: RsiSignalMode) => {
    setSignalMode(m);
    try {
      window.localStorage.setItem("chart.rsiSignalMode", m);
    } catch {
      /* storage unavailable */
    }
  };

  const pickTrendBasis = (b: TrendBasis) => {
    setTrendBasis(b);
    storeTrendBasis(b);
  };
  const [periods, setPeriods] = useState<SmaPeriod[]>(
    smaParam ? parseSmaPeriods(smaParam) : DEFAULT_SMA_PERIODS,
  );
  useEffect(() => {
    setPeriods(smaParam ? parseSmaPeriods(smaParam) : readStoredSmaPeriods());
    setTrendBasis(readStoredTrendBasis());
  }, [smaParam]);

  const togglePeriod = (p: SmaPeriod) => {
    const next = toggleSmaPeriod(periods, p);
    setPeriods(next);
    storeSmaPeriods(next);
    void navigate({
      to: "/market/$symbol",
      params: { symbol },
      search: { range, compare: compareParam, sma: serialiseSmaPeriods(next) },
      replace: true,
    });
  };
  const navigate = useNavigate();
  const meta = symbolMeta(symbol);
  const fetchHistory = useServerFn(getSymbolHistory);
  const fetchAnnotations = useServerFn(getChartAnnotations);

  const compare = useMemo(
    () => parseCompareParam(compareParam, symbol),
    [compareParam, symbol],
  );

  const query = useQuery({
    queryKey: ["symbol-history", symbol, range],
    queryFn: () => fetchHistory({ data: { symbol, days: range } }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const basis = resolveTrendBasis(trendBasis, periods);
  const strength = useMemo(
    () => (query.data ? computeTrendStrength(query.data.points, periods, basis) : null),
    [query.data, periods, basis],
  );

  const strengthSeries = useMemo(
    () => (query.data ? computeTrendStrengthSeries(query.data.points, periods, 30, basis) : []),
    [query.data, periods, basis],
  );

  const annotationQuery = useQuery({
    queryKey: ["symbol-annotations", symbol, range],
    queryFn: () => fetchAnnotations({ data: { symbol, days: range } }),
    enabled: isKnownSymbol(symbol) && (query.data?.points.length ?? 0) > 4,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const compareQueries = useQueries({
    queries: compare.map((s) => ({
      queryKey: ["symbol-history", s, range],
      queryFn: () => fetchHistory({ data: { symbol: s, days: range } }),
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    })),
  });

  const history = query.data;
  const annotations = annotationQuery.data?.annotations ?? [];
  const up = (history?.changePct ?? 0) >= 0;

  // Divergences are derived purely from the window on screen.
  const divergences = useMemo(
    () => (history ? detectRsiDivergences(history.points) : []),
    [history],
  );


  const rsiSignals = useMemo(
    () => (history && showSignals ? detectRsiSignals(history.points, signalMode) : []),
    [history, showSignals, signalMode],
  );

  // Executed backtest fills, reported up from the panels so the charts can
  // mark the exact bars each engine traded.
  const [rsiTrades, setRsiTrades] = useState<RsiTrade[]>([]);
  const [divTrades, setDivTrades] = useState<DivergenceTrade[]>([]);
  const [showFills, setShowFills] = useState(true);
  const fullOverlay = useMemo(() => {
    if (!history || !showFills) return EMPTY_TRADE_OVERLAY;
    return mergeTradeOverlays(
      showSignals ? rsiTradeOverlay(rsiTrades, history.points) : EMPTY_TRADE_OVERLAY,
      showDiv ? divergenceTradeOverlay(divTrades, history.points) : EMPTY_TRADE_OVERLAY,
    );
  }, [history, showFills, showSignals, showDiv, rsiTrades, divTrades]);

  // Click-to-highlight: selecting a trade zooms both panes to its entry/exit.
  const [focus, setFocus] = useState<TradeFocus | null>(null);
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);

  const chartPoints = useMemo(
    () => (history ? focusPoints(history.points, focus) : []),
    [history, focus],
  );
  const tradeOverlay = useMemo(
    () => (focus ? clipOverlayToWindow(fullOverlay, chartPoints) : fullOverlay),
    [fullOverlay, chartPoints, focus],
  );

  // Scroll the fills into view whenever a new trade is selected.
  useEffect(() => {
    if (!focus) return;
    chartRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus]);

  // A trade selected under one toggle stops existing when that toggle is off.
  useEffect(() => {
    if (!showFills) setFocus(null);
  }, [showFills]);

  const selectRsiTrade = useCallback((t: RsiTrade | null) => {
    setDetail(t ? rsiTradeDetail(t) : null);
    setDetailOpen(t != null);
    setFocus(
      t
        ? {
            tradeId: rsiTradeId(t),
            fromDate: t.entryDate,
            toDate: t.exitDate,
            label: `RSI trade ${t.entryDate} → ${t.exitDate}`,
          }
        : null,
    );
  }, []);

  const selectDivTrade = useCallback((t: DivergenceTrade | null) => {
    setDetail(t ? divergenceTradeDetail(t) : null);
    setDetailOpen(t != null);
    setFocus(
      t
        ? {
            tradeId: divergenceTradeId(t),
            fromDate: t.entryDate,
            toDate: t.exitDate,
            label: `${t.kind} divergence ${t.entryDate} → ${t.exitDate}`,
          }
        : null,
    );
  }, []);


  const compareLoading = compareQueries.some((q) => q.isLoading);
  const compareData = compareQueries
    .map((q) => q.data)
    .filter((d): d is SymbolHistory => Boolean(d));
  const comparison = useMemo(
    () => buildComparison(history ? [history, ...compareData] : compareData, periods),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, compareData.map((d) => d.symbol).join(","), compareData.length, range, periods],
  );

  const setCompare = (next: string[]) => {
    void navigate({
      to: "/market/$symbol",
      params: { symbol },
      search: { range, compare: serialiseCompareParam(next), sma: smaParam },
      replace: true,
    });
  };




  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <BackRow to="/markets" label="Markets" title={symbol} />
      <Link
        to="/"
        className="hidden items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground md:inline-flex"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to dashboard
      </Link>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{meta?.label ?? symbol}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {meta?.kind ?? "Market"} · {symbol}
              {history?.asOf ? ` · prices to ${history.asOf}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SymbolSearch range={range} className="w-full sm:w-64" />
            <SmaPeriodToggles periods={periods} onToggle={togglePeriod} />
            <Button
              size="sm"
              variant={showRsi ? "secondary" : "ghost"}
              className="h-11 px-3 text-xs sm:h-7 sm:px-2"
              aria-pressed={showRsi}
              onClick={toggleRsi}
            >
              RSI
            </Button>
            <Button
              size="sm"
              variant={showDiv ? "secondary" : "ghost"}
              className="h-11 px-3 text-xs sm:h-7 sm:px-2"
              aria-pressed={showDiv}
              onClick={toggleDiv}
              title="Highlight RSI/price divergences"
            >
              Divergence
            </Button>
            <Button
              size="sm"
              variant={showSignals ? "secondary" : "ghost"}
              className="h-11 px-3 text-xs sm:h-7 sm:px-2"
              aria-pressed={showSignals}
              onClick={toggleSignals}
              title="Mark buy/sell points where RSI enters or leaves the oversold/overbought zones"
            >
              Signals
            </Button>
            {showSignals
              ? RSI_SIGNAL_MODES.map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={signalMode === m ? "secondary" : "ghost"}
                    className="h-11 px-3 text-[11px] sm:h-7 sm:px-2"
                    aria-pressed={signalMode === m}
                    onClick={() => pickSignalMode(m)}
                    title={RSI_SIGNAL_MODE_HINT[m]}
                  >
                    {RSI_SIGNAL_MODE_LABEL[m]}
                  </Button>
                ))
              : null}
            {showSignals || showDiv ? (
              <Button
                size="sm"
                variant={showFills ? "secondary" : "ghost"}
                className="h-11 px-3 text-xs sm:h-7 sm:px-2"
                aria-pressed={showFills}
                onClick={() => setShowFills((v) => !v)}
                title="Mark the backtest's executed entries and exits on the price and RSI charts"
              >
                Fills
              </Button>
            ) : null}


            {HISTORY_RANGES.map((r) => (
              <Button
                key={r}
                asChild
                size="sm"
                variant={r === range ? "secondary" : "ghost"}
                className="h-11 px-3 text-xs sm:h-7 sm:px-2"
              >
                <Link
                  to="/market/$symbol"
                  params={{ symbol }}
                  search={{ range: r, compare: compareParam, sma: smaParam }}
                >

                  {rangeLabel(r)}
                </Link>
              </Button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {query.isLoading ? (
            <Skeleton className="h-80 w-full rounded-xl" />
          ) : query.isError || !history ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                No price history found for “{symbol}”. Check the ticker (LSE names end in .L).
              </p>
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                <RefreshCw className="mr-1 h-4 w-4" /> Retry
              </Button>
            </div>
          ) : history.points.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Not enough stored price history for this range yet.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-display text-3xl font-bold tabular-nums">
                  {num(history.last)}
                </span>
                <Badge
                  variant="outline"
                  className={
                    up ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"
                  }
                >
                  {pct(history.changePct)} over {rangeLabel(range)}
                </Badge>
                <TrendStrengthBadge strength={strength} />
                <RsiBadge value={history.rsi14} />
              </div>


              <div ref={chartRef} className="scroll-mt-4 space-y-2">
              {focus ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5">
                  <p className="text-xs">
                    Zoomed to <span className="font-medium">{focus.label}</span> — entry and exit
                    highlighted, other fills dimmed.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      setFocus(null);
                      setDetailOpen(false);
                    }}
                  >
                    Show full range
                  </Button>
                </div>
              ) : null}
              <ChartFrame className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartPoints} syncId="symbol-price" margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    {focus ? (
                      <ReferenceArea
                        x1={focus.fromDate}
                        x2={focus.toDate}
                        fill={CHART_ROLE.highlight}
                        fillOpacity={0.1}
                        ifOverflow="extendDomain"
                      />
                    ) : null}
                    <XAxis
                      dataKey="date"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                      minTickGap={40}
                      tickFormatter={(d: string) => d.slice(2, 7)}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                      width={yWidth}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) =>
                        yWidth <= Y_AXIS_WIDTH_MOBILE ? compactTick(v) : num(v, 0)
                      }
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_CONTENT_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      formatter={(v: number, name: string) => [num(v), name]}
                    />
                    <Line
                      type="monotone"
                      dataKey="close"
                      name="Price"
                      stroke={CHART_ROLE.neutral}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    {periods.map((p) => (
                      <Line
                        key={p}
                        type="monotone"
                        dataKey={smaKey(p)}
                        name={`${p}-day average`}
                        stroke={PERIOD_STYLE[p].stroke}
                        strokeWidth={1.5}
                        strokeDasharray={PERIOD_STYLE[p].dash}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}
                    {showDiv
                      ? divergences.map((d) => (
                          <ReferenceLine
                            key={`price-div-${d.kind}-${d.from.date}-${d.to.date}`}
                            segment={[
                              { x: d.from.date, y: d.from.price },
                              { x: d.to.date, y: d.to.price },
                            ]}
                            stroke={DIVERGENCE_TONE[d.kind]}
                            strokeWidth={1.8}
                            strokeDasharray="5 3"
                            ifOverflow="extendDomain"
                          />
                        ))
                      : null}

                    {rsiSignals.map((sig) => (
                      <ReferenceDot
                        key={`price-sig-${sig.kind}-${sig.date}`}
                        x={sig.date}
                        y={sig.price}
                        r={5}
                        fill={RSI_SIGNAL_TONE[sig.kind]}
                        stroke="var(--background)"
                        strokeWidth={1.5}
                        isFront
                        label={{
                          value: sig.kind === "buy" ? "B" : "S",
                          fill: RSI_SIGNAL_TONE[sig.kind],
                          fontSize: 11,
                          fontWeight: 700,
                          position: sig.kind === "buy" ? "bottom" : "top",
                        }}
                      />
                    ))}

                    {tradeOverlay.legs.map((leg) => (
                      <ReferenceLine
                        key={`price-leg-${leg.key}`}
                        segment={[
                          { x: leg.fromDate, y: leg.fromPrice },
                          { x: leg.toDate, y: leg.toPrice },
                        ]}
                        stroke={tradeLegColor(leg)}
                        strokeWidth={isFocused(focus, leg.tradeId) ? 2.6 : 1.4}
                        strokeDasharray={leg.open ? "2 4" : undefined}
                        strokeOpacity={0.7 * focusOpacity(focus, leg.tradeId)}
                        ifOverflow="extendDomain"
                      />
                    ))}

                    {tradeOverlay.markers.map((m) => (
                      <ReferenceDot
                        key={`price-trade-${m.key}`}
                        x={m.date}
                        y={m.price}
                        r={isFocused(focus, m.tradeId) ? 9 : 6}
                        fill={m.side === "entry" ? "var(--background)" : tradeMarkerColor(m)}
                        stroke={tradeMarkerColor(m)}
                        strokeWidth={isFocused(focus, m.tradeId) ? 3 : 2}
                        opacity={focusOpacity(focus, m.tradeId)}
                        isFront
                        ifOverflow="extendDomain"
                        label={{
                          value: m.glyph,
                          fill: tradeMarkerColor(m),
                          fontSize: 11,
                          fontWeight: 700,
                          position: m.side === "entry" ? "bottom" : "top",
                        }}
                      />
                    ))}

                    {annotations.map((a, i) => (
                      <ReferenceDot
                        key={a.id}
                        x={a.date}
                        y={a.close}
                        r={9}
                        fill={ANNOTATION_TONE[a.kind] ?? CHART_ROLE.highlight}
                        stroke="var(--background)"
                        strokeWidth={1.5}
                        isFront
                        label={{
                          value: String(i + 1),
                          fill: "var(--background)",
                          fontSize: 11,
                          fontWeight: 700,
                          position: "center",
                        }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
              </div>

              {detail && !detailOpen ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-3 text-xs sm:h-7 sm:px-2"
                  onClick={() => setDetailOpen(true)}
                >
                  Trade details
                </Button>
              ) : null}

              <TradeDetailDrawer
                detail={detail}
                symbol={symbol}
                open={detailOpen}
                onOpenChange={setDetailOpen}
              />

              {tradeOverlay.markers.length ? (
                <p className="text-[11px] text-muted-foreground">
                  Backtest fills: hollow markers are entries, filled markers are exits (green =
                  profitable net of costs, red = loss); the connecting line is the holding period.
                </p>
              ) : null}

              {showRsi ? (
                <RsiPane
                  points={chartPoints}
                  divergences={showDiv ? divergences : []}
                  signals={rsiSignals}
                  tradeMarkers={tradeOverlay.markers}
                  focusTradeId={focus?.tradeId ?? null}
                />
              ) : null}

              {showSignals ? (
                <>
                  <RsiSignalList signals={rsiSignals} mode={signalMode} />
                  <RsiBacktestPanel
                    points={history.points}
                    mode={signalMode}
                    rangeLabel={rangeLabel(range)}
                    onTrades={setRsiTrades}
                    selectedTradeId={focus?.tradeId ?? null}
                    onSelectTrade={selectRsiTrade}
                  />
                </>
              ) : null}

              {showDiv ? (
                <>
                  <DivergenceList divergences={divergences} />
                  <DivergenceBacktestPanel
                    points={history.points}
                    rangeLabel={rangeLabel(range)}
                    onTrades={setDivTrades}
                    selectedTradeId={focus?.tradeId ?? null}
                    onSelectTrade={selectDivTrade}
                  />
                </>
              ) : null}

              <AiChartReadCard
                symbol={symbol}
                days={range}
                periods={periods}
                basis={basis}
                signalMode={signalMode}
              />



              <AnnotationList
                annotations={annotations}
                loading={annotationQuery.isLoading || annotationQuery.isFetching}
              />

              <CompareOverlay
                symbol={symbol}
                range={range}
                compare={compare}
                options={HISTORY_SYMBOLS}
                comparison={comparison}
                periods={periods}
                loading={compareLoading}
                onToggle={(s) => setCompare(toggleCompareSymbol(compare, s))}
                onClear={() => setCompare([])}
              />


              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={`Change (${rangeLabel(range)})`} value={pct(history.changePct)} tone={up ? "up" : "down"} />
                <Stat label="Range high" value={num(history.high)} />
                <Stat label="Range low" value={num(history.low)} />
                <Stat label="Volatility (annualised)" value={pct(history.volatilityPct, 0)} />
                <Stat label="Worst fall in range" value={pct(history.maxDrawdownPct)} />
                <dl className="contents">
                  <TrendStrengthStat strength={strength} />
                </dl>
                <div className="col-span-2 rounded-xl border border-border/60 bg-surface-2 px-3 py-2 sm:col-span-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Trend strength over time
                      {strength ? ` · ${strength.period}-day basis` : ""}
                    </p>
                    <TrendBasisSelect
                      basis={trendBasis}
                      periods={periods}
                      onChange={pickTrendBasis}
                    />
                  </div>
                  <TrendStrengthSparkline series={strengthSeries} className="h-14 w-full" />
                </div>
                {periods.map((p) => (
                  <Stat key={p} label={`${p}-day average`} value={num(history.smaLatest?.[p] ?? null)} />
                ))}
                <Stat
                  label="Trend"
                  value={
                    history.aboveSma50 == null
                      ? "—"
                      : history.aboveSma50
                        ? "Above 50-day"
                        : "Below 50-day"
                  }
                  tone={history.aboveSma50 == null ? undefined : history.aboveSma50 ? "up" : "down"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Prices are as stored in the app's daily price history. The 50- and 200-day averages
                smooth out day-to-day noise: price above both usually means an established uptrend.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
