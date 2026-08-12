import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Sparkles } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
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
import { RsiBadge, RsiPane } from "@/components/market/rsi-pane";
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

function MarketSymbolPage() {
  const { symbol } = Route.useParams();
  const { range, compare: compareParam, sma: smaParam } = Route.useSearch();

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
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
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
              className="h-7 px-2 text-xs"
              aria-pressed={showRsi}
              onClick={toggleRsi}
            >
              RSI
            </Button>
            {HISTORY_RANGES.map((r) => (
              <Button
                key={r}
                asChild
                size="sm"
                variant={r === range ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
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


              <ChartFrame className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history.points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid {...GRID_PROPS} />
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
                      width={64}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) => num(v, 0)}
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
                    {annotations.map((a, i) => (
                      <ReferenceDot
                        key={a.id}
                        x={a.date}
                        y={a.close}
                        r={9}
                        fill={ANNOTATION_TONE[a.kind] ?? CHART_ROLE.highlight}
                        stroke="hsl(var(--background))"
                        strokeWidth={1.5}
                        isFront
                        label={{
                          value: String(i + 1),
                          fill: "hsl(var(--background))",
                          fontSize: 10,
                          fontWeight: 700,
                          position: "center",
                        }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>

              {showRsi ? <RsiPane points={history.points} /> : null}

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
