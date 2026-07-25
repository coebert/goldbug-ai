// Static, hand-maintained FX event calendar. Kept dependency-free and
// client-safe so both the AI prompt builder (server) and any future UI
// surface can share it. Update this file quarterly as central banks publish
// their schedules — the AI uses "within N hours of event" as a stand-down
// heuristic for the affected currency.

export interface FxEvent {
  /** ISO date (UTC) of the event. */
  date: string;
  /** Currency most impacted (ISO 4217, uppercase). */
  ccy: string;
  /** Short human label, e.g. "FOMC rate decision". */
  label: string;
}

// 2026 calendar (partial — extend as new schedules are published).
export const FX_EVENTS: readonly FxEvent[] = [
  { date: "2026-01-28", ccy: "USD", label: "FOMC rate decision" },
  { date: "2026-02-05", ccy: "GBP", label: "BoE rate decision" },
  { date: "2026-03-05", ccy: "EUR", label: "ECB rate decision" },
  { date: "2026-03-18", ccy: "USD", label: "FOMC rate decision" },
  { date: "2026-03-19", ccy: "JPY", label: "BoJ rate decision" },
  { date: "2026-03-20", ccy: "CHF", label: "SNB rate decision" },
  { date: "2026-04-16", ccy: "EUR", label: "ECB rate decision" },
  { date: "2026-05-07", ccy: "GBP", label: "BoE rate decision" },
  { date: "2026-05-13", ccy: "USD", label: "US CPI" },
  { date: "2026-06-11", ccy: "EUR", label: "ECB rate decision" },
  { date: "2026-06-17", ccy: "USD", label: "FOMC rate decision" },
  { date: "2026-06-18", ccy: "JPY", label: "BoJ rate decision" },
  { date: "2026-07-30", ccy: "USD", label: "FOMC rate decision" },
  { date: "2026-08-06", ccy: "GBP", label: "BoE rate decision" },
  { date: "2026-09-10", ccy: "EUR", label: "ECB rate decision" },
  { date: "2026-09-17", ccy: "USD", label: "FOMC rate decision" },
];

/**
 * Return events for `ccy` that occur within `windowHours` before or after
 * `asOf`. Pure — safe to unit-test.
 */
export function eventsNear(ccy: string, asOf: Date, windowHours = 24): FxEvent[] {
  const target = ccy.toUpperCase();
  const windowMs = windowHours * 60 * 60 * 1000;
  const now = asOf.getTime();
  return FX_EVENTS.filter((e) => {
    if (e.ccy !== target) return false;
    const t = new Date(`${e.date}T12:00:00Z`).getTime();
    return Math.abs(t - now) <= windowMs;
  });
}

/**
 * True when either side of a pair has an event within the window. Used by
 * the AI playbook to stand down on tactical FX moves near central-bank
 * decisions.
 */
export function pairHasEventNear(
  fromCcy: string,
  toCcy: string,
  asOf: Date,
  windowHours = 24,
): boolean {
  return (
    eventsNear(fromCcy, asOf, windowHours).length > 0 ||
    eventsNear(toCcy, asOf, windowHours).length > 0
  );
}
