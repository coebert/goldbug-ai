// Home-dashboard SMA card: up to four markets shown side by side, each with
// price plus a chosen set of moving averages (20/50/100/200-day) over a
// selectable window. Same data path as the drill-down page
// (`getSymbolHistory`), so the two never disagree.

import { useEffect, useMemo, useState } from "react";
import { useQueries, keepPreviousData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, LineChart as LineChartIcon, Plus, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSymbolHistory } from "@/lib/market-symbol-history.functions";
import {
  DEFAULT_RANGE,
  HISTORY_RANGES,
  HISTORY_SYMBOLS,
  coerceRange,
  isKnownSymbol,
  rangeLabel,
  symbolMeta,
  type HistoryRange,
  type SmaPeriod,
  type SymbolHistory,
} from "@/lib/market-symbol-history";
import {
  DEFAULT_SMA_PERIODS,
  MAX_SMA_SYMBOLS,
  SMA_FAVORITES_KEY,
  SMA_SYMBOLS_KEY,
  TREND_FILTER_KEY,
  TREND_SIGNIFICANT_SCORE,
  TREND_SORT_KEY,
  parseSmaFavorites,
  parseSmaSymbols,
  parseTrendFilter,
  parseTrendSort,
  rankByTrendStrength,
  readStoredSmaPeriods,
  readStoredTrendBasis,
  resolveTrendBasis,
  storeTrendBasis,
  type TrendBasis,
  type TrendFilter,
  type TrendSort,
  storeSmaFavorites,
  storeSmaPeriods,
  toggleSmaFavorite,
  toggleSmaPeriod,
  toggleSmaSymbol,
} from "@/lib/sma-display";
import { computeTrendStrength } from "@/lib/market-symbol-history";
import { SmaPeriodToggles } from "@/components/market/sma-period-toggles";
import { TrendBasisSelect } from "@/components/market/trend-basis-select";
import { SmaTrendPanel } from "@/components/home/sma-trend-panel";

