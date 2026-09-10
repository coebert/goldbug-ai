// Market-hours awareness. Pure module — safe to import from client, server
// functions, tests. No Supabase, no fetch, no timers. Given a symbol (or
// explicit venue) and an optional `now` instant, returns whether the venue
// is currently trading, which phase of the day it's in, the next open time
// and a short human-readable explanation the UI/logs can surface directly.
//
// This is the single source of truth for "is the market open?" so the
// reconciler, the UI and the audit log can never disagree.

export type MarketVenue =
  | "LSE"
  | "NYSE"
  | "NASDAQ"
  | "XETR"
  | "EURONEXT"
  | "SIX"
  | "NORDIC"
  | "TSE_JP"
  | "ASX"
  | "CRYPTO"
  | "FX"
  | "OTHER";

export type MarketPhase =
  | "open"
  | "pre_open"
  | "post_close"
  | "weekend"
  | "lunch"
  | "always_open"
  | "unknown";

export interface MarketStatus {
  venue: MarketVenue;
  timezone: string;
  isOpen: boolean;
  phase: MarketPhase;
  /** Local venue time as HH:mm (for display). */
  localTime: string;
  /** ISO of the next session open. Null when always_open or unknown. */
  nextOpenIso: string | null;
  /** ISO of the previous session close. Null when always_open or unknown. */
  previousCloseIso: string | null;
  /** Minutes until nextOpenIso (rounded down). Null when always_open. */
  minutesUntilOpen: number | null;
  /** Minutes since previousCloseIso (rounded down). Null when always_open. */
  minutesSinceClose: number | null;
  /** Compact explanation suitable for chip labels and log rows. */
  explanation: string;
}

// Session windows in local venue time. Kept intentionally simple — we do NOT
// model holidays here (Saxo will simply hold the order over any calendar
// day the exchange is closed; the reconciler treats "queued" the same way it
// treats a weekend). TSE_JP has an intra-day lunch break (11:30–12:30 JST);
// during that window `isOpen` is false and the phase is "lunch". Orders
// queued during lunch reconcile normally once the afternoon session opens.
const SESSIONS: Record<MarketVenue, {
  openMin: number;
  closeMin: number;
  tz: string;
  /** Optional intra-day break as [startMin, endMin) in local time. */
  breakMin?: [number, number];
} | null> = {
  LSE:    { openMin: 8 * 60,          closeMin: 16 * 60 + 30, tz: "Europe/London" },
  NYSE:   { openMin: 9 * 60 + 30,     closeMin: 16 * 60,       tz: "America/New_York" },
  NASDAQ: { openMin: 9 * 60 + 30,     closeMin: 16 * 60,       tz: "America/New_York" },
  TSE_JP: { openMin: 9 * 60,          closeMin: 15 * 60,       tz: "Asia/Tokyo",       breakMin: [11 * 60 + 30, 12 * 60 + 30] },
  ASX:    { openMin: 10 * 60,         closeMin: 16 * 60,       tz: "Australia/Sydney" },
  // Continental Europe. Continuous-trading windows only (auctions excluded):
  // Xetra/Frankfurt 09:00–17:30 CET, Euronext (Paris/Amsterdam/Brussels/
  // Lisbon/Milan/Madrid all share the window) 09:00–17:30 CET, SIX Swiss
  // 09:00–17:20 CET, Nordic (Stockholm/Copenhagen/Helsinki/Oslo) 09:00–17:25.
  XETR:     { openMin: 9 * 60, closeMin: 17 * 60 + 30, tz: "Europe/Berlin" },
  EURONEXT: { openMin: 9 * 60, closeMin: 17 * 60 + 30, tz: "Europe/Paris" },
  SIX:      { openMin: 9 * 60, closeMin: 17 * 60 + 20, tz: "Europe/Zurich" },
  NORDIC:   { openMin: 9 * 60, closeMin: 17 * 60 + 25, tz: "Europe/Stockholm" },
  CRYPTO: null, // 24/7
  FX:     null, // Global FX runs ~24/5, but our per-tick decisions treat it as always_open.
  OTHER:  null,
};

