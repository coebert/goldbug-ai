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
  results: Array<{
    id: string;
    mode: string;
    ok: boolean;
    error?: string;
    value?: number;
    skipped?: string;
    /** Symbols whose venue was open at gate time (candidates AI could size). */
    tradeable_symbols?: string[];
    /** Symbols dropped by the market-hours gate, with venue + phase reason. */
    excluded_symbols?: Array<{ symbol: string; venue: string; phase: string }>;
  }>;
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
  /** Keep request-bound runs below platform timeout. Defaults to 24s. */
  timeBudgetMs?: number;
  /** Skip per-tick news scoring; news-refresh cron keeps cache warm separately. */
  skipNewsInTicks?: boolean;
  /** Run broad token/news/regime/price refreshes before portfolio ticks. */
  preflightRefresh?: boolean;
}): Promise<HourlyRunResult> {
  return withRunMetrics((metrics) => runHourlyCycleInner(opts, metrics));
}

async function runHourlyCycleInner(
  opts: { triggeredBy: "manual" | "cron"; force?: boolean; timeBudgetMs?: number; skipNewsInTicks?: boolean; preflightRefresh?: boolean },
  metrics: import("@/lib/run-metrics.server").RunMetrics,
): Promise<HourlyRunResult> {
  const runStartedAt = Date.now();
  const RUN_BUDGET_MS = Math.max(8_000, Math.min(opts.timeBudgetMs ?? 24_000, 115_000));
  const runPreflightRefresh = opts.preflightRefresh ?? RUN_BUDGET_MS > 30_000;
  const { acquireRunLock } = await import("@/lib/run-lock.server");
  const { runDailyTick } = await import("@/lib/trading-engine.server");
  const { filterUniverse } = await import("@/lib/universe.server");
  const { getMarketStatusForSymbol } = await import("@/lib/market-hours");

  const manualTrigger = opts.triggeredBy === "manual";
  const forceClear = opts.force === true;

  if (forceClear) {
    await supabaseAdmin.from("run_locks").delete().eq("name", "hourly-run");
  }

  // Defensive stale sweep: if a previous run's worker isolate died before
  // the try/finally could release the lock, the row can wedge every future
  // cron tick. Unconditionally drop any hourly-run row older than the
  // staleness window so acquireRunLock always starts from a clean slate.
  // Short window: a run whose isolate died must not wedge the next cron tick
  // for minutes. Healthy runs heartbeat the lock (see below), so they are
  // never evicted while alive.
  const STALE_MS = 90 * 1000;
  try {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const swept = await supabaseAdmin
      .from("run_locks")
      .delete()
      .eq("name", "hourly-run")
      .lt("acquired_at", cutoff)
      .select("owner, acquired_at");
    if (swept.data && swept.data.length > 0) {
      console.warn("hourly-run: swept stale run_locks row", swept.data[0]);
    }
  } catch (e) {
    console.error("hourly-run: stale-lock sweep failed", e);
  }

  const lock = await acquireRunLock("hourly-run", {
    owner: manualTrigger ? "manual" : "cron",
    staleMs: STALE_MS,
  });

  if (!lock.acquired) {
    throw new RunInProgressError(
      `An hourly run is already in progress (started by ${lock.heldBy ?? "unknown"} ${Math.round(lock.ageMs / 1000)}s ago). Please wait for it to finish before triggering another.`,
      lock.heldBy,
      lock.acquiredAt,
      lock.ageMs,
    );
  }

  // Heartbeat so a long-but-healthy cycle keeps its lock while a crashed one
  // ages out within STALE_MS.
  const heartbeat = setInterval(() => {
    void lock.renew();
  }, 30_000);
  if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
    (heartbeat as unknown as { unref: () => void }).unref();
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: allPortfolios, error } = await supabaseAdmin
      .from("portfolios")
      .select("id, name, user_id, universe, mode, live_paused, broker, broker_account_id")
      .in("mode", ["paper", "live_sim", "live_prod"]);

    if (error) throw new Error(error.message);

    const portfolios = (allPortfolios ?? []).filter(
      (p) => !(p.mode !== "paper" && p.live_paused),
    );
    // Order: real money first, then STALEST first. Without the staleness
    // ordering the same portfolio always won the fixed mode ordering and the
    // rest were permanently starved by the run's time budget.
    const { orderPortfoliosForRun, createBudgetGate } = await import("./run-scheduling");
    const lastDecisionAt = new Map<string, number>();
    try {
      const { data: lastRows } = await supabaseAdmin
        .from("decisions")
        .select("portfolio_id, created_at")
        .in("portfolio_id", portfolios.map((p) => p.id))
        .order("created_at", { ascending: false })
        .limit(500);
      for (const r of lastRows ?? []) {
        const pid = r.portfolio_id as string;
        if (!lastDecisionAt.has(pid)) {
          lastDecisionAt.set(pid, new Date(r.created_at as string).getTime());
        }
      }
    } catch (e) {
      console.warn("hourly-run: staleness lookup failed", e);
    }
    const ordered = orderPortfoliosForRun(portfolios, lastDecisionAt);
    portfolios.length = 0;
    portfolios.push(...ordered);
    const skippedPaused = (allPortfolios ?? []).length - portfolios.length;
    // Starvation guard: a portfolio that hasn't produced a decision recently
    // may bypass the time budget, so every portfolio makes progress even when
    // earlier ticks consume the whole budget. A manual run is explicit user
    // intent: let every stale portfolio through (30-minute threshold) instead
    // of the single 6h override cron uses.
    const isManual = opts.triggeredBy === "manual";
    const budgetGate = createBudgetGate(RUN_BUDGET_MS, lastDecisionAt, {
      starvedMs: isManual ? 30 * 60 * 1000 : undefined,
      overrides: isManual ? Math.max(1, portfolios.length) : 1,
    });




    const saxoRefresh: Record<string, { ok: boolean; error?: string; skipped?: string }> = {};
    if (runPreflightRefresh) {
      try {
        const { forceRefreshTokens, getOAuthStatus } = await import("@/lib/brokers/saxo-oauth.server");
        const { recordTokenRefreshOutcome, checkRefreshWindow } = await import(
          "@/lib/broker-token-health.server",
        );
        const { redactedError } = await import("@/lib/_server/redact");
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
            recordTokenRefreshOutcome({
              env,
              source: "hourly-run",
              ok: true,
              skipped: r.refreshed ? null : r.reason,
            });
            checkRefreshWindow({
              env,
              secondsUntilRefreshExpiry: status.secondsUntilRefreshExpiry,
            });
            saxoRefresh[env] = r.refreshed ? { ok: true } : { ok: true, skipped: r.reason };
          } catch (e) {
            const msg = redactedError(e).message;
            console.error(`hourly-run: saxo refresh failed for ${env}`, msg);
            recordTokenRefreshOutcome({ env, source: "hourly-run", ok: false, error: e });
            saxoRefresh[env] = { ok: false, error: msg };
          }
        }
      } catch (e) {
        console.error("hourly-run: saxo refresh module load failed", e);
      }
    } else {
      saxoRefresh.live = { ok: true, skipped: "bounded run — broker access refreshes inside live tick" };
      saxoRefresh.sim = { ok: true, skipped: "bounded run — broker access refreshes inside live tick" };
    }

    let newsCount = 0;
    if (runPreflightRefresh) {
      try {
        const { invalidateContextCache } = await import("@/lib/market-context-cache.server");
        invalidateContextCache();
        const { count } = await supabaseAdmin
          .from("news_cache")
          .select("id", { count: "exact", head: true })
          .eq("news_date", today);
        newsCount = count ?? 0;
      } catch (e) {
        console.error("hourly-run: news cache count failed", e);
      }
    }

    let regimeInfo: unknown = null;
    if (runPreflightRefresh) {
      try {
        const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");
        regimeInfo = await detectAndPersistRegime(today);
      } catch (e) {
        console.error("hourly-run: regime detection failed", e);
      }
    }

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
    if (runPreflightRefresh && symbolSet.size > 0) {
      try {
        const { refreshLatestCandles } = await import("@/lib/market-data.server");
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
        if (budgetGate.shouldSkip(p.id, elapsed, Date.now())) {
          bumpBudgetExceeded();
          results.push({
            id: p.id,
            mode: p.mode,
            ok: true,
            skipped: `budget-exceeded (elapsed ${(elapsed / 1000).toFixed(0)}s) — next tick will pick this up`,
          });
          continue;
        }



        // Market-hours gate: skip AI decision cycles when every venue in this
        // portfolio's universe is currently closed. Crypto/FX are always
        // "open" so any portfolio that includes them will still tick.
        // `force:true` (manual override) bypasses this to allow ad-hoc runs
        // outside market hours (e.g. testing, backfills). This saves AI
        // credits during nights and weekends when no order could fill anyway.
        // Compute the tradeable/excluded split up front (independent of the
        // gate) so every portfolio result carries an auditable record of
        // which venues were open at decision time. `force:true` only bypasses
        // the skip decision, not the audit.
        let tradeableSymbols: string[] = [];
        let excludedSymbols: Array<{ symbol: string; venue: string; phase: string }> = [];
        try {
          const universe = filterUniverse(classesFromUniverse(p.universe));
          const symbols = universe.slice(0, 22).map((u) => u.symbol);
          for (const s of symbols) {
            const st = getMarketStatusForSymbol(s);
            if (st.isOpen) tradeableSymbols.push(s);
            else excludedSymbols.push({ symbol: s, venue: st.venue, phase: st.phase });
          }
        } catch (e) {
          console.warn("hourly-run: market-hours audit failed", p.id, e);
        }

        // Market-hours gate: skip AI decision cycles when every venue in this
        // portfolio's universe is currently closed. Crypto/FX are always
        // "open" so any portfolio that includes them will still tick.
        if (!forceClear && tradeableSymbols.length === 0 && excludedSymbols.length > 0) {
          results.push({
            id: p.id,
            mode: p.mode,
            ok: true,
            skipped: "all venues closed — AI tick skipped to save credits (pass force:true to override)",
            tradeable_symbols: tradeableSymbols,
            excluded_symbols: excludedSymbols,
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
            results.push({
              id: p.id,
              mode: p.mode,
              ok: true,
              skipped: label,
              tradeable_symbols: tradeableSymbols,
              excluded_symbols: excludedSymbols,
            });
            continue;
          }
        }

        const r = await runDailyTick(p.id, today, { skipNews: opts.skipNewsInTicks ?? true });
        bumpPortfolio("ok");
        results.push({
          id: p.id,
          mode: p.mode,
          ok: true,
          value: r.totalValue,
          tradeable_symbols: tradeableSymbols,
          excluded_symbols: excludedSymbols,
        });

        // Post-tick order-status reconciliation for live portfolios.
        // Without this, orders written as `submitted` at POST time never
        // transition to `filled` in our DB — the market-order fills that
        // Saxo executed simply vanish from `/port/v1/orders/me` and no
        // subsequent local update happens. Runs best-effort; a failure
        // here must not fail the tick.
        if ((p.mode === "live_sim" || p.mode === "live_prod") && p.user_id) {
          try {
            const env = p.mode === "live_prod" ? "live" : "sim";
            const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
            const { reconcileOrderStatusesForPortfolio } = await import(
              "@/lib/order-reconciliation.server"
            );
            const { resolvePortfolioBrokerLink } = await import(
              "@/lib/brokers/portfolio-broker-link.server"
            );
            const link = resolvePortfolioBrokerLink(p);
            if (!link.linked) throw new Error(link.reason);
            const adapter = await buildSaxoAdapter({
              userId: p.user_id as string,
              portfolioId: p.id,
              envOverride: env,
              accountKey: link.accountKey,
            });
            await reconcileOrderStatusesForPortfolio({
              portfolioId: p.id,
              userId: p.user_id as string,
              adapter,
              lookbackHours: 72,
            });
          } catch (e) {
            console.warn("hourly-run: order reconcile failed", p.id, e);
          }
        }

        // Intended-vs-executed reconciliation. If the AI wanted to trade
        // but no live_orders rows appeared for two consecutive ticks, we
        // consider the executor stalled and raise an alert. live_prod only
        // — paper / live_sim don't write to live_orders in the same way.
        if (p.mode === "live_prod" && p.user_id) {
          const { maybeAlertOrdersReconciliation } = await import(
            "@/lib/orders-reconciliation-alert.server"
          );
          maybeAlertOrdersReconciliation({
            portfolioId: p.id,
            userId: p.user_id as string,
            portfolioName: p.name ?? null,
          });
          const { maybeAlertIntendedVsExecuted } = await import(
            "@/lib/intended-vs-executed-alert.server"
          );
          maybeAlertIntendedVsExecuted({
            portfolioId: p.id,
            userId: p.user_id as string,
            portfolioName: p.name ?? null,
          });
        }


      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`hourly-run: portfolio ${p.id} failed`, msg);
        bumpPortfolio("error");
        results.push({ id: p.id, mode: p.mode, ok: false, error: msg });
      }
    }

    const metricsSnap = snapshot(metrics);
    try {
      await supabaseAdmin.from("run_metrics").insert({
        triggered_by: manualTrigger ? "manual" : "cron",
        success: true,
        duration_ms: metricsSnap.duration_ms,
        portfolios_total: portfolios.length,
        portfolios_ok: metricsSnap.portfolios_ok,
        portfolios_error: metricsSnap.portfolios_error,
        budget_exceeded_count: metricsSnap.budget_exceeded_count,
        saxo_calls_total: metricsSnap.saxo_calls_total,
        saxo_calls_ok: metricsSnap.saxo_calls_ok,
        saxo_calls_error: metricsSnap.saxo_calls_error,
        saxo_retries_429: metricsSnap.saxo_retries_429,
        news_headlines: newsCount,
        prices_refreshed: priceRefresh.refreshed,
        price_errors: priceRefresh.errors,
      });
    } catch (e) {
      console.error("hourly-run: failed to persist run_metrics", e);
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
      metrics: metricsSnap,
    };
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
}