import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { withRunMetrics, snapshot, bumpBudgetExceeded, bumpPortfolio } from "@/lib/run-metrics.server";

export type RunMetricsSnapshot = ReturnType<typeof snapshot>;

export type HourlyRunResult = {
  success: true;
  hour_utc: string;
  date: string;
  news_headlines: number;
  prices_refreshed: number;
  price_errors: number;
  symbols_watched: number;
  regime: unknown;
  portfolios: number;
  skipped_paused: number;
  saxo_refresh: Record<string, { ok: boolean; error?: string; skipped?: string }>;
  triggered_by: "manual" | "cron";
  results: Array<{ id: string; mode: string; ok: boolean; error?: string; value?: number; skipped?: string }>;
  metrics: RunMetricsSnapshot;
};

export class RunInProgressError extends Error {
  code = "run_in_progress" as const;

  constructor(
    message: string,
    public heldBy: string | null,
    public acquiredAt: string,
    public ageMs: number,
  ) {
    super(message);
    this.name = "RunInProgressError";
  }
}

function classesFromUniverse(u: unknown): Array<"stock" | "etf" | "crypto" | "commodity" | "fx"> {
  const all = ["stock", "etf", "crypto", "commodity", "fx"] as const;
  if (!Array.isArray(u)) return [...all];
  return u.filter((x): x is (typeof all)[number] =>
    typeof x === "string" && (all as readonly string[]).includes(x),
  );
}

export async function runHourlyCycle(opts: {
  triggeredBy: "manual" | "cron";
  force?: boolean;
}): Promise<HourlyRunResult> {
  return withRunMetrics((metrics) => runHourlyCycleInner(opts, metrics));
}

async function runHourlyCycleInner(
  opts: { triggeredBy: "manual" | "cron"; force?: boolean },
  metrics: import("@/lib/run-metrics.server").RunMetrics,
): Promise<HourlyRunResult> {
  const runStartedAt = Date.now();
  const RUN_BUDGET_MS = 115 * 1000;
  const { acquireRunLock } = await import("@/lib/run-lock.server");
  const { runDailyTick } = await import("@/lib/trading-engine.server");
  const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");
  const { getNewsForDate } = await import("@/lib/news.server");
  const { refreshLatestCandles } = await import("@/lib/market-data.server");
  const { filterUniverse } = await import("@/lib/universe.server");

  const manualTrigger = opts.triggeredBy === "manual";
  const forceClear = opts.force === true;

  if (forceClear) {
    await supabaseAdmin.from("run_locks").delete().eq("name", "hourly-run");
  }

  const lock = await acquireRunLock("hourly-run", {
    owner: manualTrigger ? "manual" : "cron",
    staleMs: 3 * 60 * 1000,
  });
  if (!lock.acquired) {
    throw new RunInProgressError(
      `An hourly run is already in progress (started by ${lock.heldBy ?? "unknown"} ${Math.round(lock.ageMs / 1000)}s ago). Please wait for it to finish before triggering another.`,
      lock.heldBy,
      lock.acquiredAt,
      lock.ageMs,
    );
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    const saxoRefresh: Record<string, { ok: boolean; error?: string; skipped?: string }> = {};
    try {
      const { forceRefreshTokens, getOAuthStatus } = await import("@/lib/brokers/saxo-oauth.server");
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

    let newsCount = 0;
    try {
      const { invalidateContextCache } = await import("@/lib/market-context-cache.server");
      invalidateContextCache();
      const items = await getNewsForDate(today, 15, { forceRefresh: true });
      newsCount = items.length;
    } catch (e) {
      console.error("hourly-run: news refresh failed", e);
    }

    let regimeInfo: unknown = null;
    try {
      regimeInfo = await detectAndPersistRegime(today);
    } catch (e) {
      console.error("hourly-run: regime detection failed", e);
    }

    const { data: allPortfolios, error } = await supabaseAdmin
      .from("portfolios")
      .select("id, name, universe, mode, live_paused")
      .in("mode", ["paper", "live_sim", "live_prod"]);

    if (error) throw new Error(error.message);

    const portfolios = (allPortfolios ?? []).filter(
      (p) => !(p.mode !== "paper" && p.live_paused),
    );
    const skippedPaused = (allPortfolios ?? []).length - portfolios.length;

    const symbolSet = new Set<string>();
    for (const p of portfolios) {
      try {
        const universe = filterUniverse(classesFromUniverse(p.universe));
        for (const c of universe.slice(0, 22)) symbolSet.add(c.symbol);
      } catch (e) {
        console.warn("hourly-run: universe parse failed", p.id, e);
      }
    }

    const { data: heldRows } = portfolios.length
      ? await supabaseAdmin
          .from("holdings")
          .select("symbol")
          .in(
            "portfolio_id",
            portfolios.map((p) => p.id),
          )
      : { data: [] as Array<{ symbol: string }> };
    for (const h of heldRows ?? []) symbolSet.add(h.symbol);

    let priceRefresh = { refreshed: 0, errors: 0 };
    if (symbolSet.size > 0) {
      try {
        priceRefresh = await refreshLatestCandles(Array.from(symbolSet));
      } catch (e) {
        console.error("hourly-run: price refresh failed", e);
      }
    }

    const hourStartUtc = new Date();
    hourStartUtc.setUTCMinutes(0, 0, 0);
    const hourStartIso = hourStartUtc.toISOString();
    const recentWindowIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const results: HourlyRunResult["results"] = [];

    for (const p of portfolios) {
      try {
        const elapsed = Date.now() - runStartedAt;
        if (elapsed > RUN_BUDGET_MS) {
          results.push({
            id: p.id,
            mode: p.mode,
            ok: true,
            skipped: `budget-exceeded (elapsed ${(elapsed / 1000).toFixed(0)}s) — next tick will pick this up`,
          });
          continue;
        }

        const sinceIso = manualTrigger ? recentWindowIso : hourStartIso;
        if (!(manualTrigger && forceClear)) {
          const recent = await supabaseAdmin
            .from("decisions")
            .select("id, created_at")
            .eq("portfolio_id", p.id)
            .gte("created_at", sinceIso)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (recent.data) {
            const label = manualTrigger
              ? `already ticked at ${recent.data.created_at} — pass force:true to override`
              : "already ticked this hour";
            results.push({ id: p.id, mode: p.mode, ok: true, skipped: label });
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

    return {
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
    };
  } finally {
    await lock.release();
  }
}