export function inferVenue(symbol: string): MarketVenue {
  const s = symbol.toUpperCase().trim();
  if (!s) return "OTHER";
  // FX pairs use Yahoo `XXXYYY=X` syntax.
  if (s.endsWith("=X")) return "FX";
  // Crypto spot pairs use `-USD` (Yahoo) or contain common ticker fragments.
  if (/-USD$|-USDT$|-EUR$/.test(s)) return "CRYPTO";
  if (/^(BTC|ETH|SOL|ADA|USDT|USDC)/.test(s)) return "CRYPTO";
  // Tokyo — Yahoo `.T` or Saxo `SYMBOL:XTKS`.
  if (s.endsWith(".T") || s.endsWith(":XTKS")) return "TSE_JP";
  // ASX — Yahoo `.AX` or Saxo `SYMBOL:XASX`.
  if (s.endsWith(".AX") || s.endsWith(":XASX")) return "ASX";
  // LSE — either Yahoo `.L` or Saxo `SYMBOL:XLON` form.
  if (s.endsWith(".L") || s.endsWith(":XLON")) return "LSE";
  // Continental Europe — Yahoo suffixes or Saxo `SYMBOL:MIC` forms.
  if (/\.(DE|F)$/.test(s) || /:(XETR|XFRA)$/.test(s)) return "XETR";
  if (/\.(PA|AS|BR|LS|MI|MC)$/.test(s) || /:(XPAR|XAMS|XBRU|XLIS|XMIL|XMAD|XDUB|XMSM)$/.test(s)) {
    return "EURONEXT";
  }
  if (/\.SW$/.test(s) || /:(XSWX|XVTX)$/.test(s)) return "SIX";
  if (/\.(ST|CO|HE|OL)$/.test(s) || /:(XSTO|XCSE|XHEL|XOSL)$/.test(s)) return "NORDIC";
  // Anything else that looks like a 1-5 letter equity ticker → US listed.
  // We can't cheaply distinguish NYSE from NASDAQ; both share the same window
  // so we just pick NYSE as the label — the session windows are identical.
  if (/^[A-Z]{1,5}(-[A-Z]+)?$/.test(s)) return "NYSE";
  return "OTHER";
}

// Extract HH, MM and weekday (0=Sunday..6=Saturday) for an instant projected
// into the venue's timezone. Uses `Intl.DateTimeFormat` so we don't need any
// timezone dependency.
function projectToVenueTime(now: Date, tz: string): { hh: number; mm: number; weekday: number; yyyy: number; mo: number; dd: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get("weekday")] ?? 0;
  return {
    hh: Number(get("hour") || "0"),
    mm: Number(get("minute") || "0"),
    weekday,
    yyyy: Number(get("year") || "1970"),
    mo: Number(get("month") || "1"),
    dd: Number(get("day") || "1"),
  };
}

// Compose an ISO instant from a venue-local wall-clock time by iterating a
// short candidate list. Cheap and accurate enough for "next open" / "prev
// close" without pulling in a full timezone library.
function venueWallclockToInstant(
  yyyy: number, mo: number, dd: number, hh: number, mm: number, tz: string,
): Date {
  // Start from a UTC guess and correct by the difference the Intl parser
  // reports when we round-trip the guess. Two passes converge for all
  // fixed and DST offsets.
  let guess = new Date(Date.UTC(yyyy, mo - 1, dd, hh, mm, 0));
  for (let i = 0; i < 2; i++) {
    const p = projectToVenueTime(guess, tz);
    const wantMinutes = hh * 60 + mm;
    const gotMinutes = p.hh * 60 + p.mm;
    // Days differ when the guess falls on a different local calendar day.
    const dayShift = (p.yyyy - yyyy) * 400 + (p.mo - mo) * 32 + (p.dd - dd);
    const deltaMin = gotMinutes - wantMinutes + dayShift * 24 * 60;
    if (deltaMin === 0) break;
    guess = new Date(guess.getTime() - deltaMin * 60_000);
  }
  return guess;
}

function pad2(n: number) { return n < 10 ? `0${n}` : String(n); }

function nextWeekdayInstant(
  from: { yyyy: number; mo: number; dd: number; weekday: number },
  addDays: number,
  tz: string,
  hh: number,
  mm: number,
): Date {
  // Advance date components by `addDays` in the LOCAL venue calendar. We do
  // this via UTC arithmetic on a midday anchor to sidestep DST edges.
  const anchor = new Date(Date.UTC(from.yyyy, from.mo - 1, from.dd, 12, 0, 0));
  const next = new Date(anchor.getTime() + addDays * 86_400_000);
  const p = projectToVenueTime(next, tz);
  return venueWallclockToInstant(p.yyyy, p.mo, p.dd, hh, mm, tz);
}

