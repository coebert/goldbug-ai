// Shared chart axis sizing.
//
// A 64px Y axis eats ~18% of a 360px phone screen, squeezing the plot area.
// Phones get a 46px axis (and abbreviated ticks); desktop keeps the roomier
// default so long currency values stay readable.

import { useIsMobile } from "@/hooks/use-mobile";

export const Y_AXIS_WIDTH_DESKTOP = 64;
// 46px is the readability floor enforced by chart-axis-readability.test.ts:
// narrower than that and wide currency ticks clip.
export const Y_AXIS_WIDTH_MOBILE = 46;

/** Y-axis width in px, narrowed on phone-sized viewports. */
export function useYAxisWidth(desktop: number = Y_AXIS_WIDTH_DESKTOP): number {
  const isMobile = useIsMobile();
  return isMobile ? Y_AXIS_WIDTH_MOBILE : desktop;
}

/** Compact numeric tick label (1.2k / 3.4M) for narrow axes. */
export function compactTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return v.toFixed(0);
  return v.toFixed(2);
}

/**
 * One shared mobile chart preset, so charts stop hand-rolling `isMobile`
 * branches: tighter margins, a wider tick gap (fewer labels), and the
 * narrowed y-axis from `useYAxisWidth`.
 */
export type ChartPreset = {
  isMobile: boolean;
  margin: { top: number; right: number; bottom: number; left: number };
  yWidth: number;
  minTickGap: number;
  tickFontSize: number;
};

export function useChartPreset(desktopYWidth: number = Y_AXIS_WIDTH_DESKTOP): ChartPreset {
  const isMobile = useIsMobile();
  return {
    isMobile,
    margin: isMobile
      ? { top: 8, right: 6, bottom: 20, left: -8 }
      : { top: 8, right: 12, bottom: 20, left: 8 },
    yWidth: isMobile ? Y_AXIS_WIDTH_MOBILE : desktopYWidth,
    minTickGap: isMobile ? 56 : 30,
    tickFontSize: isMobile ? 11 : 12,
  };
}
