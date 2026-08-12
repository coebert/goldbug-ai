// Multi-symbol overlay for the market drill-down page: rebased performance
// lines plus a side-by-side range-change table.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Layers, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  LEGEND_STYLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  RSI_PERIOD,
} from "@/lib/market-symbol-history";
import { CHART_ROLE } from "@/lib/chart-palette";
import { CorrelationHeatmap } from "@/components/market/correlation-heatmap";
import { RollingCorrelationPanel } from "@/components/market/rolling-correlation-panel";
import {
  MAX_COMPARE_SYMBOLS,
  comparePriceKey,
  compareRsiKey,
  compareSmaPriceKey,
  type Comparison,
  type RollingWindow,
} from "@/lib/market-compare";
import {
  isChartableSymbol,
  normaliseSymbolInput,
  rangeLabel,
  symbolMeta,
  type HistoryRange,
  type SmaPeriod,
} from "@/lib/market-symbol-history";

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function toneClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "";
  return v >= 0 ? "text-emerald-500" : "text-destructive";
}

export interface CompareOverlayProps {
  symbol: string;
  range: HistoryRange;
  /** Symbols currently overlaid (excluding the page's own symbol). */
  compare: string[];
  /** Every symbol that can be added. */
  options: string[];
  comparison: Comparison;
  /** Moving-average periods available to overlay on every compared symbol. */
  periods: SmaPeriod[];
  loading: boolean;
  onToggle: (symbol: string) => void;
  onClear: () => void;
}

