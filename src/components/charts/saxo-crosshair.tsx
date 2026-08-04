/**
 * Saxo-style hover crosshair and point highlight.
 *
 * The Saxo app draws a full-height vertical rule at the hovered date plus a
 * ringed marker on the curve, so you can read an exact value at any point
 * without hunting for the nearest gridline. Recharts' default cursor is just
 * a faint line and its default active dot is a plain filled circle, neither of
 * which registers on a dense mobile series.
 *
 * Usage on any cartesian chart:
 *   <Tooltip cursor={<SaxoCrosshair />} ... />
 *   <Area activeDot={<SaxoActiveDot color="var(--primary)" />} ... />
 */

type CursorProps = {
  /** Recharts passes the two endpoints of the cursor line. */
  points?: Array<{ x: number; y: number }>;
  /** Plot height and top offset of the drawing area. */
  height?: number;
  top?: number;
  /** Y coordinate of the hovered data point, when recharts can resolve it. */
  activeCoordinate?: { x: number; y: number };
};

export function SaxoCrosshair(props: CursorProps) {
  const { points, height, top, activeCoordinate } = props;
  const x = points?.[0]?.x ?? activeCoordinate?.x;
  if (!Number.isFinite(x)) return null;

  const y1 = Number.isFinite(top) ? (top as number) : (points?.[0]?.y ?? 0);
  const y2 = Number.isFinite(height)
    ? y1 + (height as number)
    : (points?.[1]?.y ?? y1);

  return (
    <g pointerEvents="none">
      {/* Vertical rule at the hovered date. */}
      <line
        x1={x}
        x2={x}
        y1={y1}
        y2={y2}
        stroke="color-mix(in oklab, var(--foreground) 45%, transparent)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      {/* Horizontal rule at the hovered value, so the y-axis can be read off
          directly instead of eyeballed between gridlines. */}
      {activeCoordinate && Number.isFinite(activeCoordinate.y) ? (
        <line
          x1={(points?.[0]?.x ?? x) - 10_000}
          x2={(points?.[0]?.x ?? x) + 10_000}
          y1={activeCoordinate.y}
          y2={activeCoordinate.y}
          stroke="color-mix(in oklab, var(--foreground) 22%, transparent)"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
      ) : null}
    </g>
  );
}

type ActiveDotProps = {
  cx?: number;
  cy?: number;
  color?: string;
  /** Recharts injects the series stroke when no explicit colour is given. */
  stroke?: string;
};

/** Ringed marker: solid core in the series colour inside a soft halo. */
export function SaxoActiveDot({ cx, cy, color, stroke }: ActiveDotProps) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const fill = color ?? stroke ?? "var(--primary)";
  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={7} fill={fill} opacity={0.18} />
      <circle
        cx={cx}
        cy={cy}
        r={3.5}
        fill={fill}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    </g>
  );
}
