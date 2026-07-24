// Regime-detection server functions. Split out of trading.functions.ts
// during Phase 3 to keep files focused. Callers should import from
// "@/lib/regime.functions"; the legacy "@/lib/trading.functions" barrel
// re-exports these for backwards compatibility.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getCurrentRegime = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("market_regimes")
      .select("*")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  });

export const getRegimeHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ days: z.number().min(1).max(365).default(90) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("market_regimes")
      .select("*")
      .order("as_of", { ascending: false })
      .limit(data.days);
    return (rows ?? []).slice().reverse();
  });

export const refreshRegimeNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { detectAndPersistRegime } = await import("./regime-detector.server");
    const today = new Date().toISOString().slice(0, 10);
    return await detectAndPersistRegime(today);
  });
