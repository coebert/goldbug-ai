// Home-dashboard SMA card: one market's price with a chosen set of moving
// averages (20/50/100/200-day), over a selectable window. Same data path as the drill-down page
// (`getSymbolHistory`), so the two never disagree.

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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
import {
  ArrowUpRight,
  LineChart as LineChartIcon,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";


import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { getSymbolHistory } from "@/lib/market-symbol-history.functions";
import {
  DEFAULT_RANGE,
  HISTORY_RANGES,
  HISTORY_SYMBOLS,
  coerceRange,
  isKnownSymbol,
  rangeLabel,
  symbolMeta,
  SMA_PERIODS,
  isSmaPeriod,
  smaKey,
  type HistoryRange,
  type SmaPeriod,
} from "@/lib/market-symbol-history";

const SYMBOL_KEY = "home-sma-symbol";
const RANGE_KEY = "home-sma-range";
const PERIODS_KEY = "home-sma-periods";
const DEFAULT_PERIODS: SmaPeriod[] = [50, 200];

/** One stroke style per period so overlapping averages stay distinguishable. */
const PERIOD_STYLE: Record<SmaPeriod, { stroke: string; dash: string }> = {
  20: { stroke: CHART_ROLE.positive, dash: "6 2" },
  50: { stroke: CHART_ROLE.benchmark, dash: "4 3" },
  100: { stroke: CHART_ROLE.warning, dash: "1 3" },
  200: { stroke: CHART_ROLE.highlight, dash: "2 4" },
};

function parsePeriods(raw: string | null): SmaPeriod[] {
  if (!raw) return DEFAULT_PERIODS;
  const picked = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && isSmaPeriod(v)) as SmaPeriod[];
  const unique = SMA_PERIODS.filter((p) => picked.includes(p));
  return unique.length ? unique : DEFAULT_PERIODS;
}
const DEFAULT_SYMBOL = HISTORY_SYMBOLS.includes("SPY") ? "SPY" : (HISTORY_SYMBOLS[0] ?? "");

