import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { classify, isLiveProvider } from "./fx-health.helpers";
import type { FxHealthSource, FxHealthRow } from "./fx-health.helpers";
export type { FxHealthSource, FxHealthRow };


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
            "er-api": 0,
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
      "er-api": 0,
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
    const emptyBucket = (t: number) => ({
      hour: new Date(t).toISOString(),
      ok: 0,
      cache: 0,
      stale: 0,
      fallback: 0,
      total: 0,
    });
    type Bucket = ReturnType<typeof emptyBucket>;
    const buckets = new Map<number, Bucket>();
    // Per-pair hourly buckets so the UI can render one timeline chart per
    // pair showing provider health + identity-fallback occurrences over time.
    const perPairBuckets = new Map<string, Map<number, Bucket>>();
    for (let t = Math.floor(startMs / bucketMs) * bucketMs; t <= now; t += bucketMs) {
      buckets.set(t, emptyBucket(t));
    }
    for (const r of rows) {
      const t = new Date(r.created_at as string).getTime();
      const key = Math.floor(t / bucketMs) * bucketMs;
      const b = buckets.get(key);
      const resp = (r.response ?? {}) as { source?: string; stale?: boolean };
      const source = classify(resp.source ?? null);
      const path = (r.path as string | null) ?? "";
      const m = /\/fx\/([A-Z]{3}->[A-Z]{3})/.exec(path);
      const pair = m?.[1] ?? "unknown";
      let pairMap = perPairBuckets.get(pair);
      if (!pairMap) {
        pairMap = new Map();
        for (let t2 = Math.floor(startMs / bucketMs) * bucketMs; t2 <= now; t2 += bucketMs) {
          pairMap.set(t2, emptyBucket(t2));
        }
        perPairBuckets.set(pair, pairMap);
      }
      const pb = pairMap.get(key);
      const bump = (bkt: Bucket | undefined) => {
        if (!bkt) return;
        bkt.total += 1;
        if (isLiveProvider(source)) bkt.ok += 1;
        else if (source === "fallback") bkt.fallback += 1;
        else if (source === "cache-stale" || resp.stale) bkt.stale += 1;
        else if (source === "cache") bkt.cache += 1;
      };
      bump(b);
      bump(pb);
    }
    const timeline = Array.from(buckets.values()).sort((a, b) =>
      a.hour.localeCompare(b.hour),
    );
    const pairTimelines = Array.from(perPairBuckets.entries())
      .map(([pair, m]) => ({
        pair,
        buckets: Array.from(m.values()).sort((a, b) =>
          a.hour.localeCompare(b.hour),
        ),
      }))
      .sort((a, b) => a.pair.localeCompare(b.pair));

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

    // Persistent circuit breaker state — derived from the same rows so the
    // UI shows the same view the executor uses to pause cross-currency buys.
    // OPEN when the most recent fallback is newer than the most recent live
    // provider capture; CLOSED once a fresh yahoo/frankfurter capture arrives.
    let lastFallbackAt: string | null = null;
    let lastOkAt: string | null = null;
    for (const r of rows) {
      const resp = (r.response ?? {}) as { source?: string };
      const src = resp.source ?? "";
      const t = r.created_at as string;
      if (src.startsWith("fallback") && !lastFallbackAt) lastFallbackAt = t;
      else if ((src === "yahoo" || src === "frankfurter" || src === "er-api") && !lastOkAt) lastOkAt = t;
      if (lastFallbackAt && lastOkAt) break;
    }
    const circuitOpen =
      !!lastFallbackAt &&
      (!lastOkAt ||
        new Date(lastOkAt).getTime() <= new Date(lastFallbackAt).getTime());
    const circuit = {
      open: circuitOpen,
      lastFallbackAt,
      lastOkAt,
      reason: circuitOpen
        ? `FX providers went to identity fallback${
            lastFallbackAt ? ` at ${lastFallbackAt}` : ""
          }; cross-currency buys paused until a live provider capture arrives.`
        : null,
    };

    // Cross-currency buy skips: separately count PRE_PLACE_FX_BLOCK (the
    // fxIsBroken guard — this tick's FX matrix collapsed to identity fallback)
    // vs PRE_PLACE_FX_CIRCUIT_OPEN (the persistent circuit still open from a
    // prior fallback). Each row is one tick where 1+ buys were skipped;
    // request.count carries how many routable orders that covered.
    const sq = await context.supabase
      .from("live_broker_log")
      .select("created_at, method, path, request, error")
      .eq("portfolio_id", data.portfolioId)
      .in("method", ["PRE_PLACE_FX_BLOCK", "PRE_PLACE_FX_CIRCUIT_OPEN"])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200);
    const skipRows = sq.error ? [] : (sq.data ?? []);

    type SkipEvent = {
      method: "PRE_PLACE_FX_BLOCK" | "PRE_PLACE_FX_CIRCUIT_OPEN";
      at: string;
      pair: string | null;
      orderCount: number;
      reason: string | null;
    };
    const skipEvents: SkipEvent[] = skipRows.map((r) => {
      const path = (r.path as string | null) ?? "";
      const m = /\/fx\/([A-Z]{3}->[A-Z]{3})/.exec(path);
      const req = (r.request ?? {}) as { count?: number };
      return {
        method: r.method as SkipEvent["method"],
        at: r.created_at as string,
        pair: m?.[1] ?? null,
        orderCount: typeof req.count === "number" ? req.count : 0,
        reason: (r.error as string | null) ?? null,
      };
    });
    const skipCounters = {
      fxBroken: {
        events: skipEvents.filter((e) => e.method === "PRE_PLACE_FX_BLOCK").length,
        orders: skipEvents
          .filter((e) => e.method === "PRE_PLACE_FX_BLOCK")
          .reduce((n, e) => n + e.orderCount, 0),
        lastAt:
          skipEvents.find((e) => e.method === "PRE_PLACE_FX_BLOCK")?.at ?? null,
      },
      circuit: {
        events: skipEvents.filter((e) => e.method === "PRE_PLACE_FX_CIRCUIT_OPEN").length,
        orders: skipEvents
          .filter((e) => e.method === "PRE_PLACE_FX_CIRCUIT_OPEN")
          .reduce((n, e) => n + e.orderCount, 0),
        lastAt:
          skipEvents.find((e) => e.method === "PRE_PLACE_FX_CIRCUIT_OPEN")?.at ?? null,
      },
      recent: skipEvents.slice(0, 10),
    };

    return {
      overall,
      windowHours: data.sinceHours,
      pairs,
      providerCounts,
      timeline,
      pairTimelines,
      availability,
      circuit,
      skipCounters,
    };
  });
