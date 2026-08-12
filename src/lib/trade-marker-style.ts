// Shared colours for backtest trade markers so the price chart, the RSI pane
// and the trade lists all agree on what a fill looks like.

import { CHART_ROLE } from "./chart-palette";
import type { TradeMarker, TradeLeg } from "./backtest-trade-markers";

export function tradeMarkerColor(m: TradeMarker): string {
  if (m.side === "entry") {
    return m.direction === "long" ? CHART_ROLE.positive : CHART_ROLE.negative;
  }
  if (m.tone === "positive") return CHART_ROLE.positive;
  if (m.tone === "negative") return CHART_ROLE.negative;
  return CHART_ROLE.neutral;
}

export function tradeLegColor(leg: TradeLeg): string {
  return leg.netReturn >= 0 ? CHART_ROLE.positive : CHART_ROLE.negative;
}
