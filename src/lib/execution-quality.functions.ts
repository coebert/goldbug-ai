import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getExecutionQuality = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      windowDays: z.number().int().min(7).max(365).default(30),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: owned, error } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!owned) throw new Error("Portfolio not found");

    const { getExecutionQuality: run } = await import("./execution-quality.server");
    const { withOwnedClient } = await import("@/lib/_server/owned-client");
    return run(data.portfolioId, data.windowDays, withOwnedClient(context.userId, context.supabase));
  });
