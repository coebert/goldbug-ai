import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SignalsByMarket } from "./signals-by-market";

export const getSignalsByMarket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<SignalsByMarket | null> => {
    const { buildSignalsByMarket } = await import("./signals-by-market.server");
    return buildSignalsByMarket({
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
    });
  });