// Persistent FX circuit breaker.
//
// Derived from FX_CAPTURE rows in `live_broker_log`. The breaker OPENS when a
// recent capture came from the identity fallback (both live FX providers
// unreachable and no usable cached rate) and CLOSES only after a fresh live
// provider capture (yahoo / frankfurter) arrives that is strictly newer than
// the last fallback event.
//
// Kept intentionally stateless — the log is the source of truth so we don't
// have to reconcile a separate table when captures resume on their own.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export interface FxCircuitState {
  open: boolean;
  lastFallbackAt: string | null;
  lastOkAt: string | null;
  reason: string | null;
}

/**
 * Compute the circuit state for a portfolio from the last `lookbackHours`
 * of FX_CAPTURE rows. Returns { open: true } if the circuit is tripped.
 */
export async function getFxCircuitState(
  supabaseAdmin: SupabaseClient<Database>,
  portfolioId: string,
  lookbackHours = 24,
): Promise<FxCircuitState> {
  const sinceIso = new Date(
    Date.now() - lookbackHours * 3600_000,
  ).toISOString();

  const q = await supabaseAdmin
    .from("live_broker_log")
    .select("created_at, response")
    .eq("portfolio_id", portfolioId)
    .eq("method", "FX_CAPTURE")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(200);
  if (q.error) throw new Error(q.error.message);

  let lastFallbackAt: string | null = null;
  let lastOkAt: string | null = null;
  for (const r of q.data ?? []) {
    const resp = (r.response ?? {}) as { source?: string };
    const src = resp.source ?? "";
    const createdAt = r.created_at as string;
    if (src.startsWith("fallback")) {
      if (!lastFallbackAt) lastFallbackAt = createdAt;
    } else if (src === "yahoo" || src === "frankfurter" || src === "er-api") {
      if (!lastOkAt) lastOkAt = createdAt;
    }
    if (lastFallbackAt && lastOkAt) break;
  }

  const open =
    !!lastFallbackAt &&
    (!lastOkAt ||
      new Date(lastOkAt).getTime() <= new Date(lastFallbackAt).getTime());

  return {
    open,
    lastFallbackAt,
    lastOkAt,
    reason: open
      ? `FX providers went to identity fallback at ${lastFallbackAt}${
          lastOkAt ? ` and no live provider capture since` : ` with no live captures in window`
        }`
      : null,
  };
}
