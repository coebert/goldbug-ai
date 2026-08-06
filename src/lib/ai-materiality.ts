// Materiality gate for the per-tick AI decision call.
//
// The hourly cron calls the LLM once per portfolio per hour regardless of
// whether anything actually changed. Most overnight/quiet ticks re-send an
// identical market picture and get back "hold". This module fingerprints the
// *material* inputs to a decision so the engine can skip the LLM call when
// nothing moved, while still running every deterministic guardrail (stops,
// trailing exits, reconciliation) as normal.
//
// Pure and I/O-free — the caller owns persistence of the last fingerprint.

import { createHash } from "node:crypto";

export type MaterialityInputs = {
  regime: string | null | undefined;
  /** Symbol → price actually used for this tick's decision. */
  prices: Record<string, number>;
  /** Symbols currently held (a new/closed position is always material). */
  heldSymbols: string[];
  /** Count of news items scored since the previous tick. */
  freshNewsCount: number;
  /** Cash available to deploy. */
  cash: number;
  /** Total portfolio value. */
  totalValue: number;
};

/** Price moves below this (in bps) are treated as noise. */
export const PRICE_NOISE_BPS = 40;

/** Cash/NAV moves below this fraction are treated as noise. */
export const VALUE_NOISE_PCT = 0.005;

/** Force a real AI call at least this often, however quiet the tape. */
export const MAX_SKIP_HOURS = 6;

/**
 * Quantise a price into `PRICE_NOISE_BPS` buckets so sub-noise wiggles produce
 * an identical fingerprint.
 */
function bucketPrice(price: number): number {
  if (!(price > 0)) return 0;
  const step = 1 + PRICE_NOISE_BPS / 10_000;
  return Math.round(Math.log(price) / Math.log(step));
}

function bucketValue(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 0;
  const step = 1 + VALUE_NOISE_PCT;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.round(Math.log(Math.abs(v)) / Math.log(step));
}

/** Stable hash of everything that should trigger a fresh AI opinion. */
export function fingerprintDecisionInputs(input: MaterialityInputs): string {
  const priceParts = Object.keys(input.prices)
    .sort()
    .map((sym) => `${sym}:${bucketPrice(input.prices[sym] ?? 0)}`);
  const payload = [
    `regime=${input.regime ?? "unknown"}`,
    `held=${[...input.heldSymbols].sort().join(",")}`,
    `cash=${bucketValue(input.cash)}`,
    `nav=${bucketValue(input.totalValue)}`,
    `px=${priceParts.join("|")}`,
  ].join(";");
  return createHash("sha256").update(payload).digest("hex");
}

export type MaterialityDecision = {
  /** True when the LLM should be called. */
  callAi: boolean;
  fingerprint: string;
  reason: string;
};

/**
 * Decide whether this tick warrants a fresh LLM call.
 *
 * Always calls when: no prior fingerprint, the fingerprint changed, fresh news
 * arrived, or the last real call is older than `MAX_SKIP_HOURS`.
 */
export function assessDecisionMateriality(args: {
  inputs: MaterialityInputs;
  previousFingerprint: string | null | undefined;
  previousCallAt: string | Date | null | undefined;
  now?: Date;
  maxSkipHours?: number;
}): MaterialityDecision {
  const fingerprint = fingerprintDecisionInputs(args.inputs);
  const now = args.now ?? new Date();
  const maxSkipHours = args.maxSkipHours ?? MAX_SKIP_HOURS;

  if (!args.previousFingerprint) {
    return { callAi: true, fingerprint, reason: "no prior decision fingerprint" };
  }
  if (args.previousFingerprint !== fingerprint) {
    return { callAi: true, fingerprint, reason: "material change in prices/holdings/regime" };
  }
  if (args.inputs.freshNewsCount > 0) {
    return {
      callAi: true,
      fingerprint,
      reason: `${args.inputs.freshNewsCount} fresh news item(s) since last decision`,
    };
  }
  const prev = args.previousCallAt ? new Date(args.previousCallAt) : null;
  const ageHours =
    prev && Number.isFinite(prev.getTime())
      ? (now.getTime() - prev.getTime()) / 3_600_000
      : Infinity;
  if (ageHours >= maxSkipHours) {
    return {
      callAi: true,
      fingerprint,
      reason: `last AI decision ${ageHours.toFixed(1)}h ago (max ${maxSkipHours}h)`,
    };
  }
  return {
    callAi: false,
    fingerprint,
    reason: `no material change since last decision ${ageHours.toFixed(1)}h ago`,
  };
}