function num(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Plain-English read of where price sits against the chosen averages. */
function trendVerdict(above: Array<boolean | null>) {
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

const TONE_CLASS = {
  up: "border-emerald-500/40 text-emerald-500",
  down: "border-destructive/40 text-destructive",
  muted: "border-border text-muted-foreground",
} as const;

/** Group the picker so sectors don't drown the headline markets. */
function groupedSymbols() {
  const markets: string[] = [];
  const sectors: string[] = [];
  for (const s of HISTORY_SYMBOLS) {
    (symbolMeta(s)?.kind === "US sector" ? sectors : markets).push(s);
  }
  return { markets, sectors };
}

export function SmaTrendCard() {
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [range, setRange] = useState<HistoryRange>(DEFAULT_RANGE);
  const [periods, setPeriods] = useState<SmaPeriod[]>(DEFAULT_PERIODS);
  const fetchHistory = useServerFn(getSymbolHistory);

  // Restore the last view after hydration so SSR markup stays stable.
  useEffect(() => {
    try {
      const s = window.localStorage.getItem(SYMBOL_KEY);
      if (s && isKnownSymbol(s)) setSymbol(s);
      const r = window.localStorage.getItem(RANGE_KEY);
      if (r) setRange(coerceRange(Number(r)));
      setPeriods(parsePeriods(window.localStorage.getItem(PERIODS_KEY)));
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }, []);

  const pickSymbol = (s: string) => {
    setSymbol(s);
    try {
      window.localStorage.setItem(SYMBOL_KEY, s);
    } catch {
      /* ignore */
    }
  };

  const pickRange = (r: HistoryRange) => {
    setRange(r);
    try {
      window.localStorage.setItem(RANGE_KEY, String(r));
    } catch {
      /* ignore */
    }
  };

  // Keep at least one average on the chart; the card is about averages.
  const togglePeriod = (p: SmaPeriod) => {
    setPeriods((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      const ordered = SMA_PERIODS.filter((x) => next.includes(x));
      const final = ordered.length ? ordered : prev;
      try {
        window.localStorage.setItem(PERIODS_KEY, final.join(","));
      } catch {
        /* ignore */
      }
      return final;
    });
  };

  const query = useQuery({
    queryKey: ["symbol-history", symbol, range],
    queryFn: () => fetchHistory({ data: { symbol, days: range } }),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });

  const history = query.data;
  const { markets, sectors } = useMemo(groupedSymbols, []);
  const verdict = trendVerdict(periods.map((p) => history?.aboveSma?.[p] ?? null));
  const periodsLabel = periods.map((p) => `${p}`).join("/");

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <LineChartIcon className="h-4 w-4 text-primary" aria-hidden="true" /> Moving-average
              trend
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Price against its {periodsLabel}-day average{periods.length > 1 ? "s" : ""}
              {history?.asOf ? ` · prices to ${history.asOf}` : ""}
            </p>
          </div>
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
            <Link to="/market/$symbol" params={{ symbol }} search={{ range, compare: undefined }}>
              Full chart <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={symbol} onValueChange={pickSymbol}>
            <SelectTrigger className="h-8 w-[190px] text-xs" aria-label="Market to chart">
              <SelectValue placeholder="Pick a market" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectGroup>
                <SelectLabel>Markets</SelectLabel>
                {markets.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {symbolMeta(s)?.label ?? s}
                  </SelectItem>
                ))}
              </SelectGroup>
              {sectors.length > 0 && (
                <SelectGroup>
                  <SelectLabel>US sectors</SelectLabel>
                  {sectors.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {symbolMeta(s)?.label ?? s}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Moving-average periods">
            {SMA_PERIODS.map((p) => {
              const on = periods.includes(p);
              return (
                <Button
                  key={p}
                  size="sm"
                  variant={on ? "secondary" : "ghost"}
                  className="h-7 px-2 text-xs"
                  aria-pressed={on}
                  aria-label={`${p}-day moving average`}
                  onClick={() => togglePeriod(p)}
                >
                  <span
                    className="mr-1.5 inline-block h-0.5 w-3 rounded"
                    style={{ background: PERIOD_STYLE[p].stroke, opacity: on ? 1 : 0.4 }}
                    aria-hidden="true"
                  />
                  {p}d
                </Button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Chart time range">
            {HISTORY_RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={r === range ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                aria-pressed={r === range}
                onClick={() => pickRange(r)}
              >
                {rangeLabel(r)}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : query.isError || !history ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Couldn't load this market's history.</p>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
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
              <span className="font-display text-2xl font-bold tabular-nums">
                {num(history.last)}
              </span>
              <Badge
                variant="outline"
                className={
                  (history.changePct ?? 0) >= 0
                    ? TONE_CLASS.up
                    : TONE_CLASS.down
                }
              >
                {pct(history.changePct)} over {rangeLabel(range)}
              </Badge>
              <Badge variant="outline" className={TONE_CLASS[verdict.tone]}>
                {verdict.text}
              </Badge>
            </div>

            <ChartFrame className="h-64 w-full">
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
                    width={60}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => num(v, 0)}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    formatter={(v: number, name: string) => [num(v), name]}
                  />
                  <Legend wrapperStyle={LEGEND_STYLE} />
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
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>

            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {periods.map((p) => (
                <div
                  key={p}
                  className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2"
                >
                  <dt className="text-muted-foreground">{p}-day avg</dt>
                  <dd className="tabular-nums">{num(history.smaLatest?.[p] ?? null)}</dd>
                </div>
              ))}
              <div className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
                <dt className="text-muted-foreground">Volatility</dt>
                <dd className="tabular-nums">{pct(history.volatilityPct, 0)}</dd>
              </div>
              <div className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
                <dt className="text-muted-foreground">Max fall</dt>
                <dd className="tabular-nums">{pct(history.maxDrawdownPct)}</dd>
              </div>
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}
