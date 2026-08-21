// Manual "resume buys" overrides for hard risk halts.
//
// A halt is derived state (daily loss / drawdown vs the configured caps), so
// there is nothing to "delete" — an override is an explicit, time-boxed,
// audited decision to trade through the halt. It expires on its own so a
// forgotten override can never leave the account permanently unprotected.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const MAX_OVERRIDE_HOURS = 24;
export const DEFAULT_OVERRIDE_HOURS = 8;

export type ActiveOverride = {
  id: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
};

/** Newest non-expired override for a portfolio, or null. */
export async function loadActiveRiskHaltOverride(
  client: SupabaseClient<Database>,
  portfolioId: string,
  now: Date = new Date(),
): Promise<ActiveOverride | null> {
  const { data } = await client
    .from("risk_halt_overrides")
    .select("id, reason, created_at, expires_at")
    .eq("portfolio_id", portfolioId)
    .gt("expires_at", now.toISOString())
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    reason: (data.reason as string | null) ?? null,
    createdAt: data.created_at as string,
    expiresAt: data.expires_at as string,
  };
}

export function clampOverrideHours(hours: number | undefined): number {
  if (!Number.isFinite(hours ?? NaN)) return DEFAULT_OVERRIDE_HOURS;
  return Math.min(MAX_OVERRIDE_HOURS, Math.max(1, Math.round(hours as number)));
}
