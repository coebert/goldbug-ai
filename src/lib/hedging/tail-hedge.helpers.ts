// Runtime helpers extracted from tail-hedge.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeTailHedge,
  type TailHedgeDecision,
} from "./tail-hedge";

export async function readPreviousHedgeNotional(
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
