// Centralised UK-local (Europe/London) formatters.
// The app runs on servers/browsers whose default zone is UTC, so
// `toLocaleString()` prints "GMT" even in British Summer Time. These
// helpers pin display to Europe/London so BST/GMT is picked
// automatically based on the date.

const TZ = "Europe/London";
const LOCALE = "en-GB";

export function formatUk(
  input: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  if (input == null) return "";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...opts }).format(d);
}

export function formatUkDate(input: string | number | Date | null | undefined): string {
  return formatUk(input, { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatUkTime(input: string | number | Date | null | undefined): string {
  return formatUk(input, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatUkDateTime(input: string | number | Date | null | undefined): string {
  return formatUk(input, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// "GMT" or "BST" for a given instant, so labels stay accurate year-round.
export function ukZoneAbbr(input: string | number | Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    timeZoneName: "short",
  }).formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
}

// Hour (0-23) in Europe/London for a given instant. Useful for
// scheduling-style logic that used to read getUTCHours().
export function ukHour(input: string | number | Date = new Date()): number {
  const d = input instanceof Date ? input : new Date(input);
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  }).format(d);
  return Number.parseInt(s, 10);
}

// ---------------------------------------------------------------------------
// Chart/axis helpers — the single source of truth for how instants are bucketed
// and labelled on time-series charts.
//
// Two bugs this prevents:
//  1. `iso.slice(0, 10)` reads the *UTC* calendar day. Under BST, 23:30 London
//     is 22:30 UTC on the same day, but 00:30 London is 23:30 UTC the day
//     *before* — so late/early hourly points were attributed to the wrong day
//     when matching deposits or clipping to inception.
//  2. `toLocaleDateString(undefined, …)` renders in the *viewer's* timezone, so
//     the x-axis and the tooltip could disagree with each other (and with the
//     market) depending on where the browser sits.
// Hour boundaries themselves are safe to truncate in UTC: Europe/London is
// always a whole number of hours from UTC, so a UTC hour bucket is also a
// London hour bucket.
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for the Europe/London calendar day containing `input`. */
export function ukDayKey(input: string | number | Date): string {
  const raw = typeof input === "string" ? input : "";
  // Date-only strings are already calendar days; re-parsing them can shift
  // the day when the runtime treats them as UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Compact axis label for a day: "02 Aug" in Europe/London. */
export function formatUkAxisDay(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
  }).format(d);
}

/** Axis/tooltip label for an hourly point: "02 Aug, 14:00" in Europe/London. */
export function formatUkAxisHour(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Time-only axis label for intraday points inside a single day: "14:00". */
export function formatUkAxisTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Month-level axis label for multi-month spans: "Aug 26". */
export function formatUkAxisMonth(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    month: "short",
    year: "2-digit",
  }).format(d);
}
