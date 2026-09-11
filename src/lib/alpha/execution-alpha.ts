import { inferVenue, type MarketVenue } from "../market-hours";

/**
 * Phase 6 — Execution Alpha
 * -------------------------
 * Pure helpers for two microstructure-aware execution behaviours:
 *
 *  1. Order slicing: split a parent buy notional into child slices sized to a
 *     participation cap of 20-day ADV (and an absolute cap), so we never
 *     dominate a print and can distribute across time.
 *
 *  2. Time-of-day filter: opening and closing auctions carry adverse spread
 *     and price-impact regimes; we haircut (or optionally block) buys inside
 *     configured minute windows. Score is expressed as a multiplier in
 *     [0, 1] applied to the requested parent notional before it hits
 *     applyBuyExecution.
 *
 * Both helpers are stateless and pure to keep them deterministic under test.
 * The scheduler that actually walks the slice plan lives in the executor;
 * this file only produces the plan and the TOD gate.
 */

export type SlicePlan = {
  parentNotional: number;
  childCount: number;
  childNotional: number;
  advParticipationPct: number | null; // aggregate participation across all children, 0..1
  reason: string;
};

export function planOrderSlices(args: {
  parentNotional: number;
  price: number;
  adv20d: number | null; // shares/day
  participationCap: number; // fraction of ADV (e.g. 0.05 = 5%)
  maxChildNotional: number; // hard cap on each child slice value
  maxChildren?: number; // safety cap
}): SlicePlan {
  const {
    parentNotional,
    price,
    adv20d,
    participationCap,
    maxChildNotional,
    maxChildren = 20,
  } = args;
  if (!(parentNotional > 0) || !(price > 0)) {
    return {
      parentNotional: Math.max(0, parentNotional),
      childCount: 0,
      childNotional: 0,
      advParticipationPct: null,
      reason: "empty",
    };
  }
  const advValue = adv20d && adv20d > 0 ? adv20d * price : null;
  const capByAdv = advValue != null ? advValue * Math.max(0, participationCap) : Infinity;
  const cap = Math.min(maxChildNotional, capByAdv);
  if (!Number.isFinite(cap) || cap <= 0 || cap >= parentNotional) {
    return {
      parentNotional,
      childCount: 1,
      childNotional: parentNotional,
      advParticipationPct: advValue ? parentNotional / advValue : null,
      reason: advValue ? "single-slice under caps" : "no-adv single-slice",
    };
  }
  const rawCount = Math.ceil(parentNotional / cap);
  const childCount = Math.min(maxChildren, Math.max(1, rawCount));
  const childNotional = parentNotional / childCount;
  return {
    parentNotional,
    childCount,
    childNotional,
    advParticipationPct: advValue ? parentNotional / advValue : null,
    reason:
      childCount === maxChildren && rawCount > maxChildren
        ? `capped at ${maxChildren} children`
        : `sliced at ${(participationCap * 100).toFixed(1)}% ADV`,
  };
}

// ---------------------------------------------------------------------------
// Time-of-day filter — treats London trading hours as canonical for LSE names,
// falls back to US session windows for US-listed symbols.

export type Venue = MarketVenue;

export function inferVenueFromSymbol(symbol: string): Venue {
  return inferVenue(symbol);
}

// Session windows in minutes-since-midnight, local venue timezone. These are
// the defaults; per-venue overrides via `resolveVenueTodConfig` can widen or
// narrow them at runtime. TSE_JP has a lunch break — for the TOD haircut we
// treat the whole 09:00–15:00 span as one session; the intra-day break is
// modelled in market-hours.ts and blocks routing directly there.
const SESSIONS: Record<Venue, { openMin: number; closeMin: number } | null> = {
  LSE: { openMin: 8 * 60, closeMin: 16 * 60 + 30 },
  NYSE: { openMin: 9 * 60 + 30, closeMin: 16 * 60 },
  NASDAQ: { openMin: 9 * 60 + 30, closeMin: 16 * 60 },
  TSE_JP: { openMin: 9 * 60, closeMin: 15 * 60 },
  ASX: { openMin: 10 * 60, closeMin: 16 * 60 },
  XETR: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  EURONEXT: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  SIX: { openMin: 9 * 60, closeMin: 17 * 60 + 20 },
  NORDIC: { openMin: 9 * 60, closeMin: 17 * 60 + 25 },
  CRYPTO: null, // 24/7
  FX: null,
  OTHER: null,
};

const VENUE_TZ: Record<Venue, string | null> = {
  LSE: "Europe/London",
  NYSE: "America/New_York",
  NASDAQ: "America/New_York",
  TSE_JP: "Asia/Tokyo",
  ASX: "Australia/Sydney",
  XETR: "Europe/Berlin",
  EURONEXT: "Europe/Paris",
  SIX: "Europe/Zurich",
  NORDIC: "Europe/Stockholm",
  CRYPTO: null,
  FX: null,
  OTHER: null,
};

/**
 * Convert a UTC instant to local-venue minute-of-day. Uses Intl to avoid a
 * timezone dependency. For CRYPTO/OTHER returns null (no session concept).
 */
