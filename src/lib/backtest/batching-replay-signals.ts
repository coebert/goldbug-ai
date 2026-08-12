// Deterministic signal generator for the order-batching A/B replay.
//
// The A/B test needs a signal stream that LOOKS like what the live engine
// produces: frequent, modestly-sized, momentum-driven adds in a handful of
// names, plus exits when trend breaks. It does not need to be the live alpha
// stack — the point of the experiment is to hold the signals constant and
// vary only the batching window, so any reasonable, reproducible stream works.
//
// Rule (deliberately simple and fully deterministic):
//   - trend = fast SMA above slow SMA and price above the fast SMA
//   - while trend holds, emit a small add each bar, sized as a % of NAV and
//     scaled by how far price sits above the slow SMA (a conviction proxy)
//   - when trend breaks, emit a full exit for that name
//   - never more than `maxAddsPerName` adds in a single trend leg

import type { BacktestBar } from "../backtest-runner";
import type { BatchingSignal } from "./order-batching-ab";

export type ReplaySignalConfig = {
  navBase: number;
  /** Add size per bar as a fraction of NAV (0.009 = 0.9% of NAV). */
  addPctOfNav: number;
  fastPeriod: number;
  slowPeriod: number;
  maxAddsPerName: number;
  /** Asset class per symbol, used for stamp-duty modelling. */
  assetClass?: Record<string, string>;
};

export const DEFAULT_REPLAY_SIGNALS: Omit<ReplaySignalConfig, "navBase"> = {
  addPctOfNav: 0.009,
  fastPeriod: 20,
  slowPeriod: 50,
  maxAddsPerName: 8,
};

function sma(series: readonly number[], period: number): number | null {
  if (series.length < period) return null;
  let s = 0;
  for (let i = series.length - period; i < series.length; i++) s += series[i];
  return s / period;
}

export function generateReplaySignals(
  bars: BacktestBar[],
  config: ReplaySignalConfig,
): BatchingSignal[] {
  const cfg = { ...DEFAULT_REPLAY_SIGNALS, ...config };
  const history: Record<string, number[]> = {};
  const legAdds: Record<string, number> = {};
  const inTrend: Record<string, boolean> = {};
  const out: BatchingSignal[] = [];
  const nav = Math.max(0, Number(cfg.navBase) || 0);

  for (const bar of bars) {
    for (const [symbol, close] of Object.entries(bar.closes)) {
      if (!Number.isFinite(close) || close <= 0) continue;
      const series = (history[symbol] ??= []);
      series.push(close);

      const fast = sma(series, cfg.fastPeriod);
      const slow = sma(series, cfg.slowPeriod);
      if (fast == null || slow == null || !(slow > 0)) continue;

      const trending = fast > slow && close > fast;
      const assetClass = cfg.assetClass?.[symbol] ?? null;

      if (trending) {
        if (!inTrend[symbol]) {
          inTrend[symbol] = true;
          legAdds[symbol] = 0;
        }
        if ((legAdds[symbol] ?? 0) >= cfg.maxAddsPerName) continue;
        legAdds[symbol] = (legAdds[symbol] ?? 0) + 1;
        // Conviction proxy: distance above the slow SMA, capped at 10%.
        const stretch = Math.min(0.1, Math.max(0, (close - slow) / slow));
        const conviction = Math.min(1, 0.35 + stretch * 6);
        out.push({
          date: bar.date,
          symbol,
          side: "buy",
          notionalBase: nav * cfg.addPctOfNav * (0.6 + 0.8 * conviction),
          conviction,
          assetClass,
        });
        continue;
      }

      if (inTrend[symbol]) {
        inTrend[symbol] = false;
        legAdds[symbol] = 0;
        // Exit: sized large enough to clear whatever was accumulated. The
        // replay clamps a sell to the quantity actually held.
        out.push({
          date: bar.date,
          symbol,
          side: "sell",
          notionalBase: nav,
          conviction: 0,
          assetClass,
        });
      }
    }
  }

  return out;
}
