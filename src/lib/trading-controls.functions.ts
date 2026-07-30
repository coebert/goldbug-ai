// Client-callable read/update of the global trading safety controls.
// Reads are available to any signed-in user; the UPDATE is enforced by RLS
// (admin role only), so a non-admin update fails at the database, not just in
// the UI.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface TradingControls {
  trading_enabled: boolean;
  daily_notional_limit: number;
  halt_reason: string | null;
  updated_at: string;
  is_admin: boolean;
}

export const getTradingControls = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TradingControls> => {
    const { data, error } = await context.supabase
      .from("trading_controls")
      .select("trading_enabled, daily_notional_limit, halt_reason, updated_at")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin");

    return {
      trading_enabled: Boolean(data?.trading_enabled),
      daily_notional_limit: Number(data?.daily_notional_limit ?? 0),
      halt_reason: data?.halt_reason ?? null,
      updated_at: data?.updated_at ?? new Date().toISOString(),
      is_admin: (roles?.length ?? 0) > 0,
    };
  });

export const updateTradingControls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        trading_enabled: z.boolean().optional(),
        daily_notional_limit: z.number().min(0).max(1_000_000).optional(),
        halt_reason: z.string().max(500).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("trading_controls")
      .update({ ...data, updated_by: context.userId })
      .eq("id", true);
    if (error) throw new Error(error.message);

    await context.supabase.from("security_audit_log").insert({
      event: "generic",
      op: "trading_controls_update",
      reason: JSON.stringify(data),
      actor_user_id: context.userId,
      details: JSON.parse(JSON.stringify(data)),
    });
    return { ok: true };
  });