export function venueMinuteOfDay(now: Date, venue: Venue): number | null {
  const tz = VENUE_TZ[venue];
  if (!tz) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

export type TodAdjustment = {
  multiplier: number; // 0..1 haircut applied to parent notional
  allow: boolean; // true unless a hard block window is triggered
  reason: string;
};

// ---------------------------------------------------------------------------
// Per-venue TOD configuration
// ---------------------------------------------------------------------------
// Each venue can override any subset of the TOD knobs (auction windows,
// haircuts, hard-block minutes) AND the session open/close bounds themselves —
// useful when a venue publishes an early close (e.g. LSE 12:30 close on
// Christmas Eve) or when a shadow session should be treated as tradable.
// Missing fields fall through to the global RiskConfig defaults.

export type TodVenueOverride = {
  avoidOpenMin?: number;
  avoidCloseMin?: number;
  openHaircut?: number;
  closeHaircut?: number;
  hardBlockOpenMin?: number;
  hardBlockCloseMin?: number;
  sessionOpenMin?: number;
  sessionCloseMin?: number;
};

export type TodVenueOverrides = Partial<Record<Venue, TodVenueOverride>>;

export type ResolvedVenueTodConfig = {
  avoidOpenMin: number;
  avoidCloseMin: number;
  openHaircut: number;
  closeHaircut: number;
  hardBlockOpenMin: number;
  hardBlockCloseMin: number;
  sessionOpenMin?: number;
  sessionCloseMin?: number;
};

/**
 * Merge the venue-specific override (if any) on top of the global defaults so
 * callers get a single flat object to feed into `todExecutionAdjustment`.
 * Pure — safe to call per symbol per tick.
 */
export function resolveVenueTodConfig(
  defaults: {
    avoidOpenMin: number;
    avoidCloseMin: number;
    openHaircut: number;
    closeHaircut: number;
    hardBlockOpenMin: number;
    hardBlockCloseMin: number;
  },
  venue: Venue,
  overrides?: TodVenueOverrides | null,
): ResolvedVenueTodConfig {
  const o = overrides?.[venue];
  if (!o) return { ...defaults };
  return {
    avoidOpenMin: o.avoidOpenMin ?? defaults.avoidOpenMin,
    avoidCloseMin: o.avoidCloseMin ?? defaults.avoidCloseMin,
    openHaircut: o.openHaircut ?? defaults.openHaircut,
    closeHaircut: o.closeHaircut ?? defaults.closeHaircut,
    hardBlockOpenMin: o.hardBlockOpenMin ?? defaults.hardBlockOpenMin,
    hardBlockCloseMin: o.hardBlockCloseMin ?? defaults.hardBlockCloseMin,
    sessionOpenMin: o.sessionOpenMin,
    sessionCloseMin: o.sessionCloseMin,
  };
}

export function todExecutionAdjustment(args: {
  now?: Date;
  venue: Venue;
  avoidOpenMin: number;
  avoidCloseMin: number;
  openHaircut?: number; // e.g. 0.4 → keep 40% of size inside the auction window
  closeHaircut?: number;
  hardBlockOpenMin?: number; // if set, buys are fully blocked in first N minutes
  hardBlockCloseMin?: number;
  // Optional per-venue session overrides. When absent, fall back to SESSIONS.
  sessionOpenMin?: number;
  sessionCloseMin?: number;
}): TodAdjustment {
  const {
    now = new Date(),
    venue,
    avoidOpenMin,
    avoidCloseMin,
    openHaircut = 0.4,
    closeHaircut = 0.4,
    hardBlockOpenMin = 0,
    hardBlockCloseMin = 0,
    sessionOpenMin,
    sessionCloseMin,
  } = args;
  const defaultSession = SESSIONS[venue];
  const session =
    sessionOpenMin != null && sessionCloseMin != null
      ? { openMin: sessionOpenMin, closeMin: sessionCloseMin }
      : defaultSession;
  const minute = venueMinuteOfDay(now, venue);
  if (!session || minute == null) {
    return { multiplier: 1, allow: true, reason: "no-session (24/7 or unknown venue)" };
  }
  if (minute < session.openMin || minute > session.closeMin) {
    // Outside RTH — daily batch runs land here; treat as neutral so end-of-day
    // decision ticks still execute.
    return { multiplier: 1, allow: true, reason: "outside RTH (batch)" };
  }
  const sinceOpen = minute - session.openMin;
  const untilClose = session.closeMin - minute;
  if (hardBlockOpenMin > 0 && sinceOpen < hardBlockOpenMin) {
    return { multiplier: 0, allow: false, reason: `hard-block first ${hardBlockOpenMin}m` };
  }
  if (hardBlockCloseMin > 0 && untilClose < hardBlockCloseMin) {
    return { multiplier: 0, allow: false, reason: `hard-block last ${hardBlockCloseMin}m` };
  }
  if (sinceOpen < avoidOpenMin) {
    return { multiplier: openHaircut, allow: true, reason: `open window haircut ${Math.round(openHaircut * 100)}%` };
  }
  if (untilClose < avoidCloseMin) {
    return { multiplier: closeHaircut, allow: true, reason: `close window haircut ${Math.round(closeHaircut * 100)}%` };
  }
  return { multiplier: 1, allow: true, reason: "mid-session" };
}