export function getMarketStatusForVenue(venue: MarketVenue, now: Date = new Date()): MarketStatus {
  const session = SESSIONS[venue];
  if (!session) {
    return {
      venue,
      timezone: "UTC",
      isOpen: true,
      phase: "always_open",
      localTime: `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}`,
      nextOpenIso: null,
      previousCloseIso: null,
      minutesUntilOpen: null,
      minutesSinceClose: null,
      explanation: venue === "CRYPTO"
        ? "24/7 — crypto never closes"
        : venue === "FX"
          ? "24/5 global FX — treated as always open for order routing"
          : "no session concept",
    };
  }

  const p = projectToVenueTime(now, session.tz);
  const minute = p.hh * 60 + p.mm;
  const isWeekend = p.weekday === 0 || p.weekday === 6;
  const inSessionWindow = !isWeekend && minute >= session.openMin && minute < session.closeMin;
  const inLunch = !!session.breakMin
    && inSessionWindow
    && minute >= session.breakMin[0]
    && minute < session.breakMin[1];
  const midSession = inSessionWindow && !inLunch;
  const preOpen = !isWeekend && minute < session.openMin;

  let phase: MarketPhase;
  if (isWeekend) phase = "weekend";
  else if (midSession) phase = "open";
  else if (inLunch) phase = "lunch";
  else if (preOpen) phase = "pre_open";
  else phase = "post_close";

  // previousClose: today's close if we're past it on a weekday, otherwise
  // the last weekday's close before today.
  let previousCloseInstant: Date | null;
  if (phase === "post_close") {
    previousCloseInstant = venueWallclockToInstant(
      p.yyyy, p.mo, p.dd, Math.floor(session.closeMin / 60), session.closeMin % 60, session.tz,
    );
  } else {
    // walk back day-by-day until we find a Mon-Fri
    let back = 1;
    let candidate = nextWeekdayInstant(p, -back, session.tz, Math.floor(session.closeMin / 60), session.closeMin % 60);
    let cp = projectToVenueTime(candidate, session.tz);
    while (cp.weekday === 0 || cp.weekday === 6) {
      back += 1;
      candidate = nextWeekdayInstant(p, -back, session.tz, Math.floor(session.closeMin / 60), session.closeMin % 60);
      cp = projectToVenueTime(candidate, session.tz);
    }
    previousCloseInstant = candidate;
  }

  // nextOpen: today's open if we're pre-open on a weekday, otherwise the
  // next weekday's open.
  let nextOpenInstant: Date;
  if (phase === "pre_open") {
    nextOpenInstant = venueWallclockToInstant(
      p.yyyy, p.mo, p.dd, Math.floor(session.openMin / 60), session.openMin % 60, session.tz,
    );
  } else if (phase === "lunch" && session.breakMin) {
    // Afternoon session opens at the end of the lunch break, same calendar day.
    const reopenMin = session.breakMin[1];
    nextOpenInstant = venueWallclockToInstant(
      p.yyyy, p.mo, p.dd, Math.floor(reopenMin / 60), reopenMin % 60, session.tz,
    );
  } else if (phase === "open") {
    // Next scheduled open is tomorrow (or Monday after Friday).
    let ahead = 1;
    let candidate = nextWeekdayInstant(p, ahead, session.tz, Math.floor(session.openMin / 60), session.openMin % 60);
    let cp = projectToVenueTime(candidate, session.tz);
    while (cp.weekday === 0 || cp.weekday === 6) {
      ahead += 1;
      candidate = nextWeekdayInstant(p, ahead, session.tz, Math.floor(session.openMin / 60), session.openMin % 60);
      cp = projectToVenueTime(candidate, session.tz);
    }
    nextOpenInstant = candidate;
  } else {
    // weekend or post_close → walk forward until a weekday
    let ahead = 1;
    let candidate = nextWeekdayInstant(p, ahead, session.tz, Math.floor(session.openMin / 60), session.openMin % 60);
    let cp = projectToVenueTime(candidate, session.tz);
    while (cp.weekday === 0 || cp.weekday === 6) {
      ahead += 1;
      candidate = nextWeekdayInstant(p, ahead, session.tz, Math.floor(session.openMin / 60), session.openMin % 60);
      cp = projectToVenueTime(candidate, session.tz);
    }
    nextOpenInstant = candidate;
  }

  const nowMs = now.getTime();
  const minutesUntilOpen = Math.max(0, Math.floor((nextOpenInstant.getTime() - nowMs) / 60_000));
  const minutesSinceClose = previousCloseInstant
    ? Math.max(0, Math.floor((nowMs - previousCloseInstant.getTime()) / 60_000))
    : null;

  const humanNextOpen = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(nextOpenInstant);

  let explanation: string;
  switch (phase) {
    case "open":
      explanation = `${venue} open (session closes ${pad2(Math.floor(session.closeMin / 60))}:${pad2(session.closeMin % 60)} local)`;
      break;
    case "pre_open":
      explanation = `${venue} pre-open — session opens in ${formatDuration(minutesUntilOpen)} (${humanNextOpen} UK)`;
      break;
    case "lunch":
      explanation = `${venue} lunch break — afternoon session opens in ${formatDuration(minutesUntilOpen)} (${humanNextOpen} UK)`;
      break;
    case "post_close":
      explanation = `${venue} closed for the day — reopens ${humanNextOpen} UK (in ${formatDuration(minutesUntilOpen)})`;
      break;
    case "weekend":
      explanation = `${venue} weekend — reopens ${humanNextOpen} UK (in ${formatDuration(minutesUntilOpen)})`;
      break;
    default:
      explanation = `${venue} status unknown`;
  }

  return {
    venue,
    timezone: session.tz,
    isOpen: phase === "open",
    phase,
    localTime: `${pad2(p.hh)}:${pad2(p.mm)}`,
    nextOpenIso: nextOpenInstant.toISOString(),
    previousCloseIso: previousCloseInstant ? previousCloseInstant.toISOString() : null,
    minutesUntilOpen,
    minutesSinceClose,
    explanation,
  };
}

