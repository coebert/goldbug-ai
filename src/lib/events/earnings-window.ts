// Earnings & event-window awareness (Phase 2).
//
// Pure logic for deciding how a proposed trade should react to a nearby
// earnings announcement. The rules are deliberately simple and evidence-
// based: binary events blow up realised volatility, so we (a) trim size
// as we approach the date, (b) refuse to open fresh risk in the tight
// pre-print window, and (c) allow business-as-usual once the print has
// been digested.
//
// All time inputs are ISO strings; the caller supplies "now" so this file
// stays trivially testable and timezone-free.

export type EarningsAction = "allow" | "trim" | "block";

export type EarningsDecision = {
  action: EarningsAction;
  size_multiplier: number;   // 0..1 applied to the intended notional
  days_until: number | null; // negative = past; null = no known date
  reason: string;
};

export type EarningsWindowConfig = {
  block_days_before: number;   // no new opens within this many trading days
  trim_days_before: number;    // start scaling down inside this window
  trim_floor: number;          // minimum multiplier at the tightest point (>0..1)
  post_event_calm_days: number;// treat as "allow" once this many days have passed
};

export const DEFAULT_EARNINGS_WINDOW: EarningsWindowConfig = {
  block_days_before: 2,
  trim_days_before: 5,
  trim_floor: 0.3,
  post_event_calm_days: 1,
};

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function evaluateEarningsWindow(
  nextEarnings: string | Date | null,
  now: Date,
  side: "buy" | "sell",
  cfg: EarningsWindowConfig = DEFAULT_EARNINGS_WINDOW,
): EarningsDecision {
  if (!nextEarnings) {
    return { action: "allow", size_multiplier: 1, days_until: null, reason: "no earnings date on file" };
  }
  const target = typeof nextEarnings === "string" ? new Date(nextEarnings) : nextEarnings;
  if (Number.isNaN(target.getTime())) {
    return { action: "allow", size_multiplier: 1, days_until: null, reason: "invalid earnings date" };
  }
  const days = daysBetween(now, target);

  // Past event — allow after calm window; sells are always allowed.
  if (days < 0) {
    if (side === "sell" || -days >= cfg.post_event_calm_days) {
      return { action: "allow", size_multiplier: 1, days_until: days, reason: "post-earnings calm" };
    }
    return {
      action: "trim",
      size_multiplier: 0.5,
      days_until: days,
      reason: `within ${cfg.post_event_calm_days}d post-print — half size`,
    };
  }

  // Sells inside the window get a modest trim only (we prefer to close risk
  // ahead of binary events, so never fully block a sell).
  if (side === "sell") {
    if (days <= cfg.block_days_before) {
      return {
        action: "trim",
        size_multiplier: 1,
        days_until: days,
        reason: `earnings in ${days}d — sells allowed at full size`,
      };
    }
    return { action: "allow", size_multiplier: 1, days_until: days, reason: `earnings in ${days}d` };
  }

  // Buys: block tight window, taper across trim window.
  if (days <= cfg.block_days_before) {
    return {
      action: "block",
      size_multiplier: 0,
      days_until: days,
      reason: `earnings in ${days}d — inside ${cfg.block_days_before}d blackout`,
    };
  }
  if (days <= cfg.trim_days_before) {
    const span = Math.max(1, cfg.trim_days_before - cfg.block_days_before);
    const progress = (days - cfg.block_days_before) / span; // 0 → tightest, 1 → widest
    const mult = cfg.trim_floor + (1 - cfg.trim_floor) * progress;
    return {
      action: "trim",
      size_multiplier: Math.max(cfg.trim_floor, Math.min(1, mult)),
      days_until: days,
      reason: `earnings in ${days}d — trimmed to ${(mult * 100).toFixed(0)}%`,
    };
  }
  return { action: "allow", size_multiplier: 1, days_until: days, reason: `earnings in ${days}d — outside window` };
}
