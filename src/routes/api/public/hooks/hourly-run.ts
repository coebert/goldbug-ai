// Cron-triggered endpoint that runs an hourly AI market + news check.
// Refreshes news + macro regime + latest prices, then runs a tick for every
// paper-mode portfolio (multiple ticks per day are safe — snapshots upsert).
// Auth via Supabase anon apikey header.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/hourly-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runDailyTick } = await import("@/lib/trading-engine.server");
        const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");
        const { getNewsForDate } = await import("@/lib/news.server");
        const { refreshLatestCandles } = await import("@/lib/market-data.server");
        const { filterUniverse } = await import("@/lib/universe.server");
        const classesFromUniverse = (u: unknown): Array<"stock" | "etf" | "crypto" | "commodity" | "fx"> => {
          const all = ["stock", "etf", "crypto", "commodity", "fx"] as const;
          if (!Array.isArray(u)) return [...all];
          return u.filter((x): x is (typeof all)[number] =>
            typeof x === "string" && (all as readonly string[]).includes(x),
          );
        };

        const today = new Date().toISOString().slice(0, 10);

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

        // 3. Load paper portfolios
        const { data: portfolios, error } = await supabaseAdmin
          .from("portfolios")
          .select("id, name, universe, mode")
          .eq("mode", "paper");

        if (error) {
          console.error("hourly-run: fetch portfolios failed", error);
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

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

        // 5. Run a tick per paper portfolio (sequential, gentle on gateway)
        const results: Array<{ id: string; ok: boolean; error?: string; value?: number }> = [];
        for (const p of portfolios ?? []) {
          try {
            const r = await runDailyTick(p.id, today);
            results.push({ id: p.id, ok: true, value: r.totalValue });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`hourly-run: portfolio ${p.id} failed`, msg);
            results.push({ id: p.id, ok: false, error: msg });
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
          portfolios: portfolios?.length ?? 0,
          results,
        });
      },
    },
  },
});
