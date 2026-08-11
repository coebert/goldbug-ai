// One market's moving-average panel: price plus the selected averages,
// crossover markers, headline stats and the recent crossover list.
// Rendered once per selected market inside `SmaTrendCard`.

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowUpRight, RefreshCw, TrendingDown, TrendingUp, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_STYLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import {
  computeTrendStrength,
  computeTrendStrengthSeries,
  crossoverLabel,
  detectSmaCrossovers,
  rangeLabel,
  smaKey,
  symbolMeta,
  type HistoryRange,
  type SmaCrossover,
  type SmaPeriod,
  type SymbolHistory,
} from "@/lib/market-symbol-history";
import {
  TrendStrengthBadge,
  TrendStrengthSparkline,
  TrendStrengthStat,
} from "@/components/market/trend-strength-badge";
import { PERIOD_STYLE, serialiseSmaPeriods } from "@/lib/sma-display";

export const TONE_CLASS = {
  up: "border-emerald-500/40 text-emerald-500",
  down: "border-destructive/40 text-destructive",
  muted: "border-border text-muted-foreground",
} as const;

function num(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Plain-English read of where price sits against the chosen averages. */
export function trendVerdict(above: Array<boolean | null>) {
  const known = above.filter((v): v is boolean => v != null);
  if (!known.length) return { text: "Not enough history", tone: "muted" as const };
  if (known.every(Boolean))
    return {
      text: known.length === 1 ? "Above its average" : "Uptrend — above every average",
      tone: "up" as const,
    };
  if (known.every((v) => !v))
    return {
      text: known.length === 1 ? "Below its average" : "Downtrend — below every average",
      tone: "down" as const,
    };
  return { text: "Mixed — between its averages", tone: "muted" as const };
}

export function SmaTrendPanel({
  symbol,
  range,
  periods,
  history,
  loading,
  error,
  compact,
  onRetry,
  onRemove,
}: {
  symbol: string;
  range: HistoryRange;
  periods: SmaPeriod[];
  history: SymbolHistory | undefined;
  loading: boolean;
  error: boolean;
  /** Side-by-side mode: shorter chart, trimmed crossover list. */
  compact: boolean;
  onRetry: () => void;
  onRemove?: () => void;
}) {
  const crossovers = useMemo(
    () => (history ? detectSmaCrossovers(history.points, periods) : []),
    [history, periods],
  );
  const strength = useMemo(
    () => (history ? computeTrendStrength(history.points, periods) : null),
    [history, periods],
  );
  const strengthSeries = useMemo(
    () => (history ? computeTrendStrengthSeries(history.points, periods) : []),
    [history, periods],
  );
  const verdict = trendVerdict(periods.map((p) => history?.aboveSma?.[p] ?? null));
  const periodsLabel = periods.join("/");
  const label = symbolMeta(symbol)?.label ?? symbol;
  const maxCrossovers = compact ? 3 : 6;

  return (
    <section className="space-y-2.5 rounded-xl border border-border/60 bg-surface-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold">{label}</h3>
        <span className="text-xs text-muted-foreground">{symbol}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
            <Link
              to="/market/$symbol"
              params={{ symbol }}
              search={{ range, compare: undefined, sma: serialiseSmaPeriods(periods) }}
            >
              Full chart <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
          {onRemove && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              aria-label={`Remove ${label}`}
              onClick={onRemove}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <Skeleton className={compact ? "h-44 w-full rounded-xl" : "h-64 w-full rounded-xl"} />
      ) : error || !history ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Couldn't load {label}.</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : history.points.length < 2 ? (
        <p className="text-sm text-muted-foreground">
          Not enough stored price history for {rangeLabel(range)} yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-display text-xl font-bold tabular-nums">{num(history.last)}</span>
            <Badge
              variant="outline"
              className={(history.changePct ?? 0) >= 0 ? TONE_CLASS.up : TONE_CLASS.down}
            >
              {pct(history.changePct)} over {rangeLabel(range)}
            </Badge>
            <Badge variant="outline" className={TONE_CLASS[verdict.tone]}>
              {verdict.text}
            </Badge>
            <TrendStrengthBadge strength={strength} />
          </div>

          <ChartFrame className={compact ? "h-44 w-full" : "h-64 w-full"}>
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
                  width={56}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => num(v, 0)}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  formatter={(v: number, name: string) => [num(v), name]}
                />
                {!compact && <Legend wrapperStyle={LEGEND_STYLE} />}
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
                {crossovers.map((c) => (
                  <ReferenceDot
                    key={c.id}
                    x={c.date}
                    y={c.close}
                    r={compact ? 4 : 5}
                    fill={c.direction === "golden" ? CHART_ROLE.positive : CHART_ROLE.negative}
                    stroke={CHART_ROLE.neutral}
                    strokeWidth={1}
                    isFront
                    ifOverflow="extendDomain"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>

          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {periods.map((p) => (
              <div key={p} className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
                <dt className="text-muted-foreground">{p}-day avg</dt>
                <dd className="tabular-nums">{num(history.smaLatest?.[p] ?? null)}</dd>
              </div>
            ))}
            <div className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
              <dt className="text-muted-foreground">Volatility</dt>
              <dd className="tabular-nums">{pct(history.volatilityPct, 0)}</dd>
            </div>
            <TrendStrengthStat strength={strength} />
            <div className="col-span-2 rounded-lg border border-border/60 bg-surface-2 px-2.5 py-1.5">
              <dt className="text-muted-foreground">Trend strength over time</dt>
              <dd>
                <TrendStrengthSparkline series={strengthSeries} className="h-10 w-full" />
              </dd>
            </div>
            <div className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
              <dt className="text-muted-foreground">Max fall</dt>
              <dd className="tabular-nums">{pct(history.maxDrawdownPct)}</dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Crossovers in this window{crossovers.length ? ` (${crossovers.length})` : ""}
            </p>
            {crossovers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {periods.length < 2
                  ? "Pick two or more averages to track crossovers."
                  : `No ${periodsLabel}-day crossovers over ${rangeLabel(range)}.`}
              </p>
            ) : (
              <ul className="space-y-1">
                {crossovers.slice(0, maxCrossovers).map((c: SmaCrossover) => {
                  const up = c.direction === "golden";
                  const Icon = up ? TrendingUp : TrendingDown;
                  return (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-surface-2 px-2.5 py-1.5 text-xs"
                    >
                      <Icon
                        className={`h-3.5 w-3.5 shrink-0 ${up ? "text-emerald-500" : "text-destructive"}`}
                        aria-hidden="true"
                      />
                      <span className="tabular-nums text-muted-foreground">{c.date}</span>
                      <span className="font-medium">{crossoverLabel(c)}</span>
                      <Badge variant="outline" className={up ? TONE_CLASS.up : TONE_CLASS.down}>
                        {up ? "Golden cross" : "Death cross"}
                      </Badge>
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {c.barsAgo === 0 ? "latest bar" : `${c.barsAgo} bars ago`} ·{" "}
                        {pct(c.sinceChangePct)} since
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
