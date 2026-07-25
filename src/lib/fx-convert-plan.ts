// Phase D — pure planner for manual (user-initiated) FX conversions.
//
// Given a portfolio wallet, a from/to currency pair, the source amount, and
// the FX rate the caller intends to apply, compute the resulting wallet and
// destination amount without touching Supabase or the broker.
//
// Keeping this pure lets us unit-test every rejection reason and reuse the
// same math from both the "wallet-only" (synthetic) and "spot" execution
// paths in fx-convert.functions.ts.

import { applyDelta, walletBalance, type Wallet } from "./portfolio-wallet";

export type FxConversionRejectReason =
  | "SAME_CURRENCY"
  | "INVALID_AMOUNT"
  | "INVALID_RATE"
  | "INSUFFICIENT_CASH";

export type FxConversionPlan =
  | {
      ok: true;
      fromCcy: string;
      toCcy: string;
      amountFrom: number;
      amountTo: number;
      rate: number;
      newWallet: Wallet;
    }
  | {
      ok: false;
      reason: FxConversionRejectReason;
      detail: string;
    };

export interface PlanFxConversionInput {
  wallet: Wallet;
  from: string;
  to: string;
  amountFrom: number;
  rate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function planFxConversion(input: PlanFxConversionInput): FxConversionPlan {
  const from = (input.from || "").toUpperCase();
  const to = (input.to || "").toUpperCase();

  if (!from || !to || from === to) {
    return {
      ok: false,
      reason: "SAME_CURRENCY",
      detail: "From and to currencies must differ.",
    };
  }
  if (!Number.isFinite(input.amountFrom) || input.amountFrom <= 0) {
    return {
      ok: false,
      reason: "INVALID_AMOUNT",
      detail: "Amount must be a positive number.",
    };
  }
  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    return {
      ok: false,
      reason: "INVALID_RATE",
      detail: "FX rate must be a positive number.",
    };
  }

  const available = walletBalance(input.wallet, from);
  // Tiny tolerance for floating-point noise from prior wallet math.
  if (available + 1e-6 < input.amountFrom) {
    return {
      ok: false,
      reason: "INSUFFICIENT_CASH",
      detail: `Wallet holds ${round2(available)} ${from}; requested ${round2(input.amountFrom)} ${from}.`,
    };
  }

  const amountFrom = round2(input.amountFrom);
  const amountTo = round2(amountFrom * input.rate);
  const afterDebit = applyDelta(input.wallet, from, -amountFrom);
  const newWallet = applyDelta(afterDebit, to, amountTo);

  return {
    ok: true,
    fromCcy: from,
    toCcy: to,
    amountFrom,
    amountTo,
    rate: input.rate,
    newWallet,
  };
}
