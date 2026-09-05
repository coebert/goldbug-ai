// Strict-mode JSON-schema variant of DecisionSchema.
//
// The gateway forwards `response_format: json_schema` with strict validation:
// every property must appear in `required`, and discriminated unions are
// rejected. Optional zod fields therefore produced a hard 400
// ("Invalid schema for response_format") on every decision call, which is why
// the engine kept falling back to the heuristic. Here optional fields become
// required-but-nullable and the FX intent union is flattened; `normalizeStrict`
// maps the result back onto DecisionOutput.
import { z } from "zod";
import { SignalWeightsSchema, type DecisionOutput } from "./types";
import type { FxIntent } from "../fx-intents";

const StrictOrderSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  percent: z.number(),
  conviction: z.number().min(0).max(1).nullable(),
  reason: z.string(),
  signal_weights: SignalWeightsSchema,
});

const StrictFxConversionSchema = z.object({
  from_ccy: z.string(),
  to_ccy: z.string(),
  amount_percent: z.number(),
  reason: z.string(),
});

const StrictFxIntentSchema = z.object({
  kind: z.enum(["pre_fund", "hedge", "sweep_idle", "carry_tilt", "close_hedge"]),
  ccy: z.string(),
  notional_base: z.number().nullable(),
  reduce_pct: z.number().nullable(),
  tilt_pct_of_base: z.number().nullable(),
  amount_base: z.number().nullable(),
  reason: z.string(),
});

export const StrictDecisionSchema = z.object({
  briefing: z.string(),
  rationale: z.string(),
  orders: z.array(StrictOrderSchema),
  fx_conversions: z.array(StrictFxConversionSchema).nullable(),
  fx_intents: z.array(StrictFxIntentSchema).nullable(),
});

export type StrictDecision = z.infer<typeof StrictDecisionSchema>;

/** Map the strict shape back onto the engine's DecisionOutput. */
export function normalizeStrictDecision(d: StrictDecision): DecisionOutput {
  const intents: FxIntent[] = [];
  for (const i of d.fx_intents ?? []) {
    const base = { ccy: i.ccy, reason: i.reason };
    if (i.kind === "pre_fund" && Number.isFinite(i.notional_base) && (i.notional_base ?? 0) > 0)
      intents.push({ kind: "pre_fund", ...base, notional_base: Number(i.notional_base) });
    else if (i.kind === "hedge" && Number.isFinite(i.reduce_pct))
      intents.push({ kind: "hedge", ...base, reduce_pct: Number(i.reduce_pct) });
    else if (i.kind === "sweep_idle") intents.push({ kind: "sweep_idle", ...base });
    else if (i.kind === "carry_tilt" && Number.isFinite(i.tilt_pct_of_base))
      intents.push({ kind: "carry_tilt", ...base, tilt_pct_of_base: Number(i.tilt_pct_of_base) });
    else if (i.kind === "close_hedge" && Number.isFinite(i.amount_base) && (i.amount_base ?? 0) > 0)
      intents.push({ kind: "close_hedge", ...base, amount_base: Number(i.amount_base) });
  }
  return {
    briefing: d.briefing,
    rationale: d.rationale,
    orders: d.orders.map((o) => ({
      symbol: o.symbol,
      side: o.side,
      percent: o.percent,
      reason: o.reason,
      signal_weights: o.signal_weights,
      ...(o.conviction === null ? {} : { conviction: o.conviction }),
    })),
    ...(d.fx_conversions && d.fx_conversions.length
      ? { fx_conversions: d.fx_conversions }
      : {}),
    ...(intents.length ? { fx_intents: intents } : {}),
  };
}
