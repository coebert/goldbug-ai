// Pure thresholds for "does Aegis agree with Saxo about my equity?".
//
// The app's headline equity comes from `equity_snapshots`; Saxo's comes from
// the account summary (authoritative TotalValue). They should agree to within
// rounding — a persistent gap means a sync failed, a snapshot went stale, or a
// unit/FX bug slipped through. Classification lives here, free of IO, so it is
// directly testable.

/** Below this absolute gap nothing is flagged, whatever the percentage says. */
export const EQUITY_DRIFT_ABS_FLOOR = 5; // account currency units

export const EQUITY_DRIFT_WARN_PCT = 0.005; // 0.5%
export const EQUITY_DRIFT_ALERT_PCT = 0.02; // 2%

export type EquityDriftSeverity = "ok" | "warn" | "alert" | "unknown";

export type EquityDrift = {
  severity: EquityDriftSeverity;
  /** app − broker, signed (positive = Aegis is showing more than Saxo). */
  diff: number;
  /** |diff| relative to the broker figure. */
  diffPct: number;
  appTotal: number | null;
  brokerTotal: number | null;
  note: string;
};

export function classifyEquityDrift(input: {
  appTotal: number | null | undefined;
  brokerTotal: number | null | undefined;
  currency?: string;
}): EquityDrift {
  const app = Number(input.appTotal);
  const broker = Number(input.brokerTotal);
  const ccy = input.currency ?? "";

  if (!Number.isFinite(app) || !Number.isFinite(broker) || broker <= 0) {
    return {
      severity: "unknown",
      diff: 0,
      diffPct: 0,
      appTotal: Number.isFinite(app) ? app : null,
      brokerTotal: Number.isFinite(broker) ? broker : null,
      note: "no comparable equity figures (missing snapshot or broker total)",
    };
  }

  const diff = app - broker;
  const diffPct = Math.abs(diff) / Math.abs(broker);

  let severity: EquityDriftSeverity = "ok";
  if (Math.abs(diff) >= EQUITY_DRIFT_ABS_FLOOR) {
    if (diffPct >= EQUITY_DRIFT_ALERT_PCT) severity = "alert";
    else if (diffPct >= EQUITY_DRIFT_WARN_PCT) severity = "warn";
  }

  const money = (n: number) => `${ccy ? ccy + " " : ""}${n.toFixed(2)}`;
  const note =
    severity === "ok"
      ? `equity in line with broker (Δ ${money(diff)}, ${(diffPct * 100).toFixed(2)}%)`
      : `Aegis equity ${money(app)} vs Saxo ${money(broker)} — Δ ${money(diff)} (${(diffPct * 100).toFixed(2)}%)`;

  return { severity, diff, diffPct, appTotal: app, brokerTotal: broker, note };
}
