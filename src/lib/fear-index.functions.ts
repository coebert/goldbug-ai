// Server functions backing the fear-index gauge on the trading dashboard.
// Thin wrapper: declarations only — all runtime helpers live in
// "./fear-index-view" so server-fn splitting cannot strip siblings.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getFearIndexSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        sessions: z.number().int().min(5).max(180).default(30),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { buildFearIndexSnapshot } = await import("./fear-index-view");
    const { data: rows } = await context.supabase
      .from("decisions")
      .select("run_date, created_at, raw")
      .eq("portfolio_id", data.portfolio_id)
      .order("created_at", { ascending: false })
      .limit(data.sessions);
    return buildFearIndexSnapshot(rows ?? []);
  });

