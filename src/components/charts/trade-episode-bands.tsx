import { ReferenceArea } from "recharts";
import type { ReactElement } from "react";

import { formatHoldingDuration, type EpisodeBand } from "@/lib/trade-episodes";

/**
 * Holding-period shading for a recharts chart.
 *
 * Each band spans from the fill that opened a position to the fill that closed
 * it, so the chart shows not just *when* trades happened but how long the
 * exposure lasted. Bands are deliberately faint and per-symbol coloured: they
 * sit behind the series, several may overlap, and they must never compete with
 * the curve for attention.
 *
 * Returned as an array of elements rather than a component, because recharts
 * only honours `ReferenceArea` when it is a direct child of the chart.
 */

/** Widely spaced hues so adjacent symbols never read as the same band. */
const BAND_HUES = [199, 47, 275, 152, 15, 320, 96, 228, 355, 178, 265, 32];

export function episodeBandHue(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return BAND_HUES[h % BAND_HUES.length]!;
}

export type EpisodeBandOptions = {
  /** Axis the band should attach to (charts here use explicit y-axis ids). */
  yAxisId?: string;
  /** Draw the "SYM 12d" caption at the top of each band. */
  labels?: boolean;
  /** Base fill opacity; overlaps naturally read darker. */
  opacity?: number;
  /**
   * Band key to spotlight (see `EpisodeBand.key`). The selected band keeps its
   * colour and gains a solid outline; every other band fades back so the
   * highlighted holding period is unmistakable.
   */
  selectedKey?: string | null;
};

export function renderEpisodeBands(
  bands: readonly EpisodeBand[],
  options: EpisodeBandOptions = {},
): ReactElement[] {
  const { yAxisId, labels = true, opacity = 0.1, selectedKey = null } = options;
  const hasSelection = selectedKey != null && bands.some((b) => b.key === selectedKey);
  return bands.map((b) => {
    const hue = episodeBandHue(b.symbol);
    const colour = `hsl(${hue} 80% 60%)`;
    const selected = hasSelection && b.key === selectedKey;
    const dim = hasSelection && !selected;
    const baseOpacity = b.episode.open ? opacity * 0.7 : opacity;
    return (
      <ReferenceArea
        key={`ep-${b.key}`}
        {...(yAxisId ? { yAxisId } : {})}
        x1={b.x1}
        x2={b.x2}
        ifOverflow="hidden"
        fill={colour}
        fillOpacity={selected ? Math.min(0.42, baseOpacity * 3.2) : dim ? baseOpacity * 0.35 : baseOpacity}
        stroke={colour}
        strokeOpacity={selected ? 0.95 : dim ? 0.12 : 0.35}
        strokeWidth={selected ? 1.5 : 1}
        strokeDasharray={b.episode.open && !selected ? "3 3" : undefined}
        {...(labels || selected
          ? {
              label: {
                value: `${b.symbol} ${formatHoldingDuration(b.episode.days)}`,
                position: "insideTopLeft" as const,
                fill: colour,
                fontSize: selected ? 10 : 9,
                offset: 4,
              },
            }
          : {})}
      />
    );
  });
}

/** Legend row explaining the shading. */
export function EpisodeBandLegend({ count }: { count?: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-2.5 w-4 rounded-sm border border-foreground/30 bg-foreground/15"
        aria-hidden
      />
      Holding period{count != null && count > 0 ? ` (${count})` : ""}
    </span>
  );
}
