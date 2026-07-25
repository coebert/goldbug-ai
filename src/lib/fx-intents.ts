// Typed FX intents — Phase 2 of the FX strategy plan.
//
// The AI emits high-level *intents* (pre_fund, hedge, sweep_idle, carry_tilt,
// close_hedge) instead of raw fx_conversions rows. `compileFxIntents` turns
// those intents into the legacy `FxConversionOrder[]` shape that
// applyAiFxConversions already knows how to execute, applying the Phase 3
// risk guardrails along the way:
//   - NAV-based exposure caps
//   - per-tick turnover ceiling (total base-ccy notional moved)
//   - minimum notional (skip dust conversions)
//   - per-currency single-tick 40% cap (also enforced by the applier)
//
// Pure module — no I/O, no server-only imports. Safe to unit test in
// isolation and safe for the AI prompt code to import for schema shape.

import { z } from "zod";
import type { FxConversionOrder } from "./ai-fx-conversions.server";

// -------- Schema ---------------------------------------------------------

const Ccy = z.string().length(3);

export const PreFundIntentSchema = z.object({
  kind: z.literal("pre_fund"),
  ccy: Ccy,                   // target ccy that needs funding
  notional_base: z.number().positive(), // amount in base ccy the buy will need
  reason: z.string(),
});

export const HedgeIntentSchema = z.object({
  kind: z.literal("hedge"),
  ccy: Ccy,                   // currency we're reducing exposure to
  reduce_pct: z.number().min(1).max(100), // % of wallet[ccy] to convert to base
  reason: z.string(),
});

export const SweepIdleIntentSchema = z.object({
  kind: z.literal("sweep_idle"),
  ccy: Ccy,                   // idle ccy to sweep back to base
  reason: z.string(),
});

export const CarryTiltIntentSchema = z.object({
  kind: z.literal("carry_tilt"),
  ccy: Ccy,                   // target ccy to tilt into (from base)
  tilt_pct_of_base: z.number().min(1).max(20), // % of base wallet to move
  reason: z.string(),
});

export const CloseHedgeIntentSchema = z.object({
  kind: z.literal("close_hedge"),
  ccy: Ccy,                   // ccy we previously hedged out of
  amount_base: z.number().positive(), // base-ccy amount to move back into ccy
  reason: z.string(),
});

export const FxIntentSchema = z.discriminatedUnion("kind", [
  PreFundIntentSchema,
  HedgeIntentSchema,
  SweepIdleIntentSchema,
  CarryTiltIntentSchema,
  CloseHedgeIntentSchema,
]);
export type FxIntent = z.infer<typeof FxIntentSchema>;

// -------- Guardrails -----------------------------------------------------

export interface FxGuardrails {
  navBase: number;                 // portfolio NAV in base ccy
  maxTurnoverPctOfNav: number;     // e.g. 25 -> at most 25% of NAV moved per tick
  minNotionalBase: number;         // e.g. 25 -> skip conversions below £25 equiv
  maxTiltExposurePctOfNav: number; // hard cap on total non-base tilt exposure
  perCurrencyMaxPct: number;       // per-tick % of any single-ccy balance (usually 40)
}

export const DEFAULT_GUARDRAILS: FxGuardrails = {
  navBase: 0, // caller must set
  maxTurnoverPctOfNav: 25,
  minNotionalBase: 25,
  maxTiltExposurePctOfNav: 20,
  perCurrencyMaxPct: 40,
};

// -------- Compiler -------------------------------------------------------

export interface CompileFxContext {
  baseCcy: string;
  wallet: Record<string, number>;           // ccy -> balance (native units)
  exposureBase: Record<string, number>;     // ccy -> exposure in base ccy
  ratesToBase: Record<string, number>;      // ccy -> rate multiplier: nativeAmt * rate = baseAmt
  guardrails: FxGuardrails;
}

