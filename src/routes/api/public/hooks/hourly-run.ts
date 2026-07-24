// Cron-triggered endpoint that runs an hourly AI market + news check.
// Refreshes news + macro regime + latest prices, then runs a tick for every
// paper-mode portfolio (multiple ticks per day are safe — snapshots upsert).
// Auth via Supabase anon apikey header.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/hourly-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { checkRateLimit, tooManyRequests } = await import("@/lib/rate-limit.server");
        const rl = await checkRateLimit(request, {
          bucket: "hooks:hourly-run",
          capacity: 10,
          refillPerSec: 10 / 3600, // ~10 per hour per IP
        });
        if (!rl.allowed) return tooManyRequests(rl);

        const provided = request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { acquireRunLock } = await import("@/lib/run-lock.server");
        const { runDailyTick } = await import("@/lib/trading-engine.server");
        const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");
        const { getNewsForDate } = await import("@/lib/news.server");
        const { refreshLatestCandles } = await import("@/lib/market-data.server");
        const { filterUniverse } = await import("@/lib/universe.server");

        // Concurrency guard: only one hourly cycle at a time (cron OR manual).
        let manualTrigger = false;
        try {
          const bodyText = await request.clone().text();
          if (bodyText) {
            const parsed = JSON.parse(bodyText);
            manualTrigger = parsed?.manual === true;
          }
        } catch { /* body optional */ }
        const lock = await acquireRunLock("hourly-run", {
          owner: manualTrigger ? "manual" : "cron",
          // Worker wall/CPU limits can kill the run before `finally` releases
          // the lock. Evict anything older than 5 min so a crashed run cannot
          // permanently block manual/cron triggers.
          staleMs: 5 * 60 * 1000,
        });
        if (!lock.acquired) {
          return new Response(
            JSON.stringify({
              error: "run_in_progress",
              message: `An hourly run is already in progress (started by ${lock.heldBy ?? "unknown"} ${Math.round(lock.ageMs / 1000)}s ago). Please wait for it to finish before triggering another.`,
              held_by: lock.heldBy,
              acquired_at: lock.acquiredAt,
              age_ms: lock.ageMs,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
        const classesFromUniverse = (u: unknown): Array<"stock" | "etf" | "crypto" | "commodity" | "fx"> => {
          const all = ["stock", "etf", "crypto", "commodity", "fx"] as const;
          if (!Array.isArray(u)) return [...all];
          return u.filter((x): x is (typeof all)[number] =>
            typeof x === "string" && (all as readonly string[]).includes(x),
          );
        };

        const today = new Date().toISOString().slice(0, 10);

        // 0. Keep Saxo OAuth tokens alive for BOTH envs, unconditionally.
        //    Saxo refresh tokens can be as short as ~60 minutes, so we MUST
        //    force-refresh every hour even when the access token still has
        //    time left — otherwise the refresh window silently lapses and the
        //    broker connection dies until the user manually reconnects.
        const saxoRefresh: Record<string, { ok: boolean; error?: string; skipped?: string }> = {};
        try {
          const { forceRefreshTokens, getOAuthStatus } = await import(
            "@/lib/brokers/saxo-oauth.server"
          );
          for (const env of ["sim", "live"] as const) {
            try {
              const status = await getOAuthStatus(env);
              if (!status.appConfigured) {
                saxoRefresh[env] = { ok: true, skipped: "app not configured" };
                continue;
              }
              if (!status.connected || status.usingLegacyToken) {
                saxoRefresh[env] = { ok: true, skipped: "no oauth row yet" };
                continue;
              }
              const r = await forceRefreshTokens(env);
              saxoRefresh[env] = r.refreshed ? { ok: true } : { ok: true, skipped: r.reason };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`hourly-run: saxo refresh failed for ${env}`, msg);
              saxoRefresh[env] = { ok: false, error: msg };
            }
          }
        } catch (e) {
          console.error("hourly-run: saxo refresh module load failed", e);
        }



        // 1. Refresh news (bust today's cache so hourly runs see new headlines)
        //    and clear the in-memory market-context cache so downstream ticks
        //    pick up the fresh news + regime for this hour.
        let newsCount = 0;
        try {
          const { invalidateContextCache } = await import("@/lib/market-context-cache.server");
          invalidateContextCache();
          const items = await getNewsForDate(today, 15, { forceRefresh: true });
          newsCount = items.length;
        } catch (e) {
          console.error("hourly-run: news refresh failed", e);
        }

        // 2. Refresh macro regime
        let regimeInfo: unknown = null;
        try {
          regimeInfo = await detectAndPersistRegime(today);
        } catch (e) {
          console.error("hourly-run: regime detection failed", e);
        }

        // 3. Load tickable portfolios: paper + non-paused live (sim & prod).
        //    Paused live portfolios (kill-switch / manual pause) are skipped
        //    so the AI does not act on them until the operator resumes.
        const { data: allPortfolios, error } = await supabaseAdmin
          .from("portfolios")
          .select("id, name, universe, mode, live_paused")
          .in("mode", ["paper", "live_sim", "live_prod"]);

        if (error) {
          console.error("hourly-run: fetch portfolios failed", error);
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const portfolios = (allPortfolios ?? []).filter(
          (p) => !(p.mode !== "paper" && p.live_paused),
        );
        const skippedPaused = (allPortfolios ?? []).length - portfolios.length;

        // 4. Refresh latest prices for the union of universe + held symbols
        const symbolSet = new Set<string>();
        for (const p of portfolios ?? []) {
          try {
            const universe = filterUniverse(classesFromUniverse(p.universe));
            for (const c of universe.slice(0, 22)) symbolSet.add(c.symbol);
          } catch (e) {
            console.warn("hourly-run: universe parse failed", p.id, e);
          }
        }
        const { data: heldRows } = await supabaseAdmin
          .from("holdings")
          .select("symbol")
          .in(
            "portfolio_id",
            (portfolios ?? []).map((p) => p.id),
          );
        for (const h of heldRows ?? []) symbolSet.add(h.symbol);

        let priceRefresh = { refreshed: 0, errors: 0 };
        if (symbolSet.size > 0) {
          try {
            priceRefresh = await refreshLatestCandles(Array.from(symbolSet));
          } catch (e) {
            console.error("hourly-run: price refresh failed", e);
          }
        }

        // 5. Run a tick per portfolio (sequential, gentle on gateway).
        //    Hook-level idempotency: if a decision row already exists for this
        //    portfolio in the current UTC hour, skip — the previous call did
        //    the AI + routing already, and the live_orders unique index would
        //    have blocked duplicates anyway. This just avoids the wasted AI
        //    round-trip when the CRON fires more than once per hour.
        const hourStartUtc = new Date();
        hourStartUtc.setUTCMinutes(0, 0, 0);
        const hourStartIso = hourStartUtc.toISOString();
        const results: Array<{ id: string; mode: string; ok: boolean; error?: string; value?: number; skipped?: string }> = [];
        for (const p of portfolios) {
          try {
            // Cron runs skip portfolios already ticked in the current UTC hour
            // to avoid duplicate AI calls when the schedule fires twice.
            // Manual triggers intentionally bypass this so the operator can
            // force a fresh decision cycle on demand.
            if (!manualTrigger) {
              const recent = await supabaseAdmin
                .from("decisions")
                .select("id")
                .eq("portfolio_id", p.id)
                .gte("created_at", hourStartIso)
                .limit(1)
                .maybeSingle();
              if (recent.data) {
                results.push({ id: p.id, mode: p.mode, ok: true, skipped: "already ticked this hour" });
                continue;
              }
            }
            const r = await runDailyTick(p.id, today);
            results.push({ id: p.id, mode: p.mode, ok: true, value: r.totalValue });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`hourly-run: portfolio ${p.id} failed`, msg);
            results.push({ id: p.id, mode: p.mode, ok: false, error: msg });
          }
        }



        return Response.json({
          success: true,
          hour_utc: new Date().toISOString(),
          date: today,
          news_headlines: newsCount,
          prices_refreshed: priceRefresh.refreshed,
          price_errors: priceRefresh.errors,
          symbols_watched: symbolSet.size,
          regime: regimeInfo,
          portfolios: portfolios.length,
          skipped_paused: skippedPaused,
          saxo_refresh: saxoRefresh,
          triggered_by: manualTrigger ? "manual" : "cron",
          results,
        });
        } finally {
          await lock.release();
        }
      },
    },
  },
});
