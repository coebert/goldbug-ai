// Scaling commission model.
//
// The flat `commissionBps` + `minCommission` pair in the broker simulator is a
// crude approximation: real brokers charge (a) a venue-specific rate, (b) a
// per-share component on US listings, (c) a minimum floor per ticket, (d) a
// cap on large tickets, and (e) volume-tier discounts once monthly traded
// notional crosses breakpoints. On a £200 ticket the floor dominates; on a
// £50,000 ticket the cap does. This module models all five so execution costs
// vary realistically across assets and ticket sizes.
//
// Pure and I/O-free — no clock, no network, no randomness.

import type { AssetClass } from "./universe.server";
import { inferSaxoCurrency, SAXO_FEE_SCHEDULE } from "./saxo-fees";

/** One notional breakpoint in a tiered schedule. */
export type CommissionTier = {
  /** Applies when notional >= this value (trade currency). */
  fromNotional: number;
  /** Commission as bps of notional within this tier. */
  bps: number;
  /** Per-ticket minimum within this tier (trade currency). */
  min?: number;
  /** Per-ticket cap within this tier; 0/undefined means no cap. */
  cap?: number;
  /** Optional per-share/unit component (e.g. US $0.02/share). */
  perUnit?: number;
  /** Human label surfaced in logs and reports. */
  label?: string;
};

/** A venue schedule: ordered tiers plus optional cap as bps of notional. */
export type VenueCommissionSchedule = {
  venue: string;
  currency: string;
  /** Ordered ascending by `fromNotional`. First entry MUST be 0. */
  tiers: CommissionTier[];
  /** Hard cap expressed as bps of notional (applied after tiers). */
  capBps?: number;
};

/**
 * Monthly-volume discount ladder. `fromVolume` is the trailing monthly traded
 * notional (trade currency, or a common base — the caller decides); `multiplier`
 * scales the bps component (not the floor).
 */
export type VolumeDiscountTier = {
  fromVolume: number;
  multiplier: number;
  label?: string;
};

export type CommissionModel = {
  name: string;
  /** Per-currency venue schedules. */
  venues: Record<string, VenueCommissionSchedule>;
  fallback: VenueCommissionSchedule;
  /** Asset-class overrides applied before venue lookup. */
  assetOverrides?: Partial<Record<AssetClass, VenueCommissionSchedule>>;
  volumeDiscounts?: VolumeDiscountTier[];
};

export type CommissionInput = {
  /** Absolute notional of the fill in trade currency. */
  notional: number;
  /** Filled quantity (shares/units) — drives the per-unit component. */
  quantity?: number;
  symbol?: string | null;
  currency?: string | null;
  assetClass?: AssetClass | null;
  /** Trailing 30-day traded notional used for volume-tier discounts. */
  monthlyVolume?: number;
  model?: CommissionModel;
};

export type CommissionBreakdown = {
  /** Total per-side commission in trade currency. */
  commission: number;
  /** Commission expressed as bps of notional (Infinity when notional <= 0). */
  bps: number;
  /** Component view — always sums (before floor/cap) to `rawCommission`. */
  adValorem: number;
  perUnit: number;
  rawCommission: number;
  minFloorApplied: boolean;
  capApplied: boolean;
  volumeMultiplier: number;
  tier: CommissionTier;
  venue: string;
  currency: string;
};

const tier = (t: CommissionTier): CommissionTier => t;

/**
 * Saxo-like default: floors on small tickets, decreasing bps as notional
 * grows, and a per-share component on US listings.
 */
export const SCALING_COMMISSION_MODEL: CommissionModel = {
  name: "saxo-scaling",
  venues: {
    GBP: {
      venue: "LSE",
      currency: "GBP",
      tiers: [
        tier({ fromNotional: 0, bps: 8, min: 3, label: "LSE <5k" }),
        tier({ fromNotional: 5_000, bps: 6, min: 3, label: "LSE 5k-25k" }),
        tier({ fromNotional: 25_000, bps: 4, min: 3, label: "LSE 25k-100k" }),
        tier({ fromNotional: 100_000, bps: 3, min: 3, cap: 120, label: "LSE 100k+" }),
      ],
    },
    USD: {
      venue: "US",
      currency: "USD",
      tiers: [
        tier({ fromNotional: 0, bps: 0, min: 1, perUnit: 0.02, label: "US <10k" }),
        tier({ fromNotional: 10_000, bps: 0, min: 1, perUnit: 0.015, label: "US 10k-50k" }),
        tier({ fromNotional: 50_000, bps: 0, min: 1, perUnit: 0.01, cap: 150, label: "US 50k+" }),
      ],
    },
    EUR: {
      venue: "EU",
      currency: "EUR",
      tiers: [
        tier({ fromNotional: 0, bps: 8, min: 3, label: "EU <5k" }),
        tier({ fromNotional: 5_000, bps: 6, min: 3, label: "EU 5k-50k" }),
        tier({ fromNotional: 50_000, bps: 4, min: 3, cap: 150, label: "EU 50k+" }),
      ],
    },
    CHF: {
      venue: "SIX",
      currency: "CHF",
      tiers: [
        tier({ fromNotional: 0, bps: 10, min: 3, label: "SIX <10k" }),
        tier({ fromNotional: 10_000, bps: 7, min: 3, cap: 200, label: "SIX 10k+" }),
      ],
    },
  },
  fallback: {
    venue: "default",
    currency: "USD",
    tiers: [
      tier({ fromNotional: 0, bps: 10, min: 3, label: "default <10k" }),
      tier({ fromNotional: 10_000, bps: 8, min: 3, cap: 200, label: "default 10k+" }),
    ],
  },
  assetOverrides: {
    crypto: {
      venue: "CRYPTO",
      currency: "USD",
      tiers: [
        tier({ fromNotional: 0, bps: 25, min: 1, label: "crypto <10k" }),
        tier({ fromNotional: 10_000, bps: 15, min: 1, label: "crypto 10k-100k" }),
        tier({ fromNotional: 100_000, bps: 10, min: 1, label: "crypto 100k+" }),
      ],
    },
  },
  volumeDiscounts: [
    { fromVolume: 0, multiplier: 1, label: "classic" },
    { fromVolume: 250_000, multiplier: 0.85, label: "platinum" },
    { fromVolume: 1_000_000, multiplier: 0.7, label: "vip" },
  ],
};

