// Phase 6 — Tail hedge overlay server functions.
//
// Advisory: the app doesn't yet route hedge orders to the broker. This
// exposes the pure decision (target NAV %, notional, action) so the UI
// can surface it and the daily tick can persist it into decisions.raw
// for auditability. Current hedge notional is derived from the previous
// decision's persisted target so the ratchet threshold behaves sensibly
// across runs.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeTailHedge,
  type TailHedgeDecision,
} from "./tail-hedge";

async function readPreviousHedgeNotional(
  supabase: {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => {
          order: (c: string, o: { ascending: boolean }) => {
            limit: (n: number) => { maybeSingle: () => Promise<{ data: { raw: unknown } | null }> };
          };
        };
      };
    };
  },
  portfolioId: string,
): Promise<number> {
  const { data } = await supabase
    .from("decisions")
    .select("raw")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = (data?.raw ?? null) as { tail_hedge?: { targetNotional?: number } } | null;
  const n = Number(raw?.tail_hedge?.targetNotional ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type TailHedgeStatus = TailHedgeDecision & {
  nav: number;
  currentNotional: number;
};

export const getTailHedgeStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<TailHedgeStatus> => {
    const { supabase } = context;

    const { data: portfolio, error } = await supabase
      .from("portfolios")
      .select("id, current_cash")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (error || !portfolio) throw new Error("Portfolio not found");

    const { data: holdings } = await supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", data.portfolioId);
    const holdingsValue = (holdings ?? []).reduce(
      (s: number, h: { quantity: number; avg_cost: number }) =>
        s + Number(h.quantity) * Number(h.avg_cost),
      0,
    );
    const nav = Number(portfolio.current_cash) + holdingsValue;

    const { data: regime } = await supabase
      .from("market_regimes")
      .select("regime")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();

    const currentNotional = await readPreviousHedgeNotional(
      supabase as unknown as Parameters<typeof readPreviousHedgeNotional>[0],
      data.portfolioId,
    );

    const decision = computeTailHedge({
      nav,
      cape: null, // CAPE unavailable; falls back to baseline sizing at floor
      regime: (regime?.regime as string | null) ?? null,
      currentHedgeNotional: currentNotional,
    });

    return { ...decision, nav, currentNotional };
  });