export function CompareOverlay({
  symbol,
  range,
  compare,
  options,
  comparison,
  periods,
  loading,
  onToggle,
  onClear,
}: CompareOverlayProps) {
  const [showSma, setShowSma] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  // "rebased" = every series indexed to 100 at the window start (shared axis).
  // "price" = each symbol drawn on its own true price scale (per-symbol axis).
  // "return" = each ticker's % return from the window start (0-based).
  const [scaleMode, setScaleMode] = useState<"return" | "rebased" | "price">("rebased");
  const priceScale = scaleMode === "price";
  const returnScale = scaleMode === "return";
  // Relative-performance readings: value - 100 for the rebased series.
  const relKey = (key: string) => (row: Record<string, unknown>) => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? Number((v - 100).toFixed(3)) : null;
  };
  const [ticker, setTicker] = useState("");
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [rollingWindow, setRollingWindow] = useState<RollingWindow>(() => {
    if (typeof window === "undefined") return 30;
    const saved = Number(window.localStorage.getItem("market.rollingCorrWindow"));
    return saved === 30 || saved === 60 || saved === 90 ? saved : 30;
  });

  const changeRollingWindow = (w: RollingWindow) => {
    setRollingWindow(w);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("market.rollingCorrWindow", String(w));
    }
  };

  const addable = options.filter((s) => s !== symbol && !compare.includes(s));
  const full = compare.length >= MAX_COMPARE_SYMBOLS;

  const addTicker = (e: React.FormEvent) => {
    e.preventDefault();
    const next = normaliseSymbolInput(ticker);
    if (!isChartableSymbol(next)) {
      setTickerError("Enter a ticker like AAPL, MKS.L, ^FTSE or BTC-USD.");
      return;
    }
    if (next === symbol || compare.includes(next)) {
      setTickerError("That symbol is already on the chart.");
      return;
    }
    setTickerError(null);
    setTicker("");
    onToggle(next);
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Layers className="h-4 w-4 text-primary" aria-hidden="true" /> Compare with other markets
        </h2>
        {compare.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>

      {compare.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {compare.map((s) => (
            <Badge
              key={s}
              variant="secondary"
              className="cursor-pointer gap-1 pr-1.5"
              onClick={() => onToggle(s)}
            >
              {symbolMeta(s)?.label ?? s}
              <X className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Remove {symbolMeta(s)?.label ?? s}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {addable.map((s) => (
          <Button
            key={s}
            size="sm"
            variant="outline"
            disabled={full}
            className="h-7 px-2 text-xs"
            onClick={() => onToggle(s)}
          >
            + {symbolMeta(s)?.label ?? s}
          </Button>
        ))}
      </div>

      <form onSubmit={addTicker} className="flex flex-wrap items-center gap-2">
        <Input
          value={ticker}
          onChange={(e) => {
            setTicker(e.target.value);
            if (tickerError) setTickerError(null);
          }}
          disabled={full}
          aria-label="Add any ticker to the comparison"
          placeholder="Add any ticker — AAPL, MKS.L, BTC-USD"
          className="h-8 w-full max-w-[16rem] text-xs uppercase placeholder:normal-case"
        />
        <Button type="submit" size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={full}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Add
        </Button>
        {periods.length > 0 && compare.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant={showSma ? "default" : "outline"}
            className="h-8 px-2 text-xs"
            aria-pressed={showSma}
            onClick={() => setShowSma((v) => !v)}
          >
            {showSma ? "Hide" : "Show"} SMA {periods.join("/")}
          </Button>
        )}
        {compare.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant={showRsi ? "default" : "outline"}
            className="h-8 px-2 text-xs"
            aria-pressed={showRsi}
            onClick={() => setShowRsi((v) => !v)}
          >
            {showRsi ? "Hide" : "Show"} RSI
          </Button>
        )}
        {compare.length > 0 && (
          <div className="inline-flex overflow-hidden rounded-md border border-border/60" role="group" aria-label="Chart scale">
            {(["return", "rebased", "price"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={scaleMode === m}
                onClick={() => setScaleMode(m)}
                className={`h-8 px-2 text-xs transition-colors ${
                  scaleMode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "return" ? "Return %" : m === "rebased" ? "Rebased 100" : "Price scale"}
              </button>
            ))}
          </div>
        )}
      </form>
      {compare.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {priceScale
            ? "Each symbol is drawn on its own true price scale, so lines show actual levels rather than relative performance."
            : returnScale
              ? "Every ticker (and its SMA overlays) is plotted as % return from the start of the window, so 0% is the common baseline."
              : "All symbols share a 100-based index at the window start, so lines compare performance directly."}
        </p>
      )}
      {tickerError && <p className="text-[11px] text-destructive">{tickerError}</p>}

      {full && (
        <p className="text-[11px] text-muted-foreground">
          Up to {MAX_COMPARE_SYMBOLS} overlays at a time — remove one to add another.
        </p>
      )}

      {compare.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pick one or more markets to overlay. Every line is rebased to 100 at the start of the
          shared window, so you're comparing performance rather than price levels.
        </p>
      ) : loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : comparison.points.length < 2 ? (
        <p className="text-xs text-muted-foreground">
          These markets don't have enough overlapping price history to compare over {rangeLabel(range)}.
        </p>
      ) : (
        <>
          <ChartFrame className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={comparison.points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                  minTickGap={40}
                  tickFormatter={(d: string) => d.slice(2, 7)}
                />
                {priceScale ? (
                  comparison.series.map((s, i) => (
                    <YAxis
                      key={s.symbol}
                      yAxisId={s.symbol}
                      orientation={i === 0 ? "left" : "right"}
                      hide={i > 1}
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                      width={54}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) =>
                        Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)
                      }
                    />
                  ))
                ) : (
                  <YAxis
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                    width={54}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => `${(returnScale ? v : v - 100).toFixed(0)}%`}
                  />
                )}
                {returnScale && <ReferenceLine y={0} {...AXIS_LINE} strokeDasharray="3 3" />}
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  formatter={(v: number, name: string) => [
                    priceScale
                      ? Math.abs(v) >= 1000
                        ? v.toFixed(0)
                        : v.toFixed(2)
                      : pct(returnScale ? v : v - 100),
                    name,
                  ]}
                />
                <Legend wrapperStyle={LEGEND_STYLE} />
                {comparison.series.map((s) => (
                  <Line
                    key={s.symbol}
                    type="monotone"
                    dataKey={
                      priceScale
                        ? comparePriceKey(s.symbol)
                        : returnScale
                          ? relKey(s.symbol)
                          : s.symbol
                    }
                    {...(priceScale ? { yAxisId: s.symbol } : {})}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={s.symbol === symbol ? 2.5 : 1.75}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
                {showSma &&
                  comparison.smaSeries.map((s) => (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={
                        priceScale
                          ? compareSmaPriceKey(s.symbol, s.period)
                          : returnScale
                            ? relKey(s.key)
                            : s.key
                      }
                      {...(priceScale ? { yAxisId: s.symbol } : {})}
                      name={s.label}
                      stroke={s.color}
                      strokeWidth={1}
                      strokeDasharray={s.period >= 100 ? "2 4" : "5 3"}
                      strokeOpacity={0.75}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                      legendType="plainline"
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>

          {showRsi && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                RSI ({RSI_PERIOD}) · below {RSI_OVERSOLD} oversold, above {RSI_OVERBOUGHT} overbought
              </p>
              <ChartFrame className="h-36 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparison.points} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
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
                      width={44}
                      domain={[0, 100]}
                      ticks={[0, RSI_OVERSOLD, 50, RSI_OVERBOUGHT, 100]}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_CONTENT_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      formatter={(v: number, name: string) => [v.toFixed(1), name]}
                    />
                    <ReferenceLine y={RSI_OVERBOUGHT} stroke={CHART_ROLE.negative} strokeDasharray="4 4" />
                    <ReferenceLine y={RSI_OVERSOLD} stroke={CHART_ROLE.positive} strokeDasharray="4 4" />
                    {comparison.series.map((s) => (
                      <Line
                        key={`rsi-${s.symbol}`}
                        type="monotone"
                        dataKey={compareRsiKey(s.symbol)}
                        name={`${s.label} RSI`}
                        stroke={s.color}
                        strokeWidth={s.symbol === symbol ? 2 : 1.4}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">
                Performance comparison from {comparison.from} to {comparison.to}
              </caption>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">Market</th>
                  <th className="py-1.5 text-right font-medium">Change</th>
                  <th className="py-1.5 text-right font-medium">Best</th>
                  <th className="py-1.5 text-right font-medium">Worst</th>
                  <th className="py-1.5 text-right font-medium">Vol</th>
                </tr>
              </thead>
              <tbody>
                {comparison.series.map((s) => (
                  <tr key={s.symbol} className="border-t border-border/50">
                    <td className="py-1.5">
                      <Link
                        to="/market/$symbol"
                        params={{ symbol: s.symbol }}
                        search={{ range, compare: undefined }}
                        className="inline-flex items-center gap-2 hover:underline"
                      >
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: s.color }}
                        />
                        <span className="truncate">{s.label}</span>
                      </Link>
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${toneClass(s.changePct)}`}>
                      {pct(s.changePct)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.peakPct)}</td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.troughPct)}</td>
                    <td className="py-1.5 text-right tabular-nums">{pct(s.volatilityPct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <CorrelationHeatmap
            correlation={comparison.correlation}
            from={comparison.from}
            to={comparison.to}
          />

          <RollingCorrelationPanel
            comparison={comparison}
            window={rollingWindow}
            onWindowChange={changeRollingWindow}
          />

          <p className="text-[11px] text-muted-foreground">
            Shared window {comparison.from} → {comparison.to}. Best/worst are the highest and lowest
            points reached against that start, so they can differ from the end change.
          </p>
        </>
      )}
    </section>
  );
}
