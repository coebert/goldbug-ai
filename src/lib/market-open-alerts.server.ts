// Shared list + helpers for "market just opened" push alerts.
// Kept server-side because the alert firing logic runs from the cron hook.
// Times are the same session windows the home-screen MarketHoursCard displays,
// mirrored here so the two views can never disagree.

const MON_FRI = [1, 2, 3, 4, 5] as const;

export interface AlertableMarket {
  id: string;
  label: string;
  tz: string;
  openMin: number; // minutes since local midnight
  days: readonly number[]; // ISO weekday numbers (1=Mon..7=Sun)
}

// Always-open venues (crypto, spot FX) are intentionally excluded — there is
// no meaningful closed→open transition to alert on for either of them.
export const ALERTABLE_MARKETS: readonly AlertableMarket[] = [
  { id: "lse",         label: "London Stock Exchange",       tz: "Europe/London",     openMin: 8 * 60,       days: MON_FRI },
  { id: "xetra",       label: "Xetra / Frankfurt",           tz: "Europe/Berlin",     openMin: 9 * 60,       days: MON_FRI },
  { id: "euronext",    label: "Euronext (Paris/Amsterdam)",  tz: "Europe/Paris",      openMin: 9 * 60,       days: MON_FRI },
  { id: "six",         label: "SIX Swiss Exchange",          tz: "Europe/Zurich",     openMin: 9 * 60,       days: MON_FRI },
  { id: "nyse",        label: "NYSE",                        tz: "America/New_York",  openMin: 9 * 60 + 30,  days: MON_FRI },
  { id: "nasdaq",      label: "Nasdaq",                      tz: "America/New_York",  openMin: 9 * 60 + 30,  days: MON_FRI },
  { id: "tsx",         label: "Toronto Stock Exchange",      tz: "America/Toronto",   openMin: 9 * 60 + 30,  days: MON_FRI },
  { id: "tse",         label: "Tokyo Stock Exchange",        tz: "Asia/Tokyo",        openMin: 9 * 60,       days: MON_FRI },
  { id: "hkex",        label: "Hong Kong (HKEX)",            tz: "Asia/Hong_Kong",    openMin: 9 * 60 + 30,  days: MON_FRI },
  { id: "asx",         label: "ASX",                         tz: "Australia/Sydney",  openMin: 10 * 60,      days: MON_FRI },
  { id: "commodities", label: "Commodities (CME futures)",   tz: "America/Chicago",   openMin: 17 * 60,      days: [0, 1, 2, 3, 4] }, // Sun-Thu 17:00 CT reopens
];

/** Convert a wall-clock time in `tz` to a UTC Date instant. */
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some ICU versions render midnight as "24"
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"));
  const offset = asLocal - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Get date parts (y/m/d + ISO weekday) for `now` projected into `tz`. */
function venueDateParts(now: Date, tz: string): { y: number; m: number; d: number; isoDow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    isoDow: dowMap[get("weekday")] ?? 1,
  };
}

/** UK-local YYYY-MM-DD for `now`. Used as dedupe partition. */
export function ukLocalDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface OpeningEvent {
  market: AlertableMarket;
  openInstant: Date;
  ukOpenTimeLabel: string; // "08:00 UK"
  ukAlertDate: string;     // YYYY-MM-DD in Europe/London
  minutesSinceOpen: number;
}

/**
 * Return every market whose most-recent scheduled open sits inside
 * `[now - windowMinutes, now]`. Callers dedupe with `(market.id, ukAlertDate)`.
 */
export function detectRecentOpenings(now: Date, windowMinutes = 15): OpeningEvent[] {
  const out: OpeningEvent[] = [];
  for (const m of ALERTABLE_MARKETS) {
    const parts = venueDateParts(now, m.tz);
    if (!m.days.includes(parts.isoDow)) continue;
    const hh = Math.floor(m.openMin / 60);
    const mm = m.openMin % 60;
    const openInstant = zonedTimeToUtc(parts.y, parts.m, parts.d, hh, mm, m.tz);
    const diffMs = now.getTime() - openInstant.getTime();
    const minutesSinceOpen = Math.floor(diffMs / 60_000);
    if (minutesSinceOpen < 0 || minutesSinceOpen > windowMinutes) continue;
    const ukOpenTimeLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(openInstant);
    out.push({
      market: m,
      openInstant,
      ukOpenTimeLabel: `${ukOpenTimeLabel} UK`,
      ukAlertDate: ukLocalDate(openInstant),
      minutesSinceOpen,
    });
  }
  return out;
}
