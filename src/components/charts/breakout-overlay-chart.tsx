import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_METRIC,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";
import { overlayDomain, type BreakoutOverlay, type OverlaySignal } from "@/lib/breakout-overlay";

/**
 * Price chart with the breakout engine's own geometry drawn on top, so a
 * signal can be checked by eye instead of trusted:
 *
 *   - shaded band  = the rolling Donchian range the detector measured
 *   - solid rule   = the level that broke (breakout above / breakdown below)
 *   - dot          = the signal bar close (the hypothetical entry)
 *   - red / green  = the ATR stop and target
 *   - dashed verticals = signal bar → planned time exit (the expected hold),
 *     with the shaded span between them being the intended holding window
 *   - flag         = where the trade actually came out, and why
 */
export function BreakoutOverlayChart({
  overlay,
  signal,
  formatPrice,
  height = 260,
}: {
  overlay: BreakoutOverlay;
  signal: OverlaySignal | null;
  formatPrice: (n: number) => string;
  height?: number;
}) {
  const domain = useMemo(() => overlayDomain(overlay, signal), [overlay, signal]);
  const points = overlay.points;

  const dateAt = (i: number): string | null => points[i]?.date ?? null;
  const signalDate = signal ? dateAt(signal.index) : null;
  // A planned exit past the end of the data still gets drawn, pinned to the
  // last bar, so an open signal doesn't silently lose its exit marker.
  const plannedExitDate =
    signal &&
    (signal.plannedExitDate ??
      (signal.plannedExitIndex >= points.length ? (points.at(-1)?.date ?? null) : null));
  const exitDate = signal ? (signal.exitDate ?? points.at(-1)?.date ?? null) : null;
  const openEnded = Boolean(signal && signal.plannedExitDate == null);

  const tickFormatter = (d: string) => (typeof d === "string" ? d.slice(5) : String(d));

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="breakout-band" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SAXO_COLOR.reference} stopOpacity={0.16} />
              <stop offset="100%" stopColor={SAXO_COLOR.reference} stopOpacity={0.06} />
            </linearGradient>
          </defs>

          <CartesianGrid {...SAXO_GRID} />
          <XAxis
            dataKey="date"
            {...SAXO_AXIS}
            minTickGap={40}
            tickFormatter={tickFormatter}
            interval="preserveStartEnd"
          />
          <YAxis
            {...SAXO_AXIS}
            domain={domain}
            width={62}
            tickFormatter={(v: number) => formatPrice(v)}
          />

          {/* Intended holding window: signal bar → planned time exit. */}
          {signalDate && plannedExitDate && (
            <ReferenceArea
              x1={signalDate}
              x2={plannedExitDate}
              fill={SAXO_COLOR.crosshairSoft}
              fillOpacity={0.35}
              stroke="none"
              ifOverflow="extendDomain"
            />
          )}

          {/* Donchian range: stacked base (invisible) + span (shaded box). */}
          <Area
            dataKey="bandBase"
            stackId="band"
            stroke="none"
            fill="none"
            isAnimationActive={false}
            connectNulls
          />
          <Area
            dataKey="bandSpan"
            stackId="band"
            stroke={SAXO_COLOR.reference}
            strokeOpacity={0.5}
            strokeDasharray="4 4"
            strokeWidth={SAXO_METRIC.hairlineWidth}
            fill="url(#breakout-band)"
            isAnimationActive={false}
            connectNulls
            name="Donchian range"
          />

          <Line
            type="monotone"
            dataKey="close"
            stroke={SAXO_COLOR.up}
            strokeWidth={SAXO_METRIC.strokeWidth}
            dot={false}
            isAnimationActive={false}
            name="Close"
          />

          {/* The level that broke. */}
          {signal && (
            <ReferenceLine
              y={signal.level}
              stroke={signal.direction === "up" ? SAXO_COLOR.up : SAXO_COLOR.down}
              strokeWidth={SAXO_METRIC.hairlineWidth}
              label={{
                value: `${signal.direction === "up" ? "Breakout" : "Breakdown"} ${formatPrice(signal.level)}`,
                position: "insideTopLeft",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}

          {signal?.target != null && (
            <ReferenceLine
              y={signal.target}
              stroke={SAXO_COLOR.up}
              strokeDasharray="5 4"
              strokeOpacity={0.75}
              label={{
                value: `Target ${formatPrice(signal.target)}`,
                position: "insideBottomRight",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}
          {signal?.stop != null && (
            <ReferenceLine
              y={signal.stop}
              stroke={SAXO_COLOR.down}
              strokeDasharray="5 4"
              strokeOpacity={0.75}
              label={{
                value: `Stop ${formatPrice(signal.stop)}`,
                position: "insideTopRight",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}

          {/* Signal bar and expected-hold exit trigger. */}
          {signalDate && (
            <ReferenceLine
              x={signalDate}
              stroke={SAXO_COLOR.crosshair}
              strokeDasharray="3 3"
              label={{
                value: "Signal",
                position: "top",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}
          {plannedExitDate && (
            <ReferenceLine
              x={plannedExitDate}
              stroke={SAXO_COLOR.crosshair}
              strokeDasharray="3 3"
              label={{
                value: openEnded
                  ? `Exit due +${signal!.plannedExitIndex - signal!.index}b`
                  : `Expected exit (${signal!.plannedExitIndex - signal!.index}b)`,
                position: "top",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}

          {signal && signalDate && (
            <ReferenceDot
              x={signalDate}
              y={signal.entry}
              r={SAXO_METRIC.activeDotRadius}
              fill={signal.side === "long" ? SAXO_COLOR.up : SAXO_COLOR.down}
              stroke={SAXO_COLOR.markerRing}
              strokeWidth={SAXO_METRIC.activeDotRingWidth}
              ifOverflow="extendDomain"
            />
          )}
          {signal && exitDate && signal.barsHeld > 0 && (
            <ReferenceDot
              x={exitDate}
              y={signal.exitPrice}
              r={SAXO_METRIC.dotRadius + 1}
              fill={SAXO_COLOR.tooltip}
              stroke={signal.returnPct >= 0 ? SAXO_COLOR.up : SAXO_COLOR.down}
              strokeWidth={SAXO_METRIC.activeDotRingWidth}
              ifOverflow="extendDomain"
              label={{
                value: `${signal.exitReason} ${signal.returnPct >= 0 ? "+" : ""}${signal.returnPct.toFixed(1)}%`,
                position: "right",
                fill: SAXO_COLOR.axis,
                fontSize: SAXO_METRIC.tickFontSize,
              }}
            />
          )}

          <Tooltip
            contentStyle={SAXO_TOOLTIP_CONTENT}
            labelStyle={SAXO_TOOLTIP_LABEL}
            cursor={SAXO_TOOLTIP_CURSOR}
            formatter={(value: unknown, name: string, item: { payload?: Record<string, unknown> }) => {
              if (name === "Donchian range") {
                const p = item?.payload ?? {};
                const lo = p["channelLow"] as number | null;
                const hi = p["channelHigh"] as number | null;
                if (lo == null || hi == null) return ["—", "Donchian range"];
                return [`${formatPrice(lo)} – ${formatPrice(hi)}`, "Donchian range"];
              }
              return [formatPrice(Number(value)), name];
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
