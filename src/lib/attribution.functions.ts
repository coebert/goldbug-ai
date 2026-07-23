import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const Input = z.object({
  portfolioId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(365).default(90),
  horizonDays: z.number().int().min(1).max(30).default(5),
});

export const getAttributionDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data, context }) => {
    // Ownership check via RLS-scoped client
    const { data: owned, error } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!owned) throw new Error("Portfolio not found");

    const asOf = new Date().toISOString().slice(0, 10);
    const { getAttributionDashboard: run } = await import("./attribution-dashboard.server");
    return run(data.portfolioId, asOf, data.windowDays, data.horizonDays);
  });
