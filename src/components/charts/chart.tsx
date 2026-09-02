import type { ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import { ChartFrame } from "@/components/chart-frame";
import { useIsMobile } from "@/hooks/use-mobile";
import { SAXO_GRID, SAXO_TICK } from "@/lib/saxo-chart";

/**
 * One chart wrapper for the whole app.
 *
 * Charts used to differ in height, margins, tick density, legend
 * placement and empty state, so two panels showing the same shape
 * looked like different instruments. This fixes the geometry in one
 * place and exposes a single mobile preset instead of per-chart
 * `isMobile` branching.
 */
export type ChartSize = "sm" | "md" | "lg";

const HEIGHT: Record<ChartSize, { mobile: number; desktop: number }> = {
  sm: { mobile: 140, desktop: 180 },
  md: { mobile: 200, desktop: 280 },
  lg: { mobile: 260, desktop: 380 },
};

/** Shared axis/grid/margin preset. Mobile drops chrome, never data. */
export function useChartPreset(size: ChartSize = "md") {
  const isMobile = useIsMobile();
  return {
    isMobile,
    height: isMobile ? HEIGHT[size].mobile : HEIGHT[size].desktop,
    margin: isMobile
      ? { top: 8, right: 8, bottom: 4, left: 0 }
      : { top: 12, right: 16, bottom: 8, left: 8 },
    /** Spread onto <XAxis>/<YAxis>. */
    axis: {
      tick: SAXO_TICK,
      tickLine: false,
      axisLine: false,
      minTickGap: isMobile ? 28 : 16,
    },
    /** Spread onto <CartesianGrid>. */
    grid: SAXO_GRID,
    /** Hide axis titles and secondary series labels on phones. */
    showAxisTitles: !isMobile,
    tickCount: isMobile ? 4 : 6,
  } as const;
}

export function Chart({
  size = "md",
  children,
  loading = false,
  empty = false,
  emptyLabel = "No data for this period yet.",
  caption,
  className = "",
}: {
  size?: ChartSize;
  /** A single Recharts chart element. */
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyLabel?: string;
  /** Short line under the chart explaining what it shows. */
  caption?: ReactNode;
  className?: string;
}) {
  const { height } = useChartPreset(size);

  if (loading) {
    return (
      <div
        className={`skeleton-shimmer w-full ${className}`}
        style={{ height }}
        aria-busy="true"
        aria-label="Loading chart"
      />
    );
  }

  if (empty) {
    return (
      <div
        className={`grid w-full place-items-center rounded-xl bg-surface-sunken px-4 text-center text-xs text-muted-foreground ${className}`}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <figure className={`m-0 w-full min-w-0 ${className}`}>
      <ChartFrame style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as never}
        </ResponsiveContainer>
      </ChartFrame>
      {caption && (
        <figcaption className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
