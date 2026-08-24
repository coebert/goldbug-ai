/**
 * Unit validation for rows on their way into the valuation kernel.
 *
 * The kernel assumes every price, fee and cash figure it is handed is already
 * in the instrument's *major* unit: pounds, not pence. Broker feeds do not
 * honour that. Saxo labels LSE money as `GBp` on some report shapes and `GBP`
 * on others, and the two look identical once a caller upper-cases the string —
 * which is exactly how a 5.40 GBp stamp charge became £5.40 and how a pence
 * fill price got mixed in beside pounds on the same tape.
 *
 * A 100x error in one row does not fail loudly; it quietly re-weights a whole
 * portfolio. So mixed-unit rows are caught *at ingestion*, before anything
 * downstream can average, sum or value them:
 *
 *   - a minor-unit label (GBp/GBX/ZAc/ILA) is recognised and rescaled;
 *   - a number whose magnitude contradicts its label is flagged and blocked
 *     rather than guessed at, because an unexplained 100x could equally be a
 *     genuinely large charge and silently dividing it would hide real money.
 *
 * Pure: no I/O, no clock.
 */

import { isLseGbxDisplayQuoted } from "../market-price-units";

export type UnitFlagCode =
  /** Currency label is a minor unit (GBp, GBX, ZAc…). Rescaled, not blocked. */
  | "minor_unit_label"
  /** Price magnitude says pence while the label says pounds. */
  | "price_scale_mismatch"
  /** Charge is an implausible share of the trade, consistent with a 100x. */
  | "fee_scale_mismatch"
  /** Charge currency and fill currency disagree on the *unit*, not the code. */
  | "unit_disagreement"
  /** Currency code is missing or unusable. */
  | "unknown_currency";

export type UnitFlag = {
  code: UnitFlagCode;
  /** `warn` rows are rescaled and let through; `block` rows are held back. */
  severity: "warn" | "block";
  message: string;
  /** Observed / expected, where a scale was measurable. */
  ratio?: number;
};

export type CurrencyUnit = {
  /** ISO code the amount converts to once rescaled. */
  code: string;
  /** True when the raw label denominates the amount in minor units. */
  minor: boolean;
  /** Multiply a raw amount by this to reach the major unit. */
  scale: number;
  /** The label as the broker sent it. */
  raw: string;
};

const MINOR_UNITS: Record<string, { code: string; scale: number }> = {
  GBX: { code: "GBP", scale: 0.01 },
  "GBP.GBX": { code: "GBP", scale: 0.01 },
  GBPX: { code: "GBP", scale: 0.01 },
  ZAC: { code: "ZAR", scale: 0.01 },
  ILA: { code: "ILS", scale: 0.01 },
  USX: { code: "USD", scale: 0.01 },
};

/**
 * Resolve a broker currency label into a major-unit code plus a scale.
 *
 * Case matters before it stops mattering: `GBp` is pence and `GBP` is pounds,
 * and the difference vanishes on `.toUpperCase()`. The mixed-case form is
 * therefore tested against the raw string first.
 */
export function classifyCurrencyUnit(raw: string | null | undefined): CurrencyUnit {
  const text = String(raw ?? "").trim();
  if (text === "GBp" || text === "gbp.gbx") {
    return { code: "GBP", minor: true, scale: 0.01, raw: text };
  }
  const upper = text.toUpperCase();
  const minor = MINOR_UNITS[upper];
  if (minor) return { code: minor.code, minor: true, scale: minor.scale, raw: text };
  return { code: upper || "GBP", minor: false, scale: 1, raw: text };
}

/** True when the two labels mean the same money but at different scales. */
export function unitsDisagree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = classifyCurrencyUnit(a);
  const y = classifyCurrencyUnit(b);
  return x.code === y.code && x.minor !== y.minor;
}

/** Ratios within this band of 100 read as a unit error rather than a price move. */
const SCALE_LO = 25;
const SCALE_HI = 400;
/** A round-trip charge above this share of notional cannot be real. */
const FEE_SHARE_ABSURD = 0.2;
/** …and below this share it is unremarkable. */
const FEE_SHARE_NORMAL = 0.05;

export type FillUnitCheckInput = {
  id?: string;
  symbol: string;
  /** Price as stored/received, in whatever unit `currency` claims. */
  price: number;
  quantity?: number;
  currency: string | null | undefined;
  /** Independent major-unit price for the same instrument, when known. */
  referencePrice?: number | null;
};

export type UnitCheckResult = {
  id: string | null;
  flags: UnitFlag[];
  /** True when at least one flag is `block`: keep this row out of the kernel. */
  blocked: boolean;
  /** Amounts after any safe rescale of a minor-unit label. */
  normalised: { price: number; currency: string; fee?: number; feeCurrency?: string };
  /** One-line reason suitable for a `*_sync_reason` column. */
  reason: string | null;
};

function finish(id: string | null, flags: UnitFlag[], normalised: UnitCheckResult["normalised"]): UnitCheckResult {
  const blocked = flags.some((f) => f.severity === "block");
  return {
    id,
    flags,
    blocked,
    normalised,
    reason: flags.length === 0 ? null : flags.map((f) => f.message).join("; "),
  };
}

/**
 * Validate one price row (a fill, a quote, a cost-basis line) before it is
 * mixed with other money.
 */
