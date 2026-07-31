// Client-callable settings + history for corporate-action deadline reminders.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  DEFAULT_THRESHOLD_HOURS,
  normalizeThresholds,
} from "@/lib/corporate-action-deadline-alerts";

export type CaAlertSettings = {
  enabled: boolean;
  thresholdHours: number[];
};

export type CaAlertHistoryRow = {
  id: string;
  eventId: string;
  thresholdHours: number;
  deadline: string | null;
  suppressed: boolean;
  sentAt: string;
};

export const getCorporateActionAlertSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CaAlertSettings> => {
    const { data, error } = await context.supabase
      .from("corporate_action_alert_settings")
      .select("enabled, threshold_hours")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(`alert settings read failed: ${error.message}`);
    return {
      enabled: data?.enabled ?? true,
      thresholdHours: normalizeThresholds(
        data?.threshold_hours ?? [...DEFAULT_THRESHOLD_HOURS],
      ),
    };
  });

export const updateCorporateActionAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean(),
        thresholdHours: z.array(z.number().int().min(1).max(720)).min(1).max(5),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CaAlertSettings> => {
    const thresholds = normalizeThresholds(data.thresholdHours);
    const { data: saved, error } = await context.supabase
      .from("corporate_action_alert_settings")
      .upsert(
        {
          user_id: context.userId,
          enabled: data.enabled,
          threshold_hours: thresholds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("enabled, threshold_hours")
      .single();
    if (error) throw new Error(`alert settings save failed: ${error.message}`);
    return {
      enabled: saved.enabled,
      thresholdHours: normalizeThresholds(saved.threshold_hours),
    };
  });

export const listCorporateActionAlertHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CaAlertHistoryRow[]> => {
    const { data, error } = await context.supabase
      .from("corporate_action_alerts_sent")
      .select("id, event_id, threshold_hours, deadline, suppressed, sent_at")
      .eq("user_id", context.userId)
      .order("sent_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(`alert history read failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      id: r.id,
      eventId: r.event_id,
      thresholdHours: r.threshold_hours,
      deadline: r.deadline,
      suppressed: r.suppressed,
      sentAt: r.sent_at,
    }));
  });
