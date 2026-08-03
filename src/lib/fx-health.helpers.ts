// Runtime helpers extracted from fx-health.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * FX endpoint health aggregator.
 *
 * Reads FX_CAPTURE rows from live_broker_log (already written by the live
 * executor on every cross-currency tick) and buckets them by resolved source
 * so the UI can show whether Yahoo / Frankfurter are healthy, and whether
 * the app is silently coasting on cached, stale, or identity-fallback rates.
 *
 * Statuses (worst wins):
 *   ok       — most recent capture came from a live provider (yahoo/frankfurter)
 *   degraded — most recent capture came from cache and older captures show
 *              a mix of providers, OR any stale cache captures in-window
 *   critical — most recent capture is an identity fallback (rate=1, source
 *              starts with "fallback:") meaning BOTH providers failed
 */

export type FxHealthSource =
  | "yahoo"
  | "frankfurter"
  | "er-api"
  | "cache"
  | "cache-stale"
  | "fallback"
  | "identity"
  | "unknown";

export type FxHealthRow = {
  pair: string; // e.g. "GBP->EUR"
  status: "ok" | "degraded" | "critical";
  lastRate: number | null;
  lastSource: FxHealthSource;
  lastAt: string | null;
  lastError: string | null;
  counts: Record<FxHealthSource, number>;
  identityFallbacks: number;
  staleCaptures: number;
  totalCaptures: number;
};

export function classify(source: string | null): FxHealthSource {
  if (!source) return "unknown";
  if (source === "yahoo") return "yahoo";
  if (source === "frankfurter") return "frankfurter";
  if (source === "er-api") return "er-api";
  if (source === "identity") return "identity";
  if (source === "cache") return "cache";
  if (source === "cache-stale") return "cache-stale";
  if (source.startsWith("fallback")) return "fallback";
  return "unknown";
}

export function isLiveProvider(s: FxHealthSource): boolean {
  return s === "yahoo" || s === "frankfurter" || s === "er-api";
}
