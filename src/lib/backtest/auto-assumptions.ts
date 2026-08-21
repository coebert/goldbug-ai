// Automatic execution assumptions: fees, spread and slippage derived from the
// book's own evidence instead of a hand-picked preset.
//
// Choosing between `optimistic` / `realistic` / `pessimistic` is a judgement
// call nobody should have to make before every backtest. We already hold three
// independent pieces of evidence about what execution actually costs here:
//
//   • daily bars      → Corwin-Schultz / Roll half-spread per symbol
//                       (`execution-calibration-from-bars`)
//   • invoiced fills  → what Saxo really charged vs what the fee model said
//                       (`live_fills.fee_commission` / `fee_tax`)
//   • order vs fill   → realised adverse move between the reference price the
//                       decision used and the price we actually got
//
// This module folds those into one `ExecutionAssumptions` object, field by
// field, and falls back to the `realistic` preset for any field whose sample is
// too thin to trust. Every field carries a `basis` record so a report can say
// exactly where the number came from and how many observations back it.
//
// Pure, deterministic and I/O-free — the server loader supplies the samples.

import {
  ASSUMPTION_PRESETS,
  resolveAssumptions,
  type AssumptionPresetId,
  type ExecutionAssumptions,
} from "./execution-assumptions";
import type { FeeScheduleDefaults } from "./fee-schedule-import";

/** One symbol's calibrated full quoted spread, in bps of mid. */
export type SpreadSample = {
  symbol: string;
  /** FULL quoted spread (2 x half-spread) in bps. */
  fullSpreadBps: number;
  /** Bars behind the estimate; thin samples are ignored. */
  sampleBars: number;
  /** How the estimate was produced, for the basis note. */
  source?: string;
};

/** One invoiced ticket compared with what the fee model predicted. */
export type FeeSample = {
  notional: number;
  invoicedCommission: number;
  modelledCommission: number;
  /** UK stamp/PTM style taxes actually invoiced. */
  invoicedTax?: number | null;
  modelledStamp?: number | null;
};

/** One fill compared with the price the decision was priced against. */
export type SlippageSample = {
  symbol: string;
  side: "buy" | "sell";
  referencePrice: number;
  fillPrice: number;
};

export type AutoAssumptionInput = {
  spreads?: readonly SpreadSample[];
  fees?: readonly FeeSample[];
  slippage?: readonly SlippageSample[];
  /** Observed FX funding-leg spread in bps, when the broker reports one. */
  fxSpreadBpsSamples?: readonly number[];
  /** Preset used for any field without enough evidence. Default `realistic`. */
  fallbackPreset?: AssumptionPresetId;
  /**
   * Optional imported broker fee schedule (see `fee-schedule-import`). Used
   * for commission, the per-ticket floor, stamp duty and the PTM levy when we
   * do not have enough invoiced tickets to measure them directly. Real
   * invoices always win over a published tariff.
   */
  feeSchedule?: FeeScheduleDefaults | null;
};

export type FieldBasis = {
  field: keyof ExecutionAssumptions;
  value: number;
  /** `derived` when the data decided it, `fallback` when the preset did. */
  origin: "derived" | "fallback";
  samples: number;
  note: string;
};

export type AutoAssumptionResult = {
  assumptions: ExecutionAssumptions;
  basis: FieldBasis[];
  /** Fields actually driven by data. */
  derivedFields: string[];
  /** One-line summary for reports and card subtitles. */
  summary: string;
};

/** Minimum observations before a field stops using the preset fallback. */
export const MIN_SPREAD_SYMBOLS = 3;
export const MIN_SPREAD_BARS = 40;
export const MIN_FEE_TICKETS = 5;
export const MIN_SLIPPAGE_FILLS = 8;

/** Sanity rails — no estimator may make trading look free or absurd. */
const CLAMPS = {
  spreadBps: [2, 80] as const,
  symbolSpreadBps: [1, 150] as const,
  commissionMult: [0.5, 2] as const,
  stampMult: [0, 1.5] as const,
  slippageBps: [0, 25] as const,
  fxSpreadBps: [0, 30] as const,
};