// Symbol -> venue is a pure static mapping, so we can cache the venue lookup
// permanently. The venue's MarketStatus itself changes over time (phase, next
// open, minutes-until-open) so we bucket the cache by a coarse time slot —
// within a slot repeated callers get the same object without recomputing the
// timezone / session math. Slot = 60s keeps freshness tight enough for the
// hourly runner and reconciler while eliminating redundant work when a loop
// checks 20+ symbols in the same tick.
const SYMBOL_VENUE_CACHE = new Map<string, MarketVenue>();
const STATUS_SLOT_MS = 60_000;
const STATUS_CACHE = new Map<string, { slot: number; status: MarketStatus }>();

export function getMarketStatusForSymbol(symbol: string, now: Date = new Date()): MarketStatus {
  let venue = SYMBOL_VENUE_CACHE.get(symbol);
  if (venue === undefined) {
    venue = inferVenue(symbol);
    SYMBOL_VENUE_CACHE.set(symbol, venue);
  }
  const slot = Math.floor(now.getTime() / STATUS_SLOT_MS);
  const key = `${venue}@${slot}`;
  const hit = STATUS_CACHE.get(key);
  if (hit && hit.slot === slot) return hit.status;
  const status = getMarketStatusForVenue(venue, now);
  // Cap the cache: only ever holds a handful of venues * a few slots.
  if (STATUS_CACHE.size > 64) STATUS_CACHE.clear();
  STATUS_CACHE.set(key, { slot, status });
  return status;
}

export function _clearMarketStatusCache(): void {
  SYMBOL_VENUE_CACHE.clear();
  STATUS_CACHE.clear();
}

/**
 * Returns true if the venue has been in an `open` phase at any point in the
 * interval [fromMs, toMs]. Used by the reconciler: a market order submitted
 * while the market was closed can only reasonably be "presumed filled" once
 * the market has actually had a chance to trade it.
 *
 * Approximation: samples every 30 minutes across the window (capped at 2000
 * samples so a runaway span can't stall the reconciler). Good enough for
 * "did LSE trade at all between Friday 17:00 and now?".
 */
export function marketHadOpenPeriod(venue: MarketVenue, fromMs: number, toMs: number): boolean {
  if (SESSIONS[venue] == null) return true; // always-open venues
  if (!(toMs > fromMs)) return false;
  const stepMs = 30 * 60_000;
  const maxSamples = 2000;
  const span = toMs - fromMs;
  const samples = Math.min(maxSamples, Math.max(2, Math.ceil(span / stepMs) + 1));
  for (let i = 0; i < samples; i++) {
    const t = fromMs + Math.round((i / (samples - 1)) * span);
    const s = getMarketStatusForVenue(venue, new Date(t));
    if (s.isOpen) return true;
  }
  return false;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d` : `${d}d ${rh}h`;
}

/**
 * Bundle status for the four venues we surface in the UI, in one call, so
 * the market-status strip in OrderReconciliationCard doesn't need to
 * duplicate the per-venue calls.
 */
export function getMarketStatusOverview(now: Date = new Date()): MarketStatus[] {
  return (["LSE", "NYSE", "TSE_JP", "ASX", "CRYPTO", "FX"] as const).map((v) => getMarketStatusForVenue(v, now));
}
