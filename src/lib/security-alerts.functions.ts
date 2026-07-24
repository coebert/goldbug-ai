// Client-callable settings for SECURITY:pending_slices threshold alerts.
// Backed by the security_alert_settings table (RLS: owner only).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { SECURITY_ALERT_DEFAULTS } from "@/lib/security-alerts.server";

export type SecurityAlertSettings = {
  enabled: boolean;
  event_type: "pending_slices";
  threshold: number;
  window_minutes: number;
  cooldown_minutes: number;
  last_notified_at: string | null;
  last_notified_count: number | null;
};

export const getSecurityAlertSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SecurityAlertSettings> => {
    const { data, error } = await context.supabase
      .from("security_alert_settings")
      .select("enabled, event_type, threshold, window_minutes, cooldown_minutes, last_notified_at, last_notified_count")
      .eq("user_id", context.userId)
      .eq("event_type", "pending_slices")
      .maybeSingle();
    if (error) throw new Error(`security_alert_settings read failed: ${error.message}`);
    if (!data) return SECURITY_ALERT_DEFAULTS as SecurityAlertSettings;
    return { ...SECURITY_ALERT_DEFAULTS, ...data } as SecurityAlertSettings;
  });

export const updateSecurityAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      enabled: z.boolean(),
      threshold: z.number().int().min(1).max(10_000),
      window_minutes: z.number().int().min(1).max(10_080),
      cooldown_minutes: z.number().int().min(0).max(10_080),
    }).parse(input),
  )
  .handler(async ({ data, context }): Promise<SecurityAlertSettings> => {
    const row = {
      user_id: context.userId,
      event_type: "pending_slices" as const,
      enabled: data.enabled,
      threshold: data.threshold,
      window_minutes: data.window_minutes,
      cooldown_minutes: data.cooldown_minutes,
    };
    const { data: saved, error } = await context.supabase
      .from("security_alert_settings")
      .upsert(row, { onConflict: "user_id" })
      .select("enabled, event_type, threshold, window_minutes, cooldown_minutes, last_notified_at, last_notified_count")
      .single();
    if (error) throw new Error(`security_alert_settings save failed: ${error.message}`);
    return { ...SECURITY_ALERT_DEFAULTS, ...saved } as SecurityAlertSettings;
  });
