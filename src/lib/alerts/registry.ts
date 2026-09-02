/**
 * The alert registry.
 *
 * Banner-style warnings used to render wherever they happened to be
 * written, so a page could stack six grey/amber strips above its
 * content in whatever order the JSX happened to be in.
 *
 * The registry gives every banner a stable id, a severity and a
 * human label in ONE place. `AlertStrip` renders the registered
 * banners in severity order, shows only the highest-priority one, and
 * puts the rest behind a bell. Critical alerts (trading halts) are
 * never collapsed — they still block the page as they did before.
 *
 * This file is data only: no component imports, so it can be unit
 * tested and consumed by the command palette.
 */

export type AlertSeverity = "critical" | "warning" | "info";

export type AlertDefinition = {
  /** Stable id, also the DOM id of the slot wrapper. */
  id: string;
  /** Plain-English label shown in the bell list. */
  label: string;
  severity: AlertSeverity;
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Sort by severity first, then by the order the alerts were declared
 * in — so the ranking is deterministic and testable.
 */
export function sortAlerts<T extends { severity: AlertSeverity }>(alerts: readonly T[]): T[] {
  return alerts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => severityRank(x.a.severity) - severityRank(y.a.severity) || x.i - y.i)
    .map(({ a }) => a);
}

export function isCritical(alert: { severity: AlertSeverity }): boolean {
  return alert.severity === "critical";
}

/** Every banner shown on the portfolio detail page, ranked. */
export const PORTFOLIO_ALERTS: readonly AlertDefinition[] = [
  { id: "risk-halt", label: "Risk halt", severity: "critical" },
  { id: "precheck-cash", label: "Cash pre-check", severity: "critical" },
  { id: "valuation-consistency", label: "Valuation consistency", severity: "warning" },
  { id: "instrument-ccy", label: "Instrument currency", severity: "warning" },
  { id: "currency-diagnostics", label: "Currency diagnostics", severity: "warning" },
  { id: "cost-sync", label: "Broker cost sync", severity: "warning" },
  { id: "coverage-trend", label: "Charge coverage trend", severity: "info" },
  { id: "reconcile-fills", label: "Fill reconciliation", severity: "info" },
  { id: "price-unit-audit", label: "Price unit audit", severity: "info" },
] as const;