export interface CompiledIntent {
  intent: FxIntent;
  order?: FxConversionOrder;
  skipped?: string;
  notionalBase: number;
}

function toBase(amount: number, ccy: string, ctx: CompileFxContext): number {
  if (ccy === ctx.baseCcy) return amount;
  const r = ctx.ratesToBase[ccy];
  if (!r || !Number.isFinite(r) || r <= 0) return 0;
  return amount * r;
}

function fromBase(amountBase: number, ccy: string, ctx: CompileFxContext): number {
  if (ccy === ctx.baseCcy) return amountBase;
  const r = ctx.ratesToBase[ccy];
  if (!r || !Number.isFinite(r) || r <= 0) return 0;
  return amountBase / r;
}

/** Convert a native-amount + from-currency into a percent of that wallet balance. */
function nativeToPct(amountNative: number, fromCcy: string, wallet: Record<string, number>): number {
  const bal = wallet[fromCcy] ?? 0;
  if (bal <= 0) return 0;
  return Math.min(100, Math.max(1, (amountNative / bal) * 100));
}

/**
 * Compile a batch of AI intents into legacy conversion orders while enforcing
 * per-tick turnover, min notional, and tilt caps.
 *
 * Ordering rules matter for the caps: pre_fund and close_hedge run first
 * because they unblock trades; hedge/sweep_idle next; carry_tilt last (most
 * discretionary → first to be trimmed).
 */
