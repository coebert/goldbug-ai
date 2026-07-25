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

function classify(source: string | null): FxHealthSource {
  if (!source) return "unknown";
  if (source === "yahoo") return "yahoo";
  if (source === "frankfurter") return "frankfurter";
  if (source === "identity") return "identity";
  if (source === "cache") return "cache";
  if (source === "cache-stale") return "cache-stale";
  if (source.startsWith("fallback")) return "fallback";
  return "unknown";
}

export const getFxHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        sinceHours: z.number().int().min(1).max(168).default(24),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const sinceIso = new Date(
      Date.now() - data.sinceHours * 3600_000,
    ).toISOString();

    const q = await context.supabase
      .from("live_broker_log")
      .select("created_at, path, response, error, status")
      .eq("portfolio_id", data.portfolioId)
      .eq("method", "FX_CAPTURE")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(500);
    if (q.error) throw new Error(q.error.message);
    const rows = q.data ?? [];

    const byPair = new Map<string, FxHealthRow>();
    for (const r of rows) {
      const path = (r.path as string | null) ?? "";
      const m = /\/fx\/([A-Z]{3}->[A-Z]{3})/.exec(path);
      const pair = m?.[1] ?? "unknown";
      const resp = (r.response ?? {}) as {
        rate?: number;
        source?: string;
        stale?: boolean;
      };
      const source = classify(resp.source ?? null);
      const isIdentityFallback =
        source === "fallback" ||
        (source === "identity" && pair !== "unknown" && !pair.startsWith(pair.slice(4, 7) + "->"));

      let row = byPair.get(pair);
      if (!row) {
        row = {
          pair,
          status: "ok",
          lastRate: null,
          lastSource: "unknown",
          lastAt: null,
          lastError: null,
          counts: {
            yahoo: 0,
            frankfurter: 0,
            cache: 0,
            "cache-stale": 0,
            fallback: 0,
            identity: 0,
            unknown: 0,
          },
          identityFallbacks: 0,
          staleCaptures: 0,
          totalCaptures: 0,
        };
        byPair.set(pair, row);
        // First iteration is newest (desc order).
        row.lastRate = typeof resp.rate === "number" ? resp.rate : null;
        row.lastSource = source;
        row.lastAt = r.created_at as string;
        row.lastError = (r.error as string | null) ?? null;
      }
      row.counts[source] += 1;
      row.totalCaptures += 1;
      if (resp.stale) row.staleCaptures += 1;
      if (source === "fallback") row.identityFallbacks += 1;
      if (isIdentityFallback && source === "fallback") {
        // already counted above
      }
    }

    // Compute status per pair.
    for (const row of byPair.values()) {
      if (row.lastSource === "fallback") {
        row.status = "critical";
      } else if (
        row.lastSource === "cache-stale" ||
        row.staleCaptures > 0 ||
        row.identityFallbacks > 0
      ) {
        row.status = "degraded";
      } else {
        row.status = "ok";
      }
    }

    const pairs = Array.from(byPair.values()).sort((a, b) =>
      a.pair.localeCompare(b.pair),
    );

    const overall: "ok" | "degraded" | "critical" = pairs.some(
      (p) => p.status === "critical",
    )
      ? "critical"
      : pairs.some((p) => p.status === "degraded")
        ? "degraded"
        : "ok";

    // Provider-level rollup across all pairs.
    const providerCounts = {
      yahoo: 0,
      frankfurter: 0,
      cache: 0,
      "cache-stale": 0,
      fallback: 0,
      identity: 0,
      unknown: 0,
    } satisfies Record<FxHealthSource, number>;
    for (const p of pairs) {
      for (const k of Object.keys(providerCounts) as FxHealthSource[]) {
        providerCounts[k] += p.counts[k];
      }
    }

    // Time-bucketed availability timeline (hourly) so the UI can render a
    // sparkline of provider availability, staleness, and fallback usage.
    const bucketMs = 3600_000; // 1h
    const now = Date.now();
    const startMs = now - data.sinceHours * bucketMs;
    const buckets = new Map<
      number,
      { hour: string; ok: number; cache: number; stale: number; fallback: number; total: number }
    >();
    for (let t = Math.floor(startMs / bucketMs) * bucketMs; t <= now; t += bucketMs) {
      buckets.set(t, {
        hour: new Date(t).toISOString(),
        ok: 0,
        cache: 0,
        stale: 0,
        fallback: 0,
        total: 0,
      });
    }
    for (const r of rows) {
      const t = new Date(r.created_at as string).getTime();
      const key = Math.floor(t / bucketMs) * bucketMs;
      const b = buckets.get(key);
      if (!b) continue;
      const resp = (r.response ?? {}) as { source?: string; stale?: boolean };
      const source = classify(resp.source ?? null);
      b.total += 1;
      if (source === "yahoo" || source === "frankfurter") b.ok += 1;
      else if (source === "fallback") b.fallback += 1;
      else if (source === "cache-stale" || resp.stale) b.stale += 1;
      else if (source === "cache") b.cache += 1;
    }
    const timeline = Array.from(buckets.values()).sort((a, b) =>
      a.hour.localeCompare(b.hour),
    );

    // Availability rollups across window.
    const totals = timeline.reduce(
      (acc, b) => {
        acc.ok += b.ok;
        acc.cache += b.cache;
        acc.stale += b.stale;
        acc.fallback += b.fallback;
        acc.total += b.total;
        return acc;
      },
      { ok: 0, cache: 0, stale: 0, fallback: 0, total: 0 },
    );
    const pct = (n: number) =>
      totals.total > 0 ? Math.round((n / totals.total) * 1000) / 10 : 0;
    const availability = {
      liveProviderPct: pct(totals.ok),
      cachePct: pct(totals.cache),
      stalePct: pct(totals.stale),
      fallbackPct: pct(totals.fallback),
      total: totals.total,
    };

    return {
      overall,
      windowHours: data.sinceHours,
      pairs,
      providerCounts,
      timeline,
      availability,
    };
  });
