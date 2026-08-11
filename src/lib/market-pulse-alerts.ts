// Alert rules for the home-screen "Market pulse" dashboard.
//
// Pure functions: given a computed MarketPulse, decide which watch conditions
// are currently tripped. Every alert carries the metric's *current value* and
// the *threshold* it crossed so both the dashboard banner and the notification
// can explain themselves without re-deriving anything.

import type { MarketPulse } from "./market-pulse";

export type PulseAlertSeverity = "warning" | "critical";

export type PulseAlertId =
  | "vix_level"
  | "vix_spike"
  | "breadth_drop"
  | "gold_bitcoin_divergence"
  | "credit_stress"
  | "risk_off_tone";

export interface PulseAlert {
  id: PulseAlertId;
  severity: PulseAlertSeverity;
  /** Short headline, e.g. "Volatility spike". */
  title: string;
  /** Plain-language explanation of what happened and why it matters. */
  body: string;
  /** What is being measured, e.g. "VIX level". */
  metric: string;
  value: number;
  valueText: string;
  threshold: number;
  thresholdText: string;
  /** Symbol to drill into, when the rule is about one instrument. */
  symbol?: string;
}

/** Documented thresholds — surfaced in the UI and stored on the notification. */
export const PULSE_ALERT_THRESHOLDS = {
  vixLevelWarning: 25,
  vixLevelCritical: 32,
  vixSpikePct: 20,
  vixSpikeCriticalPct: 35,
  breadthWarningPct: 40,
  breadthCriticalPct: 25,
  goldBtcSpreadPts: 8,
  goldBtcSpreadCriticalPts: 15,
  creditDrop5dPct: -2,
  creditDropCritical5dPct: -4,
  toneWarning: 40,
  toneCritical: 30,
} as const;

const T = PULSE_ALERT_THRESHOLDS;