export function compileFxIntents(
  intents: FxIntent[],
  ctx: CompileFxContext,
): CompiledIntent[] {
  const priority: Record<FxIntent["kind"], number> = {
    pre_fund: 0,
    close_hedge: 1,
    hedge: 2,
    sweep_idle: 3,
    carry_tilt: 4,
  };
  const ordered = [...intents].sort((a, b) => priority[a.kind] - priority[b.kind]);

  const g = ctx.guardrails;
  const turnoverBudget = Math.max(0, (g.maxTurnoverPctOfNav / 100) * g.navBase);
  let turnoverUsed = 0;

  // Track non-base tilt exposure (initial + tilts added this tick).
  const initialNonBaseExposure = Object.entries(ctx.exposureBase)
    .filter(([c]) => c !== ctx.baseCcy)
    .reduce((a, [, v]) => a + v, 0);
  let tiltAddedBase = 0;

  const out: CompiledIntent[] = [];

  for (const intent of ordered) {
    const skip = (reason: string): CompiledIntent => ({ intent, skipped: reason, notionalBase: 0 });

    let from = ctx.baseCcy;
    let to = ctx.baseCcy;
    let amountFromNative = 0;

    switch (intent.kind) {
      case "pre_fund": {
        from = ctx.baseCcy;
        to = intent.ccy.toUpperCase();
        if (to === from) { out.push(skip("pre_fund into base ccy is a no-op")); continue; }
        // Fund exactly notional_base × 1.02 buffer, expressed in base.
        const need = intent.notional_base * 1.02;
        amountFromNative = need; // base ccy is native here
        break;
      }
      case "close_hedge": {
        from = ctx.baseCcy;
        to = intent.ccy.toUpperCase();
        if (to === from) { out.push(skip("close_hedge into base ccy is a no-op")); continue; }
        amountFromNative = intent.amount_base;
        break;
      }
      case "hedge": {
        from = intent.ccy.toUpperCase();
        to = ctx.baseCcy;
        if (from === to) { out.push(skip("hedge from base ccy is a no-op")); continue; }
        const bal = ctx.wallet[from] ?? 0;
        amountFromNative = bal * (intent.reduce_pct / 100);
        break;
      }
      case "sweep_idle": {
        from = intent.ccy.toUpperCase();
        to = ctx.baseCcy;
        if (from === to) { out.push(skip("sweep_idle from base ccy is a no-op")); continue; }
        amountFromNative = ctx.wallet[from] ?? 0;
        break;
      }
      case "carry_tilt": {
        from = ctx.baseCcy;
        to = intent.ccy.toUpperCase();
        if (to === from) { out.push(skip("carry_tilt into base ccy is a no-op")); continue; }
        const baseBal = ctx.wallet[from] ?? 0;
        amountFromNative = baseBal * (intent.tilt_pct_of_base / 100);
        break;
      }
    }

    if (!(amountFromNative > 0)) {
      out.push(skip(`nothing to convert (from ${from} balance = ${(ctx.wallet[from] ?? 0).toFixed(2)})`));
      continue;
    }

    // Apply per-currency single-tick cap (40% of `from` wallet).
    const bal = ctx.wallet[from] ?? 0;
    const perCurCap = bal * (g.perCurrencyMaxPct / 100);
    if (bal > 0 && amountFromNative > perCurCap) {
      amountFromNative = perCurCap;
    }

    // Convert to base for guardrail comparisons.
    let notionalBase = toBase(amountFromNative, from, ctx);
    if (notionalBase < g.minNotionalBase) {
      out.push(skip(`below min notional (${notionalBase.toFixed(2)} < ${g.minNotionalBase} ${ctx.baseCcy})`));
      continue;
    }

    // Turnover budget (across the whole tick).
    const remainingTurnover = turnoverBudget - turnoverUsed;
    if (remainingTurnover <= 0) {
      out.push(skip(`turnover budget exhausted (${g.maxTurnoverPctOfNav}% of NAV)`));
      continue;
    }
    if (notionalBase > remainingTurnover) {
      // Trim to fit the remaining budget rather than skipping outright.
      const scale = remainingTurnover / notionalBase;
      amountFromNative *= scale;
      notionalBase = remainingTurnover;
      if (notionalBase < g.minNotionalBase) {
        out.push(skip("remaining turnover budget below min notional"));
        continue;
      }
    }

    // Tilt exposure cap — only carry_tilt adds to it.
    if (intent.kind === "carry_tilt") {
      const cap = (g.maxTiltExposurePctOfNav / 100) * g.navBase;
      const projected = initialNonBaseExposure + tiltAddedBase + notionalBase;
      if (projected > cap) {
        const room = Math.max(0, cap - (initialNonBaseExposure + tiltAddedBase));
        if (room < g.minNotionalBase) {
          out.push(skip(`tilt exposure cap reached (${g.maxTiltExposurePctOfNav}% of NAV)`));
          continue;
        }
        const scale = room / notionalBase;
        amountFromNative *= scale;
        notionalBase = room;
      }
      tiltAddedBase += notionalBase;
    }

    // For pre_fund / close_hedge, cap by base balance (can't convert what we don't have).
    if (from === ctx.baseCcy) {
      const baseBal = ctx.wallet[from] ?? 0;
      const perCurBaseCap = baseBal * (g.perCurrencyMaxPct / 100);
      if (amountFromNative > perCurBaseCap) amountFromNative = perCurBaseCap;
      if (amountFromNative > baseBal) amountFromNative = baseBal;
      notionalBase = amountFromNative; // from-ccy is base
      if (notionalBase < g.minNotionalBase) {
        out.push(skip(`base ${ctx.baseCcy} wallet too low for intent (has ${baseBal.toFixed(2)})`));
        continue;
      }
    }

    const pct = nativeToPct(amountFromNative, from, ctx.wallet);
    if (pct < 1) {
      out.push(skip("computed percent < 1% of wallet"));
      continue;
    }

    const order: FxConversionOrder = {
      from_ccy: from,
      to_ccy: to,
      amount_percent: Math.round(pct),
      reason: `[${intent.kind}] ${intent.reason}`,
    };

    turnoverUsed += notionalBase;
    out.push({ intent, order, notionalBase });

    // Silence unused-var lint for helper `fromBase` — reserved for future
    // reason-string annotations. Keeping it exported-through-tests would be
    // overkill; the reference below is cheap.
    void fromBase;
  }

  return out;
}
