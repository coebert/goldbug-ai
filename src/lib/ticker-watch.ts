// Ticker watch — pure trigger evaluation for a symbol the operator asked the
// AI to "keep an eye on" (e.g. Apple during a drawdown).
//
// Deliberately mechanical: the AI's written thesis is stored alongside the
// watch, but whether an alert fires is decided by explicit, testable price
// conditions. That keeps the notification stream honest — no alert can fire
// on vibes, and every alert says exactly which condition tripped.

export type WatchTriggerCode =
  | "recovery_confirmed"
  | "oversold_washout"
  | "invalidation"
  | "new_low";

export type TickerWatchConfig = {
  symbol: string;
  /** Daily close above this level (with calm volatility) confirms a recovery. */
  buyAbove: number | null;
  /** RSI at or below this level counts as an oversold washout. */
  oversoldRsi: number;
  /** Recovery only counts while annualised volatility is under this (percent). */
  maxVolPct: number;
  /** A daily close below this level invalidates the thesis. */
  dropBelow: number | null;
};

export type TickerMetrics = {
  price: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  /** Annualised volatility, in percent (e.g. 42.1). */
  annualVolPct: number | null;
  changePct1d: number | null;
  changePct5d: number | null;
  /** Lowest close observed in the lookback window, excluding today. */
  priorLow: number | null;
};

export type WatchTrigger = {
  code: WatchTriggerCode;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
};

const pct = (n: number | null) => (n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const px = (n: number | null) => (n == null ? "n/a" : n.toFixed(2));

/**
 * Evaluate a watch against the latest metrics. Returns every trigger that is
 * currently true; the caller is responsible for per-day dedupe so a condition
 * that stays true doesn't re-notify on every hourly pass.
 */
export function evaluateTickerWatch(
  config: TickerWatchConfig,
  m: TickerMetrics,
): WatchTrigger[] {
  const out: WatchTrigger[] = [];
  if (!(m.price > 0)) return out;

  const volCalm = m.annualVolPct == null || m.annualVolPct <= config.maxVolPct;

  if (config.buyAbove != null && m.price > config.buyAbove && volCalm) {
    out.push({
      code: "recovery_confirmed",
      severity: "info",
      title: `${config.symbol}: recovery trigger hit at ${px(m.price)}`,
      body:
        `Price closed above the ${px(config.buyAbove)} entry level with ` +
        `volatility at ${pct(m.annualVolPct)} (limit ${config.maxVolPct}%). ` +
        `RSI ${m.rsi14 == null ? "n/a" : m.rsi14.toFixed(0)}, 5-day ${pct(m.changePct5d)}. ` +
        `This is the "wait for confirmation" entry condition, not an instruction to buy.`,
    });
  }

  if (m.rsi14 != null && m.rsi14 <= config.oversoldRsi) {
    out.push({
      code: "oversold_washout",
      severity: "info",
      title: `${config.symbol}: oversold at RSI ${m.rsi14.toFixed(0)}`,
      body:
        `Price ${px(m.price)} (${pct(m.changePct1d)} today, ${pct(m.changePct5d)} over 5 days) ` +
        `with RSI ${m.rsi14.toFixed(0)} at or below the ${config.oversoldRsi} washout level. ` +
        `Mean-reversion setups only count with a high-volume reversal bar — check before acting.`,
    });
  }

  if (config.dropBelow != null && m.price < config.dropBelow) {
    out.push({
      code: "invalidation",
      severity: "critical",
      title: `${config.symbol}: thesis invalidated below ${px(config.dropBelow)}`,
      body:
        `Price ${px(m.price)} is below the ${px(config.dropBelow)} invalidation level. ` +
        `The dip-buying case is off until a new base forms; do not average down here.`,
    });
  }

  if (m.priorLow != null && m.price < m.priorLow) {
    out.push({
      code: "new_low",
      severity: "warning",
      title: `${config.symbol}: new low for the watch window`,
      body:
        `Price ${px(m.price)} undercut the previous low of ${px(m.priorLow)}. ` +
        `Falling-knife conditions — the trend is still down (20d avg ${px(m.sma20)}, 50d avg ${px(m.sma50)}).`,
    });
  }

  return out;
}

/** Plain-language status line for the watch card when nothing has triggered. */
export function describeWatchStatus(
  config: TickerWatchConfig,
  m: TickerMetrics,
): string {
  if (!(m.price > 0)) return "No price data yet.";
  const parts: string[] = [];
  if (config.buyAbove != null) {
    const gap = ((config.buyAbove - m.price) / m.price) * 100;
    parts.push(
      m.price > config.buyAbove
        ? `above the ${px(config.buyAbove)} entry level`
        : `${gap.toFixed(1)}% below the ${px(config.buyAbove)} entry level`,
    );
  }
  if (m.rsi14 != null) parts.push(`RSI ${m.rsi14.toFixed(0)}`);
  if (m.annualVolPct != null) parts.push(`vol ${m.annualVolPct.toFixed(0)}%`);
  return `Waiting — ${parts.join(", ")}.`;
}
