// Deadline countdown alerts for Saxo corporate actions.
//
// Pure scheduling logic: given the pending events, the user's threshold
// ladder (e.g. 72h / 24h / 4h before the election deadline) and the set of
// alerts already delivered, decide which pushes are due right now.
//
// Two invariants keep this safe to run from a frequent cron:
//   1. every (event, threshold) pair fires at most once — the caller enforces
//      that with a unique row, and passes the existing keys back in here;
//   2. when several thresholds are crossed at the same observation (a new
//      event that lands inside 4h, or a cron outage), only the *tightest*
//      one is pushed. The wider ones are returned as `suppressed` so the
//      caller can record them without spamming the device.

export const DEFAULT_THRESHOLD_HOURS = [72, 24, 4] as const;
export const MAX_THRESHOLDS = 5;

export type DeadlineAlertEvent = {
  id: string;
  instrument: string | null;
  symbol: string | null;
  eventTypeLabel: string;
  deadline: string | null;
  requiresElection: boolean;
};

export type DueDeadlineAlert = {
  eventId: string;
  thresholdHours: number;
  /** Real hours left at detection time (can be less than the threshold). */
  hoursRemaining: number;
  deadline: string;
  title: string;
  body: string;
  tag: string;
  /** Thresholds already crossed but deliberately not pushed. */
  suppressed: number[];
};

export function alertKey(eventId: string, thresholdHours: number): string {
  return `${eventId}:${thresholdHours}`;
}

/** Normalise and validate a user-supplied threshold ladder. */
export function normalizeThresholds(input: readonly number[] | null | undefined): number[] {
  const cleaned = (input ?? [])
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 720);
  const unique = [...new Set(cleaned)].sort((a, b) => b - a);
  if (unique.length === 0) return [...DEFAULT_THRESHOLD_HOURS];
  return unique.slice(0, MAX_THRESHOLDS);
}

/** Hours until `deadline`, or null when it is unparseable. */
export function hoursUntil(deadline: string | null, now: Date): number | null {
  if (!deadline) return null;
  const t = Date.parse(deadline);
  if (!Number.isFinite(t)) return null;
  return (t - now.getTime()) / 3_600_000;
}

function countdownLabel(hours: number): string {
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `${mins} min`;
  }
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}

export type DueAlertsInput = {
  events: readonly DeadlineAlertEvent[];
  thresholds: readonly number[];
  now: Date;
  /** Keys from `alertKey()` that were already delivered or suppressed. */
  alreadySent: ReadonlySet<string>;
  /** Portfolio label used in the notification body. */
  portfolioName?: string | null;
};

/** Decide which countdown pushes are due for one portfolio's event list. */
export function dueDeadlineAlerts({
  events,
  thresholds,
  now,
  alreadySent,
  portfolioName,
}: DueAlertsInput): DueDeadlineAlert[] {
  const ladder = normalizeThresholds(thresholds); // desc
  const out: DueDeadlineAlert[] = [];

  for (const ev of events) {
    if (!ev.requiresElection) continue;
    const hours = hoursUntil(ev.deadline, now);
    if (hours == null || hours <= 0) continue; // no deadline, or already passed

    // Thresholds we have entered, tightest first.
    const crossed = ladder.filter((t) => hours <= t).sort((a, b) => a - b);
    const pending = crossed.filter((t) => !alreadySent.has(alertKey(ev.id, t)));
    if (pending.length === 0) continue;

    const fire = pending[0]!;
    const suppressed = pending.slice(1);
    const name = ev.instrument ?? ev.symbol ?? "A holding";
    const left = countdownLabel(hours);

    out.push({
      eventId: ev.id,
      thresholdHours: fire,
      hoursRemaining: hours,
      deadline: ev.deadline!,
      title: `${left} left: ${name} election`,
      body:
        `${ev.eventTypeLabel} needs your instruction` +
        (portfolioName ? ` (${portfolioName})` : "") +
        `. Elect in the Saxo platform before the deadline or the default option applies.`,
      tag: `ca-deadline:${ev.id}:${fire}`,
      suppressed,
    });
  }

  // Most urgent first so a batch send leads with the tightest deadline.
  return out.sort((a, b) => a.hoursRemaining - b.hoursRemaining);
}
