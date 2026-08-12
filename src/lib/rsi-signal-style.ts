// Shared colours for the RSI zone buy/sell markers, so the price chart and
// the RSI pane stay in agreement.

import { CHART_ROLE } from "./chart-palette";
import type { RsiSignalKind } from "./rsi-signals";

export const RSI_SIGNAL_TONE: Record<RsiSignalKind, string> = {
  buy: CHART_ROLE.positive,
  sell: CHART_ROLE.negative,
};
