// Relative Strength Index pane drawn under the price/SMA chart.
//
// RSI lives on its own 0-100 scale, so it cannot share the price axis. It gets
// a short companion pane aligned to the same dates, with the classic 30/70
// bands shaded as reference lines so oversold/overbought reads at a glance.

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
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
import {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  RSI_PERIOD,
  rsiZone,
  type HistoryPoint,
  type RsiZone,
} from "@/lib/market-symbol-history";
import { DIVERGENCE_TONE, type RsiDivergence } from "@/lib/rsi-divergence-style";
import { RSI_SIGNAL_TONE } from "@/lib/rsi-signal-style";
import type { RsiSignal } from "@/lib/rsi-signals";
import type { TradeMarker } from "@/lib/backtest-trade-markers";
import { tradeMarkerColor } from "@/lib/trade-marker-style";


const ZONE_LABEL: Record<RsiZone, string> = {
  oversold: "Oversold",
  overbought: "Overbought",
  neutral: "Neutral",
};

const ZONE_CLASS: Record<RsiZone, string> = {
  oversold: "border-emerald-500/40 text-emerald-500",
  overbought: "border-destructive/40 text-destructive",
  neutral: "border-border text-muted-foreground",
};

export function RsiBadge({ value }: { value: number | null | undefined }) {
  const zone = rsiZone(value);
  if (zone == null || value == null) return null;
  return (
    <Badge variant="outline" className={ZONE_CLASS[zone]}>
      RSI {value.toFixed(0)} · {ZONE_LABEL[zone]}
    </Badge>
  );
}

export function RsiPane({
  points,
  divergences = [],
  signals = [],
  tradeMarkers = [],
  className,
}: {
  points: HistoryPoint[];
  /** Divergence legs to draw across the RSI line. */
  divergences?: RsiDivergence[];
  /** Oversold/overbought buy/sell markers to pin on the RSI line. */
  signals?: RsiSignal[];
  /** Executed backtest fills to pin on the RSI line. */
  tradeMarkers?: TradeMarker[];
  className?: string;
}) {

  const hasData = points.some((p) => p.rsi14 != null);
  if (!hasData) {
    return (
      <p className="text-xs text-muted-foreground">
        Not enough history yet for a {RSI_PERIOD}-day RSI on this window.
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          RSI ({RSI_PERIOD}) · below {RSI_OVERSOLD} oversold, above {RSI_OVERBOUGHT} overbought
        </p>
        <RsiBadge value={points[points.length - 1]?.rsi14 ?? null} />
      </div>
      <ChartFrame className="h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>

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
              domain={[0, 100]}
              ticks={[0, RSI_OVERSOLD, 50, RSI_OVERBOUGHT, 100]}
            />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              formatter={(v: number) => [v.toFixed(1), `RSI ${RSI_PERIOD}`]}
            />
            <ReferenceLine y={RSI_OVERBOUGHT} stroke={CHART_ROLE.negative} strokeDasharray="4 4" />
            <ReferenceLine y={50} stroke={CHART_ROLE.neutral} strokeDasharray="2 6" />
            <ReferenceLine y={RSI_OVERSOLD} stroke={CHART_ROLE.positive} strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="rsi14"
              name={`RSI ${RSI_PERIOD}`}
              stroke={CHART_ROLE.highlight}
              strokeWidth={1.8}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {signals.map((sig) => (
              <ReferenceDot
                key={`rsi-sig-${sig.kind}-${sig.date}`}
                x={sig.date}
                y={sig.rsi}
                r={4}
                fill={RSI_SIGNAL_TONE[sig.kind]}
                stroke="hsl(var(--background))"
                strokeWidth={1.5}
                isFront
              />
            ))}
            {divergences.map((d) => (
              <ReferenceLine
                key={`rsi-div-${d.kind}-${d.from.date}-${d.to.date}`}
                segment={[
                  { x: d.from.date, y: d.from.rsi },
                  { x: d.to.date, y: d.to.rsi },
                ]}
                stroke={DIVERGENCE_TONE[d.kind]}
                strokeWidth={1.6}
                strokeDasharray="5 3"
                ifOverflow="extendDomain"
              />
            ))}
            {tradeMarkers
              .filter((m) => m.rsi != null)
              .map((m) => (
                <ReferenceDot
                  key={`rsi-trade-${m.key}`}
                  x={m.date}
                  y={m.rsi as number}
                  r={5}
                  fill={m.side === "entry" ? "hsl(var(--background))" : tradeMarkerColor(m)}
                  stroke={tradeMarkerColor(m)}
                  strokeWidth={2}
                  isFront
                  ifOverflow="extendDomain"
                />
              ))}



          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