/** Derive a venue schedule from the legacy flat SAXO_FEE_SCHEDULE entry. */
function scheduleFromLegacy(ccy: string): VenueCommissionSchedule | null {
  const legacy = SAXO_FEE_SCHEDULE[ccy];
  if (!legacy) return null;
  return {
    venue: legacy.venue,
    currency: legacy.currency,
    tiers: [
      tier({
        fromNotional: 0,
        bps: legacy.rate * 10_000,
        min: legacy.min,
        ...(legacy.cap ? { cap: legacy.cap } : {}),
        label: `${legacy.venue} flat`,
      }),
    ],
  };
}

function pickTier(schedule: VenueCommissionSchedule, notional: number): CommissionTier {
  const sorted = [...schedule.tiers].sort((a, b) => a.fromNotional - b.fromNotional);
  let chosen = sorted[0] ?? tier({ fromNotional: 0, bps: 0 });
  for (const t of sorted) if (notional >= t.fromNotional) chosen = t;
  return chosen;
}

function pickVolumeMultiplier(model: CommissionModel, monthlyVolume: number): number {
  const ladder = model.volumeDiscounts;
  if (!ladder || ladder.length === 0) return 1;
  let mult = 1;
  for (const t of [...ladder].sort((a, b) => a.fromVolume - b.fromVolume)) {
    if (monthlyVolume >= t.fromVolume) mult = t.multiplier;
  }
  return mult;
}

/**
 * Compute the per-side commission for a fill. Scales with notional (tier bps
 * + floor + cap), with quantity (per-unit component), and with the caller's
 * trailing monthly volume (discount ladder).
 */
export function computeCommission(input: CommissionInput): CommissionBreakdown {
  const model = input.model ?? SCALING_COMMISSION_MODEL;
  const notional = Math.max(0, Number(input.notional) || 0);
  const quantity = Math.max(0, Number(input.quantity) || 0);
  const ccy = (
    input.currency ?? (input.symbol ? inferSaxoCurrency(input.symbol) : "USD")
  ).toUpperCase();

  const schedule =
    (input.assetClass ? model.assetOverrides?.[input.assetClass] : undefined)
    ?? model.venues[ccy]
    ?? scheduleFromLegacy(ccy)
    ?? model.fallback;

  const t = pickTier(schedule, notional);
  const volumeMultiplier = pickVolumeMultiplier(model, Math.max(0, input.monthlyVolume ?? 0));

  const adValorem = notional * ((t.bps ?? 0) / 10_000) * volumeMultiplier;
  const perUnit = quantity * (t.perUnit ?? 0) * volumeMultiplier;
  const rawCommission = adValorem + perUnit;

  let commission = rawCommission;
  const floor = t.min ?? 0;
  const minFloorApplied = commission < floor;
  if (minFloorApplied) commission = floor;

  let capApplied = false;
  const caps: number[] = [];
  if (t.cap && t.cap > 0) caps.push(t.cap);
  if (schedule.capBps && schedule.capBps > 0) caps.push(notional * (schedule.capBps / 10_000));
  if (caps.length > 0) {
    const cap = Math.min(...caps);
    if (commission > cap) {
      commission = cap;
      capApplied = true;
    }
  }

  return {
    commission,
    bps: notional > 0 ? (commission / notional) * 10_000 : Number.POSITIVE_INFINITY,
    adValorem,
    perUnit,
    rawCommission,
    minFloorApplied,
    capApplied,
    volumeMultiplier,
    tier: t,
    venue: schedule.venue,
    currency: schedule.currency,
  };
}

/**
 * Notional at which the ad-valorem/per-unit cost overtakes the floor for the
 * given context — below this, the ticket is paying more than the headline rate.
 */
export function commissionBreakevenNotional(
  ctx: Omit<CommissionInput, "notional" | "quantity">,
): number {
  const probe = computeCommission({ ...ctx, notional: 1_000_000, quantity: 0 });
  const floor = probe.tier.min ?? 0;
  const rate = (probe.tier.bps ?? 0) / 10_000;
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  return floor / (rate * probe.volumeMultiplier || rate);
}