function fmtPct(v: number, digits = 1) {
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function evaluatePulseAlerts(pulse: MarketPulse): PulseAlert[] {
  const alerts: PulseAlert[] = [];
  const find = (s: string) =>
    pulse.quotes.find((q) => q.symbol === s) ?? pulse.sectors.find((q) => q.symbol === s);

  // 1. Volatility level.
  const vix = find("^VIX");
  if (vix && Number.isFinite(vix.close)) {
    if (vix.close >= T.vixLevelWarning) {
      const critical = vix.close >= T.vixLevelCritical;
      alerts.push({
        id: "vix_level",
        severity: critical ? "critical" : "warning",
        title: critical ? "Volatility is extreme" : "Volatility is elevated",
        body: `The VIX is at ${vix.close.toFixed(1)}, above the ${
          critical ? T.vixLevelCritical : T.vixLevelWarning
        } alert level. Expect wider price swings and worse fills; position sizes should be smaller.`,
        metric: "VIX level",
        value: vix.close,
        valueText: vix.close.toFixed(1),
        threshold: critical ? T.vixLevelCritical : T.vixLevelWarning,
        thresholdText: `≥ ${critical ? T.vixLevelCritical : T.vixLevelWarning}`,
        symbol: "^VIX",
      });
    }

    // 2. One-day volatility spike, even from a low base.
    const chg = vix.changePct1d;
    if (chg != null && chg >= T.vixSpikePct) {
      const critical = chg >= T.vixSpikeCriticalPct;
      alerts.push({
        id: "vix_spike",
        severity: critical ? "critical" : "warning",
        title: "Volatility spike",
        body: `The VIX jumped ${fmtPct(chg)} in a day to ${vix.close.toFixed(
          1,
        )} — a sudden repricing of risk rather than a slow drift.`,
        metric: "VIX 1-day change",
        value: chg,
        valueText: fmtPct(chg),
        threshold: critical ? T.vixSpikeCriticalPct : T.vixSpikePct,
        thresholdText: `≥ +${critical ? T.vixSpikeCriticalPct : T.vixSpikePct}%`,
        symbol: "^VIX",
      });
    }
  }

  // 3. Breadth: how many tracked markets still hold their 50-day average.
  const breadth = pulse.breadth.aboveSma50Pct;
  if (breadth != null && breadth <= T.breadthWarningPct) {
    const critical = breadth <= T.breadthCriticalPct;
    alerts.push({
      id: "breadth_drop",
      severity: critical ? "critical" : "warning",
      title: critical ? "Breadth has collapsed" : "Breadth is weak",
      body: `Only ${Math.round(breadth)}% of tracked markets are above their 50-day average (${
        pulse.breadth.aboveSma50
      } of ${pulse.breadth.total}). Rallies on narrow participation tend not to hold.`,
      metric: "Markets above 50-day average",
      value: breadth,
      valueText: `${Math.round(breadth)}%`,
      threshold: critical ? T.breadthCriticalPct : T.breadthWarningPct,
      thresholdText: `≤ ${critical ? T.breadthCriticalPct : T.breadthWarningPct}%`,
    });
  }

  // 4. Gold vs bitcoin: the classic hard-asset split. Gold rising while
  //    bitcoin falls is a flight to safety; the reverse is speculative risk
  //    appetite running ahead of the safe-haven bid.
  const gold = find("GLD");
  const btc = find("BTC-USD");
  if (gold?.changePct5d != null && btc?.changePct5d != null) {
    const spread = gold.changePct5d - btc.changePct5d;
    if (Math.abs(spread) >= T.goldBtcSpreadPts) {
      const critical = Math.abs(spread) >= T.goldBtcSpreadCriticalPts;
      const goldLeading = spread > 0;
      alerts.push({
        id: "gold_bitcoin_divergence",
        severity: critical ? "critical" : "warning",
        title: goldLeading ? "Gold / bitcoin divergence — flight to safety" : "Gold / bitcoin divergence — risk appetite",
        body: goldLeading
          ? `Over 5 days gold is ${fmtPct(gold.changePct5d)} while bitcoin is ${fmtPct(
              btc.changePct5d,
            )} — a ${Math.abs(spread).toFixed(1)} point gap. Money is moving to safety.`
          : `Over 5 days bitcoin is ${fmtPct(btc.changePct5d)} while gold is ${fmtPct(
              gold.changePct5d,
            )} — a ${Math.abs(spread).toFixed(1)} point gap. Speculative appetite is running hot.`,
        metric: "Gold − bitcoin, 5-day",
        value: spread,
        valueText: `${spread > 0 ? "+" : ""}${spread.toFixed(1)} pts`,
        threshold: critical ? T.goldBtcSpreadCriticalPts : T.goldBtcSpreadPts,
        thresholdText: `|gap| ≥ ${critical ? T.goldBtcSpreadCriticalPts : T.goldBtcSpreadPts} pts`,
        symbol: goldLeading ? "GLD" : "BTC-USD",
      });
    }
  }

  // 5. Credit stress: high-yield selling off is an early equity warning.
  const hyg = find("HYG");
  if (hyg?.changePct5d != null && hyg.changePct5d <= T.creditDrop5dPct) {
    const critical = hyg.changePct5d <= T.creditDropCritical5dPct;
    alerts.push({
      id: "credit_stress",
      severity: critical ? "critical" : "warning",
      title: "High-yield credit is selling off",
      body: `High-yield credit is ${fmtPct(
        hyg.changePct5d,
      )} over 5 days. Credit usually cracks before shares do.`,
      metric: "High-yield credit, 5-day",
      value: hyg.changePct5d,
      valueText: fmtPct(hyg.changePct5d),
      threshold: critical ? T.creditDropCritical5dPct : T.creditDrop5dPct,
      thresholdText: `≤ ${critical ? T.creditDropCritical5dPct : T.creditDrop5dPct}%`,
      symbol: "HYG",
    });
  }

  // 6. Overall tone.
  if (pulse.toneScore <= T.toneWarning) {
    const critical = pulse.toneScore <= T.toneCritical;
    alerts.push({
      id: "risk_off_tone",
      severity: critical ? "critical" : "warning",
      title: critical ? "Markets are deeply risk-off" : "Markets have turned risk-off",
      body: `The risk-appetite score is ${pulse.toneScore}/100, at or below the ${
        critical ? T.toneCritical : T.toneWarning
      } alert level. Conditions favour caution and smaller positions.`,
      metric: "Risk-appetite score",
      value: pulse.toneScore,
      valueText: `${pulse.toneScore}/100`,
      threshold: critical ? T.toneCritical : T.toneWarning,
      thresholdText: `≤ ${critical ? T.toneCritical : T.toneWarning}`,
    });
  }

  // Critical first, then by rule order.
  return alerts.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
  );
}

/** Stable signature so a repeated alert at the same level does not re-notify. */
export function pulseAlertKey(a: PulseAlert): string {
  return `${a.id}:${a.severity}`;
}

export function pulseAlertsSignature(alerts: PulseAlert[]): string {
  return alerts.map(pulseAlertKey).sort().join("|");
}
