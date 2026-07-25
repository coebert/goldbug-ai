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

export type Venue = "LSE" | "NYSE" | "NASDAQ" | "CRYPTO" | "OTHER";

export function inferVenueFromSymbol(symbol: string): Venue {
  const s = symbol.toUpperCase();
  if (/-USD$|BTC|ETH|USDT|USDC/.test(s)) return "CRYPTO";
  if (s.endsWith(".L") || s.endsWith(":XLON")) return "LSE";
  if (/^[A-Z]{1,5}$/.test(s)) return "NYSE";
  return "OTHER";
}

// Session windows in minutes-since-midnight, local venue timezone.
const SESSIONS: Record<Venue, { openMin: number; closeMin: number } | null> = {
  LSE: { openMin: 8 * 60, closeMin: 16 * 60 + 30 },
  NYSE: { openMin: 9 * 60 + 30, closeMin: 16 * 60 },
  NASDAQ: { openMin: 9 * 60 + 30, closeMin: 16 * 60 },
  CRYPTO: null, // 24/7
  OTHER: null,
};

/**
 * Convert a UTC instant to local-venue minute-of-day. Uses Intl to avoid a
 * timezone dependency. For CRYPTO/OTHER returns null (no session concept).
 */
export function venueMinuteOfDay(now: Date, venue: Venue): number | null {
  if (venue === "CRYPTO" || venue === "OTHER") return null;
  const tz = venue === "LSE" ? "Europe/London" : "America/New_York";
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

export function todExecutionAdjustment(args: {
  now?: Date;
  venue: Venue;
  avoidOpenMin: number;
  avoidCloseMin: number;
  openHaircut?: number; // e.g. 0.4 → keep 40% of size inside the auction window
  closeHaircut?: number;
  hardBlockOpenMin?: number; // if set, buys are fully blocked in first N minutes
  hardBlockCloseMin?: number;
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
  } = args;
  const session = SESSIONS[venue];
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