const LEGACY_SYMBOL_KEY = "home-sma-symbol";
const RANGE_KEY = "home-sma-range";
const DEFAULT_SYMBOL = HISTORY_SYMBOLS.includes("SPY") ? "SPY" : (HISTORY_SYMBOLS[0] ?? "");

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
  const [symbols, setSymbols] = useState<string[]>([DEFAULT_SYMBOL]);
  const [range, setRange] = useState<HistoryRange>(DEFAULT_RANGE);
  const [periods, setPeriods] = useState<SmaPeriod[]>(DEFAULT_SMA_PERIODS);
  const [trendBasis, setTrendBasis] = useState<TrendBasis>("auto");
  const [sort, setSort] = useState<TrendSort>("selection");
  const [filter, setFilter] = useState<TrendFilter>("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const fetchHistory = useServerFn(getSymbolHistory);

  // Restore the last view after hydration so SSR markup stays stable.
  useEffect(() => {
    try {
      const stored = parseSmaSymbols(
        window.localStorage.getItem(SMA_SYMBOLS_KEY),
        isKnownSymbol,
      );
      if (stored.length) setSymbols(stored);
      else {
        const legacy = window.localStorage.getItem(LEGACY_SYMBOL_KEY);
        if (legacy && isKnownSymbol(legacy)) setSymbols([legacy]);
      }
      const r = window.localStorage.getItem(RANGE_KEY);
      if (r) setRange(coerceRange(Number(r)));
      setPeriods(readStoredSmaPeriods());
      setTrendBasis(readStoredTrendBasis());
      setSort(parseTrendSort(window.localStorage.getItem(TREND_SORT_KEY)));
      setFilter(parseTrendFilter(window.localStorage.getItem(TREND_FILTER_KEY)));
      setFavorites(
        parseSmaFavorites(window.localStorage.getItem(SMA_FAVORITES_KEY), isKnownSymbol),
      );
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }, []);

  const applySymbols = (next: string[]) => {
    setSymbols(next);
    try {
      window.localStorage.setItem(SMA_SYMBOLS_KEY, next.join(","));
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
      const final = toggleSmaPeriod(prev, p);
      storeSmaPeriods(final);
      return final;
    });
  };

  const pickTrendBasis = (b: TrendBasis) => {
    setTrendBasis(b);
    storeTrendBasis(b);
  };

  const toggleFavorite = (symbol: string) => {
    setFavorites((prev) => {
      const next = toggleSmaFavorite(prev, symbol);
      storeSmaFavorites(next);
      return next;
    });
  };

  const pickSort = (s: TrendSort) => {
    setSort(s);
    try {
      window.localStorage.setItem(TREND_SORT_KEY, s);
    } catch {
      /* ignore */
    }
  };

  const pickFilter = (f: TrendFilter) => {
    setFilter(f);
    try {
      window.localStorage.setItem(TREND_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const queries = useQueries({
    queries: symbols.map((s) => ({
      queryKey: ["symbol-history", s, range],
      queryFn: () => fetchHistory({ data: { symbol: s, days: range } }),
      enabled: Boolean(s),
      staleTime: 5 * 60_000,
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: false,
    })),
  });

  const { markets, sectors } = useMemo(groupedSymbols, []);
  const periodsLabel = periods.join("/");
  const compact = symbols.length > 1;
  const atCap = symbols.length >= MAX_SMA_SYMBOLS;
  const asOf = queries
    .map((q) => (q.data as SymbolHistory | undefined)?.asOf ?? null)
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();

  // Score every selected market on the same basis the panels display, then
  // rank/filter. Panels keep rendering their own strength; this only reorders.
  const basis = resolveTrendBasis(trendBasis, periods);
  const entries = symbols.map((s, i) => {
    const history = queries[i]?.data as SymbolHistory | undefined;
    const strength = history ? computeTrendStrength(history.points, periods, basis) : null;
    return {
      symbol: s,
      index: i,
      score: strength ? strength.score : null,
      favorite: favorites.includes(s),
      slope: strength ? strength.slopeAnnualPct : null,
      volatility: strength ? strength.volatilityPct : null,
    };
  });
  const visible = rankByTrendStrength(entries, sort, filter);
  const hidden = entries.length - visible.length;

  const renderOption = (s: string) => {
    const on = symbols.includes(s);
    return (
      <DropdownMenuItem
        key={s}
        className="text-xs"
        disabled={!on && atCap}
        onSelect={(e) => {
          e.preventDefault();
          applySymbols(toggleSmaSymbol(symbols, s));
        }}
      >
        <Check className={`mr-2 h-3.5 w-3.5 ${on ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
        {symbolMeta(s)?.label ?? s}
      </DropdownMenuItem>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5 text-base">
            <LineChartIcon className="h-4 w-4 text-primary" aria-hidden="true" /> Moving-average
            trend
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {symbols.length === 1 ? "One market" : `${symbols.length} markets`} against their{" "}
            {periodsLabel}-day average{periods.length > 1 ? "s" : ""}
            {asOf ? ` · prices to ${asOf}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs">
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Markets ({symbols.length}/{MAX_SMA_SYMBOLS})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Markets</DropdownMenuLabel>
              {markets.map(renderOption)}
              {sectors.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs">US sectors</DropdownMenuLabel>
                  {sectors.map(renderOption)}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex flex-wrap gap-1">
            {symbols.map((s) => {
              const pinned = favorites.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={pinned}
                  aria-label={`${pinned ? "Unpin" : "Pin"} ${symbolMeta(s)?.label ?? s}`}
                  onClick={() => toggleFavorite(s)}
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-normal transition-colors ${
                    pinned ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Star
                    className={`mr-1 h-3 w-3 ${pinned ? "fill-primary text-primary" : ""}`}
                    aria-hidden="true"
                  />
                  {symbolMeta(s)?.label ?? s}
                </button>
              );
            })}
          </div>

          <SmaPeriodToggles periods={periods} onToggle={togglePeriod} />

          <TrendBasisSelect basis={trendBasis} periods={periods} onChange={pickTrendBasis} />

          <div className="flex flex-wrap gap-1" role="group" aria-label="Sort by trend strength">
            {(
              [
                ["selection", "My order"],
                ["strongest", "Strongest"],
                ["weakest", "Weakest"],
                ["slope-desc", "Slope ↓"],
                ["slope-asc", "Slope ↑"],
                ["vol-desc", "Vol ↓"],
                ["vol-asc", "Vol ↑"],
              ] as [TrendSort, string][]
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={value === sort ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                aria-pressed={value === sort}
                onClick={() => pickSort(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by trend strength">
            {(
              [
                ["all", "All"],
                ["up", "Up"],
                ["down", "Down"],
                ["significant", `|score| ≥ ${TREND_SIGNIFICANT_SCORE}`],
              ] as [TrendFilter, string][]
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={value === filter ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                aria-pressed={value === filter}
                onClick={() => pickFilter(value)}
              >
                {label}
              </Button>
            ))}
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

      <CardContent>
        {hidden > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            {hidden} market{hidden > 1 ? "s" : ""} hidden by the trend filter.
          </p>
        )}
        <div className={compact ? "grid gap-3 lg:grid-cols-2" : "space-y-3"}>
          {visible.map(({ symbol: s, index: i }) => {
            const q = queries[i];
            return (
              <SmaTrendPanel
                key={s}
                symbol={s}
                range={range}
                periods={periods}
                trendBasis={trendBasis}
                history={q?.data as SymbolHistory | undefined}
                loading={Boolean(q?.isLoading)}
                error={Boolean(q?.isError)}
                compact={compact}
                onRetry={() => void q?.refetch()}
                onRemove={
                  symbols.length > 1
                    ? () => applySymbols(toggleSmaSymbol(symbols, s))
                    : undefined
                }
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
