// Cash-vs-scrip impact preview.
//
// Given a pending corporate action, the position you hold, and a reference
// price, estimate what each election would do to your cash balance and your
// share count. This is an ESTIMATE for comparison only — the registrar's
// actual terms (fractional handling, withholding tax, scrip reference price)
// take precedence, and Aegis never submits the election itself.

import type { CorporateActionOption } from "./corporate-actions";

export type ImpactPosition = {
  /** Shares currently held. */
  quantity: number;
  /** Reference price per share, in `currency` (major units). */
  price: number | null;
  /** Currency of `price` and of the cash effect. */
  currency: string;
};

export type ElectionImpact = {
  optionId: string | null;
  label: string;
  kind: CorporateActionOption["kind"];
  isDefault: boolean;
  /** Change in cash, in the position currency. Positive = cash received. */
  cashDelta: number;
  /** Whole new shares received. */
  sharesDelta: number;
  /** Share count after the event. */
  sharesAfter: number;
  /** Cash paid in lieu of a fractional entitlement. */
  fractionalCash: number;
  /** Value of the entitlement however it is taken (cash + new shares). */
  totalValue: number;
  /** True when the numbers rest on an assumption rather than published terms. */
  estimated: boolean;
  /** Short plain-language explanation of the maths used. */
  basis: string;
};

export type ImpactPreview = {
  position: ImpactPosition;
  impacts: ElectionImpact[];
  /** Set when nothing could be estimated (no position, no rate, no price). */
  unavailableReason: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimate one election. `entitlementCash` is the gross cash the position
 * would generate (qty × rate); scrip options convert that into shares at
 * the reference price unless the terms publish an explicit ratio.
 */
export function estimateOptionImpact(
  option: CorporateActionOption,
  position: ImpactPosition,
  entitlementCash: number | null,
): ElectionImpact {
  const qty = position.quantity;
  const price = position.price && position.price > 0 ? position.price : null;
  const base: Omit<
    ElectionImpact,
    "cashDelta" | "sharesDelta" | "sharesAfter" | "fractionalCash" | "totalValue" | "basis"
  > = {
    optionId: option.id,
    label: option.label,
    kind: option.kind,
    isDefault: option.isDefault,
    estimated: true,
  };

  // Scrip / share election.
  if (option.kind === "securities" || option.kind === "mixed") {
    if (option.ratio != null && option.ratio > 0) {
      const raw = qty * option.ratio;
      const whole = Math.floor(raw);
      const fractionalCash = price ? round2((raw - whole) * price) : 0;
      return {
        ...base,
        cashDelta: fractionalCash,
        sharesDelta: whole,
        sharesAfter: qty + whole,
        fractionalCash,
        totalValue: round2((price ? whole * price : 0) + fractionalCash),
        estimated: !price,
        basis: `${qty} shares × ratio ${option.ratio.toFixed(4)}${
          price ? "; fraction paid in cash at the reference price" : ""
        }`,
      };
    }
    if (entitlementCash != null && price) {
      const raw = entitlementCash / price;
      const whole = Math.floor(raw);
      const fractionalCash = round2((raw - whole) * price);
      return {
        ...base,
        cashDelta: fractionalCash,
        sharesDelta: whole,
        sharesAfter: qty + whole,
        fractionalCash,
        totalValue: round2(whole * price + fractionalCash),
        estimated: true,
        basis: `entitlement of ${round2(entitlementCash)} ${position.currency} reinvested at ${round2(price)} ${position.currency}/share`,
      };
    }
    return {
      ...base,
      cashDelta: 0,
      sharesDelta: 0,
      sharesAfter: qty,
      fractionalCash: 0,
      totalValue: 0,
      estimated: true,
      basis: price
        ? "no rate or ratio published — share count cannot be estimated"
        : "no reference price available — share count cannot be estimated",
    };
  }

  // Cash election (and unknown options, which are treated as cash-like).
  const cash = entitlementCash != null ? round2(entitlementCash) : 0;
  return {
    ...base,
    cashDelta: cash,
    sharesDelta: 0,
    sharesAfter: qty,
    fractionalCash: 0,
    totalValue: cash,
    estimated: true,
    basis:
      entitlementCash != null
        ? `${qty} shares × ${round2(entitlementCash / Math.max(qty, 1))} ${position.currency}/share, before withholding tax`
        : "no cash rate published",
  };
}

/**
 * Build the full cash-vs-scrip preview for an event's options. The gross
 * entitlement is taken from whichever option publishes a per-share cash
 * rate, so a scrip option with no rate of its own can still be priced.
 */
export function buildImpactPreview(
  options: CorporateActionOption[],
  position: ImpactPosition | null,
): ImpactPreview {
  const pos: ImpactPosition = position ?? { quantity: 0, price: null, currency: "GBP" };
  if (!position || pos.quantity <= 0) {
    return {
      position: pos,
      impacts: [],
      unavailableReason: "No open position in this instrument — no impact to preview.",
    };
  }
  if (options.length === 0) {
    return {
      position: pos,
      impacts: [],
      unavailableReason: "No election options published for this event.",
    };
  }

  const rate =
    options.find((o) => o.kind === "cash" && o.rate != null)?.rate ??
    options.find((o) => o.rate != null)?.rate ??
    null;

  const impacts = options.map((o) =>
    estimateOptionImpact(
      o,
      pos,
      o.rate != null ? o.rate * pos.quantity : rate != null ? rate * pos.quantity : null,
    ),
  );

  const anyNumbers = impacts.some((i) => i.cashDelta !== 0 || i.sharesDelta !== 0);
  return {
    position: pos,
    impacts,
    unavailableReason: anyNumbers
      ? null
      : "Saxo has not published a rate or ratio for this event yet.",
  };
}

/** The option that leaves the most estimated value on the table, if any. */
export function bestValueOption(preview: ImpactPreview): ElectionImpact | null {
  const priced = preview.impacts.filter((i) => i.totalValue > 0);
  if (priced.length < 2) return null;
  const sorted = [...priced].sort((a, b) => b.totalValue - a.totalValue);
  // Treat a sub-0.5% gap as a tie: not worth calling a winner.
  if (sorted[0].totalValue - sorted[1].totalValue < sorted[0].totalValue * 0.005) return null;
  return sorted[0];
}
