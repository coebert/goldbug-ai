// Recent FX intents surfaced from decisions.raw.ai_fx.intents_compiled.
// Read-only aggregation for the FxIntentsCard.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type FxIntentRow = {
  decisionId: string;
  runDate: string;
  createdAt: string;
  kind: string;
  ccy: string;
  reason: string;
  order: {
    from_ccy: string;
    to_ccy: string;
    amount_percent: number;
  } | null;
  skipped: string | null;
  notionalBase: number;
  applied?: {
    amount_from: number;
    amount_to: number;
    rate: number;
    rejected?: string;
  } | null;
};

export const listFxIntents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      limit: z.number().int().min(1).max(200).default(50),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<FxIntentRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("decisions")
      .select("id, run_date, created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);

    const out: FxIntentRow[] = [];
    for (const r of rows ?? []) {
      const raw = r.raw as Record<string, unknown> | null;
      const g = (raw?.guardrails ?? {}) as Record<string, unknown>;
      const aiFx = (g.ai_fx ?? null) as {
        intents_compiled?: Array<{
          intent: { kind: string; ccy?: string; reason: string };
          order: { from_ccy: string; to_ccy: string; amount_percent: number } | null;
          skipped: string | null;
          notional_base: number;
        }>;
        applied?: Array<{
          from_ccy: string;
          to_ccy: string;
          amount_from: number;
          amount_to: number;
          rate: number;
          rejected?: string;
        }>;
      } | null;
      const compiled = aiFx?.intents_compiled ?? [];
      const applied = aiFx?.applied ?? [];
      for (const c of compiled) {
        // Match applied row by from/to (first match) — the compiler emits
        // one order per intent, so this pairing is unambiguous per pair.
        const match = c.order
          ? applied.find(
              (a) => a.from_ccy === c.order!.from_ccy && a.to_ccy === c.order!.to_ccy,
            ) ?? null
          : null;
        out.push({
          decisionId: r.id,
          runDate: r.run_date,
          createdAt: r.created_at,
          kind: c.intent.kind,
          ccy: c.intent.ccy ?? "",
          reason: c.intent.reason,
          order: c.order,
          skipped: c.skipped,
          notionalBase: c.notional_base,
          applied: match,
        });
        if (out.length >= data.limit) return out;
      }
    }
    return out;
  });
