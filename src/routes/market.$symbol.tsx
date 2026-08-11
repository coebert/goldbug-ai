import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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
import {
  HISTORY_RANGES,
  coerceRange,
  rangeLabel,
  symbolMeta,
  type HistoryRange,
} from "@/lib/market-symbol-history";
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
  validateSearch: (search: Record<string, unknown>): { range: HistoryRange } => ({
    range: coerceRange(search.range),
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


function AnnotationList({
  annotations,
  loading,
}: {
  annotations: ChartAnnotation[];
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
  const { range } = Route.useSearch();
  const meta = symbolMeta(symbol);
  const fetchHistory = useServerFn(getSymbolHistory);
  const fetchAnnotations = useServerFn(getChartAnnotations);

  const query = useQuery({
    queryKey: ["symbol-history", symbol, range],
    queryFn: () => fetchHistory({ data: { symbol, days: range } }),
    enabled: Boolean(meta),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const annotationQuery = useQuery({
    queryKey: ["symbol-annotations", symbol, range],
    queryFn: () => fetchAnnotations({ data: { symbol, days: range } }),
    enabled: Boolean(meta) && (query.data?.points.length ?? 0) > 4,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const history = query.data;
  const annotations = annotationQuery.data?.annotations ?? [];
  const up = (history?.changePct ?? 0) >= 0;


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
          <div className="flex flex-wrap gap-1">
            {HISTORY_RANGES.map((r) => (
              <Button
                key={r}
                asChild
                size="sm"
                variant={r === range ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
              >
                <Link to="/market/$symbol" params={{ symbol }} search={{ range: r }}>
                  {rangeLabel(r)}
                </Link>
              </Button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {!meta ? (
            <p className="text-sm text-muted-foreground">
              No chart is available for “{symbol}”.
            </p>
          ) : query.isLoading ? (
            <Skeleton className="h-80 w-full rounded-xl" />
          ) : query.isError || !history ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Couldn't load this market's history.</p>
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
                    <Line
                      type="monotone"
                      dataKey="sma50"
                      name="50-day average"
                      stroke={CHART_ROLE.benchmark}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="sma200"
                      name="200-day average"
                      stroke={CHART_ROLE.highlight}
                      strokeWidth={1.5}
                      strokeDasharray="2 4"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
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

              <AnnotationList
                annotations={annotations}
                loading={annotationQuery.isLoading || annotationQuery.isFetching}
              />



              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={`Change (${rangeLabel(range)})`} value={pct(history.changePct)} tone={up ? "up" : "down"} />
                <Stat label="Range high" value={num(history.high)} />
                <Stat label="Range low" value={num(history.low)} />
                <Stat label="Volatility (annualised)" value={pct(history.volatilityPct, 0)} />
                <Stat label="Worst fall in range" value={pct(history.maxDrawdownPct)} />
                <Stat label="50-day average" value={num(history.sma50)} />
                <Stat label="200-day average" value={num(history.sma200)} />
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
