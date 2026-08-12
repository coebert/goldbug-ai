// Shared colour + label helpers for RSI divergence overlays, so the price
// chart and the RSI pane always agree on tone.

import { CHART_ROLE } from "./chart-palette";
import type { DivergenceKind } from "./rsi-divergence";

export type { DivergenceKind, RsiDivergence } from "./rsi-divergence";

export const DIVERGENCE_TONE: Record<DivergenceKind, string> = {
  bullish: CHART_ROLE.positive,
  bearish: CHART_ROLE.negative,
};

export const DIVERGENCE_LABEL: Record<DivergenceKind, string> = {
  bullish: "Bullish divergence",
  bearish: "Bearish divergence",
};
