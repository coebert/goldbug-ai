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