const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const round = (v: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/**
 * Derive a complete assumption set from whatever evidence is available.
 * Missing or thin evidence is not an error: the field simply keeps the
 * fallback preset's value and says so in its basis note.
 */
export function deriveAutoAssumptions(
  input: AutoAssumptionInput = {},
): AutoAssumptionResult {
  const fallbackId: AssumptionPresetId = input.fallbackPreset ?? "realistic";
  const fb = ASSUMPTION_PRESETS[fallbackId];
  const basis: FieldBasis[] = [];

  const usable = (input.spreads ?? []).filter(
    (s) =>
      isFin(s.fullSpreadBps) &&
      s.fullSpreadBps > 0 &&
      isFin(s.sampleBars) &&
      s.sampleBars >= MIN_SPREAD_BARS,
  );

  // ---- spread -------------------------------------------------------------
  let spreadBps = fb.spreadBps;
  let spreadBpsBySymbol: Record<string, number> | undefined;
  if (usable.length >= MIN_SPREAD_SYMBOLS) {
    spreadBps = round(clamp(median(usable.map((s) => s.fullSpreadBps)), CLAMPS.spreadBps));
    spreadBpsBySymbol = {};
    for (const s of usable) {
      spreadBpsBySymbol[s.symbol.toUpperCase()] = round(
        clamp(s.fullSpreadBps, CLAMPS.symbolSpreadBps),
      );
    }
    const sources = [...new Set(usable.map((s) => s.source).filter(Boolean))].join("/");
    basis.push({
      field: "spreadBps",
      value: spreadBps,
      origin: "derived",
      samples: usable.length,
      note:
        `median calibrated spread across ${usable.length} symbols` +
        (sources ? ` (${sources})` : "") + ", per-symbol overrides applied",
    });
  } else {
    basis.push({
      field: "spreadBps",
      value: spreadBps,
      origin: "fallback",
      samples: usable.length,
      note: `only ${usable.length} calibrated symbols (need ${MIN_SPREAD_SYMBOLS}) — using ${fallbackId} preset`,
    });
  }

  // ---- commission & stamp -------------------------------------------------
  const fees = (input.fees ?? []).filter(
    (f) => isFin(f.modelledCommission) && f.modelledCommission > 0 && isFin(f.invoicedCommission) && f.invoicedCommission >= 0,
  );
  let commissionMult = fb.commissionMult;
  if (fees.length >= MIN_FEE_TICKETS) {
    const invoiced = fees.reduce((s, f) => s + f.invoicedCommission, 0);
    const modelled = fees.reduce((s, f) => s + f.modelledCommission, 0);
    commissionMult = round(clamp(invoiced / modelled, CLAMPS.commissionMult), 2);
    basis.push({
      field: "commissionMult",
      value: commissionMult,
      origin: "derived",
      samples: fees.length,
      note: `invoiced £${round(invoiced, 2)} vs modelled £${round(modelled, 2)} over ${fees.length} tickets`,
    });
  } else if (input.feeSchedule) {
    commissionMult = clamp(input.feeSchedule.commissionMult, CLAMPS.commissionMult);
    basis.push({
      field: "commissionMult",
      value: commissionMult,
      origin: "derived",
      samples: 0,
      note: `imported fee schedule — ${input.feeSchedule.note}`,
    });
  } else {
    basis.push({
      field: "commissionMult",
      value: commissionMult,
      origin: "fallback",
      samples: fees.length,
      note: `only ${fees.length} invoiced tickets (need ${MIN_FEE_TICKETS}) — keeping the live fee schedule`,
    });
  }

  const stampable = (input.fees ?? []).filter(
    (f) => isFin(f.modelledStamp) && (f.modelledStamp ?? 0) > 0 && isFin(f.invoicedTax),
  );
  let stampMult = fb.stampMult;
  if (stampable.length >= MIN_FEE_TICKETS) {
    const invoiced = stampable.reduce((s, f) => s + (f.invoicedTax ?? 0), 0);
    const modelled = stampable.reduce((s, f) => s + (f.modelledStamp ?? 0), 0);
    stampMult = round(clamp(invoiced / modelled, CLAMPS.stampMult), 2);
    basis.push({
      field: "stampMult",
      value: stampMult,
      origin: "derived",
      samples: stampable.length,
      note: `invoiced tax £${round(invoiced, 2)} vs modelled stamp £${round(modelled, 2)}`,
    });
  } else if (input.feeSchedule) {
    stampMult = clamp(input.feeSchedule.stampMult, CLAMPS.stampMult);
    basis.push({
      field: "stampMult",
      value: stampMult,
      origin: "derived",
      samples: 0,
      note: `imported fee schedule stamp/levy rates (${input.feeSchedule.note})`,
    });
  } else {
    basis.push({
      field: "stampMult",
      value: stampMult,
      origin: "fallback",
      samples: stampable.length,
      note: "not enough stampable tickets — charging full UK stamp duty",
    });
  }

  // ---- slippage -----------------------------------------------------------
  // Realised adverse move already contains the half-spread we charge
  // separately, so net it off before booking the remainder as slippage.
  const slipSamples: number[] = [];
  for (const s of input.slippage ?? []) {
    if (!isFin(s.referencePrice) || !isFin(s.fillPrice)) continue;
    if (s.referencePrice <= 0 || s.fillPrice <= 0) continue;
    const dir = s.side === "buy" ? 1 : -1;
    const adverseBps = ((s.fillPrice / s.referencePrice - 1) * 10_000) * dir;
    if (!Number.isFinite(adverseBps) || Math.abs(adverseBps) > 1_000) continue;
    const halfSpread =
      (spreadBpsBySymbol?.[s.symbol.toUpperCase()] ?? spreadBps) / 2;
    slipSamples.push(Math.max(0, adverseBps - halfSpread));
  }
  let slippageBps = fb.slippageBps;
  if (slipSamples.length >= MIN_SLIPPAGE_FILLS) {
    slippageBps = round(clamp(median(slipSamples), CLAMPS.slippageBps));
    basis.push({
      field: "slippageBps",
      value: slippageBps,
      origin: "derived",
      samples: slipSamples.length,
      note: `median adverse move over ${slipSamples.length} fills, net of the modelled half-spread`,
    });
  } else {
    basis.push({
      field: "slippageBps",
      value: slippageBps,
      origin: "fallback",
      samples: slipSamples.length,
      note: `only ${slipSamples.length} priced fills (need ${MIN_SLIPPAGE_FILLS}) — using ${fallbackId} preset`,
    });
  }

  // ---- FX funding leg -----------------------------------------------------
  const fx = (input.fxSpreadBpsSamples ?? []).filter((v) => isFin(v) && v >= 0);
  let fxSpreadBps = fb.fxSpreadBps;
  if (fx.length >= MIN_FEE_TICKETS) {
    fxSpreadBps = round(clamp(median(fx), CLAMPS.fxSpreadBps));
    basis.push({
      field: "fxSpreadBps",
      value: fxSpreadBps,
      origin: "derived",
      samples: fx.length,
      note: `median observed funding-leg spread over ${fx.length} conversions`,
    });
  } else if (input.feeSchedule?.fxSpreadBps != null) {
    fxSpreadBps = clamp(input.feeSchedule.fxSpreadBps, CLAMPS.fxSpreadBps);
    basis.push({
      field: "fxSpreadBps",
      value: fxSpreadBps,
      origin: "derived",
      samples: 0,
      note: "imported fee schedule funding-leg spread",
    });
  } else {
    basis.push({
      field: "fxSpreadBps",
      value: fxSpreadBps,
      origin: "fallback",
      samples: fx.length,
      note: `${fallbackId} preset funding-leg spread`,
    });
  }

  // Impact and delay stay on the preset: neither can be observed from fills
  // we already place in small size against the touch.
  basis.push({
    field: "impactBps",
    value: fb.impactBps,
    origin: "fallback",
    samples: 0,
    note: `${fallbackId} sqrt-law impact @ £${fb.impactRefNotionalBase.toLocaleString("en-GB")}`,
  });
  basis.push({
    field: "delayBps",
    value: fb.delayBps,
    origin: "fallback",
    samples: 0,
    note: `${fallbackId} urgency/delay toll`,
  });

  const assumptions = resolveAssumptions(
    {
      commissionMult,
      stampMult,
      spreadBps,
      spreadBpsBySymbol,
      slippageBps,
      fxSpreadBps,
      ...(input.feeSchedule
        ? {
            commissionFloorBase: input.feeSchedule.commissionFloorBase,
            ptmLevy: input.feeSchedule.ptmLevy,
          }
        : {}),
    },
    fallbackId,
  );

  const derivedFields = basis.filter((b) => b.origin === "derived").map((b) => b.field);
  const summary = derivedFields.length
    ? `auto-calibrated (${derivedFields.join(", ")}); rest from ${fallbackId}`
    : `no execution evidence yet — full ${fallbackId} preset`;

  return { assumptions, basis, derivedFields, summary };
}

/** Human-readable multi-line explanation of where each number came from. */
export function describeAutoAssumptions(result: AutoAssumptionResult): string {
  return [
    result.summary,
    ...result.basis.map(
      (b) => `  ${b.field} = ${b.value} — ${b.origin}: ${b.note}`,
    ),
  ].join("\n");
}