export function checkFillUnits(input: FillUnitCheckInput): UnitCheckResult {
  const flags: UnitFlag[] = [];
  const unit = classifyCurrencyUnit(input.currency);
  const price = Number.isFinite(input.price) ? input.price : 0;

  if (!unit.raw) {
    flags.push({
      code: "unknown_currency",
      severity: "warn",
      message: "no currency on the row; assumed GBP",
    });
  }

  let normalisedPrice = price;
  if (unit.minor) {
    normalisedPrice = price * unit.scale;
    flags.push({
      code: "minor_unit_label",
      severity: "warn",
      message: `${unit.raw} is a minor unit; rescaled to ${unit.code}`,
      ratio: 1 / unit.scale,
    });
  }

  const ref = Number(input.referencePrice);
  if (Number.isFinite(ref) && ref > 0 && normalisedPrice > 0) {
    const ratio = normalisedPrice / ref;
    if (ratio >= SCALE_LO && ratio <= SCALE_HI) {
      flags.push({
        code: "price_scale_mismatch",
        severity: "block",
        message: `price is ~${Math.round(ratio)}x the reference — looks like pence booked as ${unit.code}`,
        ratio,
      });
    } else if (ratio <= 1 / SCALE_LO && ratio >= 1 / SCALE_HI) {
      flags.push({
        code: "price_scale_mismatch",
        severity: "block",
        message: `price is ~1/${Math.round(1 / ratio)} of the reference — looks like ${unit.code} folded twice`,
        ratio,
      });
    }
  } else if (!unit.minor && isLseGbxDisplayQuoted(input.symbol) && unit.code === "GBP") {
    // No reference to compare against. A GBX-quoted London line labelled GBP
    // is only suspicious if nothing else can confirm the scale, so this stays
    // a warning: the kernel still has its own unit resolution behind it.
    flags.push({
      code: "unit_disagreement",
      severity: "warn",
      message: `${input.symbol} quotes in GBX but the row is labelled GBP; scale unverified`,
    });
  }

  return finish(input.id ?? null, flags, { price: normalisedPrice, currency: unit.code });
}

export type ChargeUnitCheckInput = {
  id?: string;
  symbol: string;
  quantity: number;
  /** Fill price in the fill's own currency. */
  fillPrice: number;
  fillCurrency: string | null | undefined;
  /** Total charge as the broker stated it. */
  chargeTotal: number;
  chargeCurrency: string | null | undefined;
};

/**
 * Validate a broker charge against the trade it is being written onto.
 *
 * The charge and the fill must end up in the same unit before the fee touches
 * the tape. Where the labels disagree only in scale we rescale; where the
 * *magnitude* is absurd relative to the notional — a fee worth a fifth of the
 * trade — the row is blocked so it stays on modelled costs instead of poisoning
 * the friction KPI and the kernel's cash line.
 */
export function checkChargeUnits(input: ChargeUnitCheckInput): UnitCheckResult {
  const flags: UnitFlag[] = [];
  const fillUnit = classifyCurrencyUnit(input.fillCurrency);
  const chargeUnit = classifyCurrencyUnit(input.chargeCurrency || input.fillCurrency);

  let total = Number.isFinite(input.chargeTotal) ? input.chargeTotal : 0;
  if (chargeUnit.minor) {
    total = total * chargeUnit.scale;
    flags.push({
      code: "minor_unit_label",
      severity: "warn",
      message: `charge stated in ${chargeUnit.raw}; rescaled to ${chargeUnit.code}`,
      ratio: 1 / chargeUnit.scale,
    });
  }
  if (unitsDisagree(input.chargeCurrency, input.fillCurrency)) {
    flags.push({
      code: "unit_disagreement",
      severity: "warn",
      message: `charge in ${chargeUnit.raw || chargeUnit.code} against a fill in ${fillUnit.raw || fillUnit.code}`,
    });
  }

  const fillPriceMajor = (Number(input.fillPrice) || 0) * fillUnit.scale;
  const notional = Math.abs(fillPriceMajor * (Number(input.quantity) || 0));
  if (notional > 0 && total > 0 && chargeUnit.code === fillUnit.code) {
    const share = total / notional;
    if (share > FEE_SHARE_ABSURD && share / 100 < FEE_SHARE_NORMAL) {
      flags.push({
        code: "fee_scale_mismatch",
        severity: "block",
        message: `charge is ${(share * 100).toFixed(0)}% of the trade — consistent with a pence/pound mix-up`,
        ratio: share * 100,
      });
    } else if (share > FEE_SHARE_ABSURD) {
      flags.push({
        code: "fee_scale_mismatch",
        severity: "block",
        message: `charge is ${(share * 100).toFixed(0)}% of the trade — implausible, held for review`,
        ratio: share * 100,
      });
    }
  }

  return finish(input.id ?? null, flags, {
    price: fillPriceMajor,
    currency: fillUnit.code,
    fee: total,
    feeCurrency: chargeUnit.code,
  });
}

export type UnitValidationSummary = {
  checked: number;
  rescaled: number;
  blocked: number;
  byCode: Record<string, number>;
  /** Ids held back from the kernel, for logging. */
  blockedIds: string[];
};

export function summariseUnitChecks(results: readonly UnitCheckResult[]): UnitValidationSummary {
  const byCode: Record<string, number> = {};
  let rescaled = 0;
  let blocked = 0;
  const blockedIds: string[] = [];
  for (const r of results) {
    for (const f of r.flags) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (r.flags.some((f) => f.code === "minor_unit_label")) rescaled += 1;
    if (r.blocked) {
      blocked += 1;
      if (r.id) blockedIds.push(r.id);
    }
  }
  return { checked: results.length, rescaled, blocked, byCode, blockedIds };
}
