import type { TradeMarkerCell } from "@/lib/chart-trade-markers";

/**
 * Buy / sell markers drawn on top of a recharts series.
 *
 * A buy is an upward triangle in the success colour, a sell a downward
 * triangle in the destructive colour, both outlined against the chart
 * background so they stay readable over the gradient fill. Point count is
 * shown as a small badge when several trades landed on the same bar.
 */
export function TradeMarkerShape(props: {
  cx?: number;
  cy?: number;
  side: "buy" | "sell";
  payload?: { marker?: TradeMarkerCell | null };
  /**
   * Half-width of the triangle in px. Deliberately NOT called `size`:
   * recharts injects its own `size` prop (the z-axis area, default 64) into
   * scatter shapes, which blew these markers up to ~64px and buried the
   * series underneath them. Only an explicit value from our own callers
   * changes the marker size.
   */
  markerSize?: number;
}) {
  const { cx, cy, side, payload } = props;
  if (cx == null || cy == null || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const s = Math.max(2, Math.min(6, props.markerSize ?? 3.5));
  const buy = side === "buy";
  const color = buy ? "var(--success)" : "var(--destructive)";
  // Buys sit below the line, sells above it, so a bar with both stays legible.
  const oy = buy ? s + 3 : -(s + 3);

  const y = cy + oy;
  const points = buy
    ? `${cx},${y - s} ${cx - s},${y + s} ${cx + s},${y + s}`
    : `${cx},${y + s} ${cx - s},${y - s} ${cx + s},${y - s}`;
  const count = (buy ? payload?.marker?.buys : payload?.marker?.sells) ?? 0;
  return (
    <g pointerEvents="none">
      <polygon
        points={points}
        fill={color}
        stroke="var(--card)"
        strokeWidth={0.75}
        opacity={0.95}
      />
      {count > 1 && (
        <text
          x={cx + s + 2}
          y={y + (buy ? s : -s)}
          fill={color}
          fontSize={8}
          fontWeight={600}
        >
          {count}
        </text>
      )}
    </g>
  );
}

/** Legend row explaining the markers. */
export function TradeMarkerLegend({ className }: { className?: string }) {
  return (
    <>
      <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
        <svg width="8" height="8" aria-hidden>
          <polygon points="4,0 0,8 8,8" fill="var(--success)" />
        </svg>
        Buy executed
      </span>
      <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
        <svg width="8" height="8" aria-hidden>
          <polygon points="4,8 0,0 8,0" fill="var(--destructive)" />
        </svg>
        Sell executed
      </span>
    </>
  );
}
