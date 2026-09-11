// Read and change the automatic currency-close settings from the UI.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { AUTO_CLOSE_DEFAULTS, type AutoCloseSettings } from "./fx-auto-close";

export const getFxAutoCloseSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AutoCloseSettings> => {
    const { loadAutoCloseSettings } = await import("./fx-auto-close.server");
    try {
      return await loadAutoCloseSettings(context.supabase);
    } catch {
      return AUTO_CLOSE_DEFAULTS;
    }
  });

export const setFxAutoCloseSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean(),
        lossPct: z.number().min(0.1).max(25),
        minNotionalBase: z.number().min(0).max(100_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string }> => {
    const patch = {
      fx_auto_close_enabled: data.enabled,
      fx_auto_close_loss_pct: data.lossPct,
      updated_by: context.userId,
      ...(data.minNotionalBase != null
        ? { fx_auto_close_min_notional_base: data.minNotionalBase }
        : {}),
    };
    const { error } = await context.supabase.from("trading_controls").update(patch).eq("id", true);
    return error ? { ok: false, error: error.message } : { ok: true };
  });
