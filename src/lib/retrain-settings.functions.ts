import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getRetrainSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("retrain_settings")
      .select("enabled, cadence_days, last_run_at, last_run_status, last_run_error, updated_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    return (
      data ?? {
        enabled: true,
        cadence_days: 7,
        last_run_at: null,
        last_run_status: null,
        last_run_error: null,
        updated_at: null,
      }
    );
  });

export const upsertRetrainSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      enabled: z.boolean(),
      cadence_days: z.number().int().min(1).max(365),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("retrain_settings")
      .upsert(
        { user_id: context.userId, enabled: data.enabled, cadence_days: data.cadence_days },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
