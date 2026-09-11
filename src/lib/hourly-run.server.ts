import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { withRunMetrics, snapshot, bumpBudgetExceeded, bumpPortfolio } from "@/lib/run-metrics.server";
import { createRunTelemetry, describeSelection, type RunTelemetrySnapshot } from "@/lib/run-telemetry";
import { createConsoleLogger } from "@/lib/_server/log";

const srvLog = createConsoleLogger("hourly-run");

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
    /** Portfolio display name, so the admin UI needn't join on ids. */
    name?: string | null;
    /** ISO time this portfolio entered the tick loop. */
    started_at?: string;
    /** ISO time this portfolio left the tick loop (ticked or skipped). */
    finished_at?: string;
    /** Wall-clock ms spent on this portfolio. */
    duration_ms?: number;
    /** Symbols whose venue was open at gate time (candidates AI could size). */
    tradeable_symbols?: string[];
    /** Symbols dropped by the market-hours gate, with venue + phase reason. */
    excluded_symbols?: Array<{ symbol: string; venue: string; phase: string }>;
  }>;
  /**
   * Per-portfolio run status for EVERY known portfolio — including ones left
   * untouched by a scoped manual run — plus last-run timestamps before/after.
   */
  portfolio_status: import("@/lib/run-portfolio-status").RunPortfolioStatus[];
  metrics: RunMetricsSnapshot;
  /** Structured timings: pre-flight cost, selection, per-tick, deadline usage. */
  telemetry: RunTelemetrySnapshot;
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
  /**
   * Manual runs only: ignore the 10-minute "already ticked" window WITHOUT
   * force-clearing the run lock. `force: true` implies this.
   */
  forceTick?: boolean;
  /** Keep request-bound runs below platform timeout. Defaults to 24s. */
  timeBudgetMs?: number;
  /** Skip per-tick news scoring; news-refresh cron keeps cache warm separately. */
  skipNewsInTicks?: boolean;
  /** Run broad token/news/regime/price refreshes before portfolio ticks. */
  preflightRefresh?: boolean;
  /** Restrict the run to these portfolio ids (manual runs). Empty/undefined = all. */
  portfolioIds?: string[];
}): Promise<HourlyRunResult> {
  return withRunMetrics((metrics) => runHourlyCycleInner(opts, metrics));
}

async function runHourlyCycleInner(
  opts: { triggeredBy: "manual" | "cron"; force?: boolean; forceTick?: boolean; timeBudgetMs?: number; skipNewsInTicks?: boolean; preflightRefresh?: boolean; portfolioIds?: string[] },
  metrics: import("@/lib/run-metrics.server").RunMetrics,
): Promise<HourlyRunResult> {
  const runStartedAt = Date.now();
  const RUN_BUDGET_MS = Math.max(8_000, Math.min(opts.timeBudgetMs ?? 24_000, 115_000));
  const runPreflightRefresh = opts.preflightRefresh ?? RUN_BUDGET_MS > 30_000;
  // Structured telemetry: every record carries the same run_id so one manual
  // run can be reconstructed from the logs with a single grep.
  const tel = createRunTelemetry({
    triggeredBy: opts.triggeredBy,
    force: opts.force,
    budgetMs: RUN_BUDGET_MS,
    preflightRefresh: runPreflightRefresh,
  });
  const { acquireRunLock } = await import("@/lib/run-lock.server");
  const { runDailyTick } = await import("@/lib/trading-engine.server");
  const { filterUniverse } = await import("@/lib/universe.server");
  const { getMarketStatusForSymbol } = await import("@/lib/market-hours");


  const manualTrigger = opts.triggeredBy === "manual";
  const forceClear = opts.force === true;
  // Override for the 10-minute "already ticked" guard. `force` (force clear
  // lock & run) implies it; `forceTick` enables it on its own so an operator
  // can re-tick without evicting a lock that may still be healthy.
  const overrideTickWindow = forceClear || opts.forceTick === true;

  if (forceClear) {
    await supabaseAdmin.from("run_locks").delete().eq("name", "hourly-run");
  }

  // TTL cleanup: every lock row carries an absolute `expires_at`. If a
  // previous run's worker isolate died (manual run hitting the request
  // deadline is the common case) the release never ran, but the row expires
  // on its own and is swept here before we try to acquire. Healthy runs push
  // the deadline forward on each heartbeat, so they are never swept alive.
  const STALE_MS = 90 * 1000;
  const { sweepExpiredRunLocks } = await import("@/lib/run-lock.server");
  const removed = await sweepExpiredRunLocks({
    name: "hourly-run",
    fallbackTtlMs: STALE_MS,
  });
  if (removed > 0) {
    srvLog.warn(`hourly-run: TTL sweep removed ${removed} expired run_locks row(s)`);
  }

  // The lock must outlive the run's own time budget (plus post-loop work such
  // as metrics persistence), and must expire soon after a timeout so the next
  // trigger is not blocked.
  const { lockTtlMsForBudget } = await import("@/lib/run-lock-ttl");
  const LOCK_TTL_MS = lockTtlMsForBudget(RUN_BUDGET_MS);

  const lock = await acquireRunLock("hourly-run", {
    owner: manualTrigger ? "manual" : "cron",
    staleMs: STALE_MS,
    ttlMs: LOCK_TTL_MS,
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

    // Optional manual scoping: run only the selected portfolios so a targeted
    // run isn't spent on unrelated profiles.
    const selection = (opts.portfolioIds ?? []).filter((id) => typeof id === "string" && id);
    const selected = selection.length
      ? (allPortfolios ?? []).filter((p) => selection.includes(p.id))
      : (allPortfolios ?? []);

    const portfolios = selected.filter(
      (p) => !(p.mode !== "paper" && p.live_paused),
    );
    // Emitted before any portfolio is touched: which ids were requested,
    // which matched, which were unknown, and which were dropped as paused.
    tel.recordSelection(describeSelection(opts.portfolioIds, allPortfolios ?? []));

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
      srvLog.warn("hourly-run: staleness lookup failed", e);
    }
    const ordered = orderPortfoliosForRun(portfolios, lastDecisionAt);
    portfolios.length = 0;
    portfolios.push(...ordered);
    const skippedPaused = selected.length - portfolios.length;
    // Starvation guard: cron may admit one stale portfolio past its soft
    // budget so accounts rotate across scheduled cycles. Manual runs are
    // request-bound and must never bypass the deadline: doing so caused the
    // worker to terminate a multi-portfolio request and leave a stale lock.
    const isManual = opts.triggeredBy === "manual";
    const budgetGate = createBudgetGate(RUN_BUDGET_MS, lastDecisionAt, {
      overrides: isManual ? 0 : 1,
    });




    const saxoRefresh: Record<string, { ok: boolean; error?: string; skipped?: string }> = {};
    const saxoT0 = Date.now();
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
            srvLog.error(`hourly-run: saxo refresh failed for ${env}`, msg);
            recordTokenRefreshOutcome({ env, source: "hourly-run", ok: false, error: e });
            saxoRefresh[env] = { ok: false, error: msg };
          }
        }
      } catch (e) {
        srvLog.error("hourly-run: saxo refresh module load failed", e);
      }
      tel.recordPhase("saxo_refresh", Date.now() - saxoT0);
    } else {
      saxoRefresh.live = { ok: true, skipped: "bounded run — broker access refreshes inside live tick" };
      saxoRefresh.sim = { ok: true, skipped: "bounded run — broker access refreshes inside live tick" };
      tel.recordPhase("saxo_refresh", 0, true, "preflight disabled for bounded run");
    }

    let newsCount = 0;
    const newsT0 = Date.now();
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
        srvLog.error("hourly-run: news cache count failed", e);
      }
      // Director / PDMR dealings for held names never reach the general wires,
      // so they get their own bounded pass alongside the news step.
      //
      // COST: this is a 60-way Google News RSS fan-out plus Investegate RNS
      // scraping — measured at ~40s, which alone blew the pre-flight budget and
      // put portfolio ticks at risk of being skipped. A dedicated cron
      // (`insider-ai-scan-4h`) already runs the same ingest with AI review, so
      // the hourly pass is throttled to at most once every 2 hours via the
      // shared token bucket instead of running on every tick.
      let insiderNote = "";
      try {
        let mayRun = true;
        try {
          const { data } = await supabaseAdmin.rpc("consume_rate_limit", {
            _key: "hourly-run:insider-ingest",
            _capacity: 1,
            _refill_per_sec: 1 / 7200,
            _cost: 1,
          });
          const row = Array.isArray(data) ? data[0] : data;
          mayRun = row?.allowed !== false;
        } catch {
          /* bucket unavailable — fall through and run */
        }
        if (!mayRun) {
          insiderNote = ", insider skipped (4h cron owns it)";
        } else {
          const { ingestInsiderDealings } = await import("@/lib/insider-dealings.server");
          const res = await ingestInsiderDealings(supabaseAdmin as never, { windowDays: 7 });
          insiderNote = `, insider ${res.stored}/${res.detected} across ${res.targets} names${
            res.alerted ? `, ${res.alerted} disposal alert(s)` : ""
          }`;
        }
      } catch (e) {
        srvLog.error("hourly-run: insider dealings ingest failed", e);
      }
      tel.recordPhase("news", Date.now() - newsT0, false, `${newsCount} headlines${insiderNote}`);

    } else {
      tel.recordPhase("news", 0, true, "preflight disabled for bounded run");
    }

    let regimeInfo: unknown = null;
    const regimeT0 = Date.now();
    if (runPreflightRefresh) {
      try {
        const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");
        regimeInfo = await detectAndPersistRegime(today);
      } catch (e) {
        srvLog.error("hourly-run: regime detection failed", e);
      }
      tel.recordPhase("regime", Date.now() - regimeT0);
    } else {
      tel.recordPhase("regime", 0, true, "preflight disabled for bounded run");
    }

    const symbolsT0 = Date.now();
    const symbolSet = new Set<string>();
    for (const p of portfolios) {
      try {
        const universe = filterUniverse(classesFromUniverse(p.universe));
        for (const c of universe.slice(0, 22)) symbolSet.add(c.symbol);
      } catch (e) {
        srvLog.warn("hourly-run: universe parse failed", p.id, e);
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
    tel.recordPhase("symbols", Date.now() - symbolsT0, false, `${symbolSet.size} symbols`);

    let priceRefresh = { refreshed: 0, errors: 0 };
    const pricesT0 = Date.now();
    if (runPreflightRefresh && symbolSet.size > 0) {
      try {
        const { refreshLatestCandles } = await import("@/lib/market-data.server");
        priceRefresh = await refreshLatestCandles(Array.from(symbolSet));
      } catch (e) {
        srvLog.error("hourly-run: price refresh failed", e);
      }
      tel.recordPhase(
        "prices",
        Date.now() - pricesT0,
        false,
        `${priceRefresh.refreshed} refreshed / ${priceRefresh.errors} errors`,
      );
    } else {
      tel.recordPhase("prices", 0, true, runPreflightRefresh ? "no symbols" : "preflight disabled for bounded run");
    }



    const hourStartUtc = new Date();
    hourStartUtc.setUTCMinutes(0, 0, 0);
    const hourStartIso = hourStartUtc.toISOString();
    const recentWindowIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const results: HourlyRunResult["results"] = [];

    const runTickFor = async (p: (typeof portfolios)[number]) => {
      const tickT0 = tel.tickStart(p.id, String(p.mode));
      // Per-portfolio timing + name so the admin UI can show exactly what
      // happened to each portfolio without a second round-trip.
      const startedAtMs = Date.now();
      const startedIso = new Date(startedAtMs).toISOString();
      const push = (row: HourlyRunResult["results"][number]) => {
        const finished = Date.now();
        results.push({
          ...row,
          name: p.name ?? null,
          started_at: startedIso,
          finished_at: new Date(finished).toISOString(),
          duration_ms: finished - startedAtMs,
        });
      };
      try {
        // Mark live portfolios to market on EVERY run, before any gate.
        // Skipped ticks (closed venues, budget, already-ticked) used to leave
        // the app's equity frozen while Saxo moved on; this keeps holdings,
        // today's snapshot and the hourly equity point in step regardless.
        if ((p.mode === "live_sim" || p.mode === "live_prod") && p.user_id) {
          const { refreshLiveValuation } = await import(
            "@/lib/live-valuation-refresh.server"
          );
          const vr = await refreshLiveValuation(p.id, p.user_id as string);
          if (!vr.refreshed) {
            srvLog.warn("hourly-run: live valuation refresh skipped", p.id, vr.reason);
          }

          // Independent check: does the app's stored equity still agree with
          // Saxo's account total? Logged to live_reconciliation every run and
          // escalated to a notification once the gap crosses the threshold.
          const { reconcileLiveEquityAgainstBroker } = await import(
            "@/lib/live-equity-reconcile.server"
          );
          const rec = await reconcileLiveEquityAgainstBroker(p.id, p.user_id as string);
          if (rec.checked && rec.drift.severity !== "ok") {
            srvLog.warn(
              `hourly-run: equity drift ${rec.drift.severity}`,
              p.id,
              rec.drift.note,
            );
          }

          // Spare currency legs sitting on a loss are flattened at the live
          // rate so the book never carries an unwanted, stale FX bet.
          try {
            const { sweepLosingFxLegs } = await import("@/lib/fx-auto-close.server");
            const sweep = await sweepLosingFxLegs({
              supabase: supabaseAdmin,
              userId: p.user_id as string,
              portfolioId: p.id,
            });
            for (const o of sweep.outcomes) {
              if (o.closed) srvLog.info("hourly-run: auto-closed FX leg", p.id, o.symbol, o.reason);
              else if (o.detail)
                srvLog.warn("hourly-run: FX auto-close failed", p.id, o.symbol, o.detail);
            }
          } catch (e) {
            srvLog.warn("hourly-run: FX auto-close sweep failed", p.id, String(e));
          }
        }


        const elapsed = Date.now() - runStartedAt;

        if (budgetGate.shouldSkip(p.id, elapsed, Date.now())) {
          bumpBudgetExceeded();
          const reason = `budget-exceeded (elapsed ${(elapsed / 1000).toFixed(0)}s) — next tick will pick this up`;
          tel.tickSkipped(p.id, String(p.mode), reason);
          push({
            id: p.id,
            mode: p.mode,
            ok: true,
            skipped: reason,
          });
          return;
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
          srvLog.warn("hourly-run: market-hours audit failed", p.id, e);
        }

        // Market-hours gate: skip AI decision cycles when every venue in this
        // portfolio's universe is currently closed. Crypto/FX are always
        // "open" so any portfolio that includes them will still tick.
        if (!forceClear && tradeableSymbols.length === 0 && excludedSymbols.length > 0) {
          const reason = "all venues closed — AI tick skipped to save credits (pass force:true to override)";
          tel.tickSkipped(p.id, String(p.mode), reason);
          push({
            id: p.id,
            mode: p.mode,
            ok: true,
            skipped: reason,
            tradeable_symbols: tradeableSymbols,
            excluded_symbols: excludedSymbols,
          });
          return;
        }


        const sinceIso = manualTrigger ? recentWindowIso : hourStartIso;
        if (!(manualTrigger && overrideTickWindow)) {
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
              ? `already ticked at ${recent.data.created_at} — enable "Force clear" (or pass forceTick:true) to override`
              : "already ticked this hour";
            tel.tickSkipped(p.id, String(p.mode), label);
            push({
              id: p.id,
              mode: p.mode,
              ok: true,
              skipped: label,
              tradeable_symbols: tradeableSymbols,
              excluded_symbols: excludedSymbols,
            });
            return;
          }
        }

        // Pre-trade orphan sweep: a pending order that is stuck locally, or
        // resting far too long at the broker (the MKS.L sell), blocks every
        // replacement for that symbol. Clear or reconcile those BEFORE the
        // tick decides on new trades. Best-effort — never fails the tick.
        if ((p.mode === "live_sim" || p.mode === "live_prod") && p.user_id) {
          try {
            const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
            const { resolvePortfolioBrokerLink } = await import(
              "@/lib/brokers/portfolio-broker-link.server"
            );
            const { sweepOrphanOrdersForPortfolio } = await import(
              "@/lib/orphan-order-sweep.server"
            );
            const link = resolvePortfolioBrokerLink(p);
            if (!link.linked) throw new Error(link.reason);
            const env = p.mode === "live_prod" ? "live" : "sim";
            const sweep = await sweepOrphanOrdersForPortfolio({
              portfolioId: p.id,
              userId: p.user_id as string,
              env,
              source: "hourly-pre-tick",
              adapter: await buildSaxoAdapter({
                userId: p.user_id as string,
                portfolioId: p.id,
                envOverride: env,
                accountKey: link.accountKey,
              }),
            });
            if (sweep.cancelledAtBroker + sweep.closedLocally + sweep.cancelledUntracked > 0) {
              srvLog.info(
                "hourly-run: orphan orders cleared",
                p.id,
                `broker=${sweep.cancelledAtBroker} local=${sweep.closedLocally} untracked=${sweep.cancelledUntracked}`,
              );
            }
          } catch (e) {
            srvLog.warn("hourly-run: orphan sweep failed", p.id, e);
          }
        }

        const r = await runDailyTick(p.id, today, { skipNews: opts.skipNewsInTicks ?? true });
        bumpPortfolio("ok");

        tel.tickEnd(p.id, String(p.mode), tickT0, "ok");
        push({
          id: p.id,
          mode: p.mode,
          ok: true,
          value: r.totalValue,
          tradeable_symbols: tradeableSymbols,
          excluded_symbols: excludedSymbols,
        });


        // User-defined strategy rules (entry / stop-loss / take-profit) and
        // the per-position drawdown budget. Best-effort: a failure here must
        // not fail the tick.
        if (p.user_id) {
          try {
            const { data: full } = await supabaseAdmin
              .from("portfolios")
              .select(
                "id, mode, status, currency, current_cash, cash_by_ccy, live_paused, holding_dd_budget_pct, holding_dd_autoclose, concentration_cap_pct, concentration_autotrim",
              )
              .eq("id", p.id)
              .maybeSingle();
            const { data: strategyRows } = await supabaseAdmin
              .from("trade_strategies")
              .select("*")
              .eq("portfolio_id", p.id)
              .eq("enabled", true);
            if (
              full &&
              ((strategyRows?.length ?? 0) > 0 ||
                full.holding_dd_autoclose ||
                full.concentration_autotrim)
            ) {
              const { evaluateStrategies, evaluateHoldingDrawdownBudget, evaluateConcentrationCap } = await import(
                "@/lib/strategy-engine.server"
              );
              const portfolioLike = {
                id: full.id,
                mode: String(full.mode),
                status: String(full.status),
                currency: String(full.currency),
                current_cash: Number(full.current_cash),
                cash_by_ccy: (full.cash_by_ccy as Record<string, number> | null) ?? null,
                live_paused: Boolean(full.live_paused),
                holding_dd_budget_pct:
                  full.holding_dd_budget_pct != null ? Number(full.holding_dd_budget_pct) : null,
                holding_dd_autoclose: Boolean(full.holding_dd_autoclose),
                concentration_cap_pct:
                  full.concentration_cap_pct != null ? Number(full.concentration_cap_pct) : null,
                concentration_autotrim: Boolean(full.concentration_autotrim),
              };
              await evaluateStrategies({
                supabase: supabaseAdmin,
                userId: p.user_id,
                portfolio: portfolioLike,
                strategies: (strategyRows ?? []).map((r) => ({
                  id: r.id,
                  portfolio_id: r.portfolio_id,
                  symbol: r.symbol,
                  asset_class: String(r.asset_class),
                  instrument_ccy: r.instrument_ccy,
                  quantity: Number(r.quantity),
                  entry_price: Number(r.entry_price),
                  entry_mode: r.entry_mode,
                  stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
                  take_profit: r.take_profit != null ? Number(r.take_profit) : null,
                  enabled: r.enabled,
                  status: r.status,
                })),
              });
              await evaluateHoldingDrawdownBudget({
                supabase: supabaseAdmin,
                userId: p.user_id,
                portfolio: portfolioLike,
              });
              await evaluateConcentrationCap({
                supabase: supabaseAdmin,
                userId: p.user_id,
                portfolio: portfolioLike,
              });
            }
          } catch (e) {
            console.error("strategy evaluation failed", p.id, (e as Error).message);
          }
        }

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

            // Pull the broker's booked charges onto the fill tape. Runs after
            // reconciliation so fills written this tick are already present.
            // Until this lands, live_fills.fee is 0 and the friction KPI is
            // grading our own cost model rather than the invoice.
            try {
              const { ingestBrokerCostsForPortfolio } = await import(
                "@/lib/broker-cost-ingest.server"
              );
              const costs = await ingestBrokerCostsForPortfolio({
                portfolioId: p.id,
                userId: p.user_id as string,
                adapter,
              });
              if (costs.supported && costs.fillsUpdated > 0) {
                srvLog.info(
                  "hourly-run: broker costs ingested",
                  p.id,
                  `${costs.fillsUpdated}/${costs.fillsConsidered} fills`,
                );
              } else if (!costs.supported) {
                srvLog.warn("hourly-run: broker cost report unavailable", p.id, costs.reason);
              }
              // Raise an in-app alert (and optional webhook) when the report
              // failed or left too many fills on modelled costs, so the
              // friction KPI is never silently a projection.
              const { maybeNotifyCostSyncHealth } = await import("@/lib/cost-sync-alert.server");
              maybeNotifyCostSyncHealth({
                portfolioId: p.id,
                userId: p.user_id as string,
                portfolioName: p.name ?? null,
                result: {
                  supported: costs.supported,
                  fillsConsidered: costs.fillsConsidered,
                  fillsUpdated: costs.fillsUpdated,
                  unmatchedFills: costs.unmatchedFills,
                  reason: costs.reason ?? null,
                },
              });

              // Beyond this single pass: is coverage over the last three
              // 7-day windows below the floor, or sliding two windows running?
              const { maybeNotifyCoverageTrend } = await import(
                "@/lib/coverage-trend-alert.server"
              );
              maybeNotifyCoverageTrend({
                portfolioId: p.id,
                userId: p.user_id as string,
                portfolioName: p.name ?? null,
              });
            } catch (e) {
              srvLog.warn("hourly-run: broker cost ingest failed", p.id, e);
              const { maybeNotifyCostSyncHealth } = await import("@/lib/cost-sync-alert.server");
              maybeNotifyCostSyncHealth({
                portfolioId: p.id,
                userId: p.user_id as string,
                portfolioName: p.name ?? null,
                result: {
                  supported: false,
                  fillsConsidered: 0,
                  fillsUpdated: 0,
                  unmatchedFills: 0,
                  error: e instanceof Error ? e.message : String(e),
                },
              });
            }

          } catch (e) {
            srvLog.warn("hourly-run: order reconcile failed", p.id, e);
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
          // Per-leg automatic reconciliation: pairs every intended leg from
          // this tick's decision with the broker order/fills that followed and
          // flags dropped legs, side/quantity mismatches, adverse fill prices,
          // stuck orders and phantom orders.
          const { maybeReconcileTradeLegs } = await import(
            "@/lib/trade-leg-reconciliation.server"
          );
          maybeReconcileTradeLegs({
            portfolioId: p.id,
            userId: p.user_id as string,
            portfolioName: p.name ?? null,
          });
          // Rolling outcome metrics on top of those discrepancies: alerts when
          // dropped legs spike, inventory nearly strands, or adverse prints drag.
          const { maybeRaiseReconMetricAlerts } = await import("@/lib/recon-metrics.server");
          maybeRaiseReconMetricAlerts({
            portfolioId: p.id,
            userId: p.user_id as string,
            portfolioName: p.name ?? null,
          });
        }


      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        srvLog.error(`hourly-run: portfolio ${p.id} failed`, msg);
        bumpPortfolio("error");
        tel.tickEnd(p.id, String(p.mode), tickT0, "error", msg);
        push({ id: p.id, mode: p.mode, ok: false, error: msg });
      }
    };

    // A single tick costs ~25-35s, so a serial loop can only ever complete one
    // portfolio inside a request-bound manual run — everything else was skipped
    // as `budget-exceeded`. Ticks are independent per portfolio, so manual runs
    // fan them out with bounded concurrency and all selected profiles finish
    // inside the same deadline. Cron keeps the serial path (it has repeated
    // cycles and must stay gentle on broker rate limits).
    const tickConcurrency = isManual ? Math.min(4, Math.max(1, portfolios.length)) : 1;
    if (tickConcurrency <= 1) {
      for (const p of portfolios) await runTickFor(p);
    } else {
      const queue = [...portfolios];
      await Promise.all(
        Array.from({ length: tickConcurrency }, async () => {
          for (;;) {
            const p = queue.shift();
            if (!p) return;
            await runTickFor(p);
          }
        }),
      );
    }

    // Per-portfolio status board. Covers EVERY known portfolio, so a scoped
    // manual run can prove that unselected profiles were left untouched, and
    // carries last-run timestamps from before and after this run.
    const { buildPortfolioRunStatuses } = await import("@/lib/run-portfolio-status");
    const previousRunAt: Record<string, string | null> = {};
    for (const [pid, ms] of lastDecisionAt) previousRunAt[pid] = new Date(ms).toISOString();
    const lastRunAt: Record<string, string | null> = { ...previousRunAt };
    try {
      const ids = (allPortfolios ?? []).map((p) => p.id);
      if (ids.length) {
        const { data: freshRows } = await supabaseAdmin
          .from("decisions")
          .select("portfolio_id, created_at")
          .in("portfolio_id", ids)
          .order("created_at", { ascending: false })
          .limit(500);
        for (const r of freshRows ?? []) {
          const pid = r.portfolio_id as string;
          if (!(pid in lastRunAt) || lastRunAt[pid] === null || (r.created_at as string) > (lastRunAt[pid] as string)) {
            lastRunAt[pid] = r.created_at as string;
          }
        }
      }
    } catch (e) {
      srvLog.warn("hourly-run: post-run last-decision lookup failed", e);
    }
    const portfolioStatus = buildPortfolioRunStatuses({
      portfolios: (allPortfolios ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        mode: String(p.mode),
        live_paused: p.live_paused,
      })),
      requestedIds: opts.portfolioIds,
      results,
      previousRunAt,
      lastRunAt,
    });

    const metricsSnap = snapshot(metrics);

    const telemetry = tel.finish({
      portfolios_total: portfolios.length,
      skipped_paused: skippedPaused,
      news_headlines: newsCount,
      prices_refreshed: priceRefresh.refreshed,
      price_errors: priceRefresh.errors,
    });
    try {
      await supabaseAdmin.from("run_metrics").insert({
        triggered_by: manualTrigger ? "manual" : "cron",
        success: true,
        duration_ms: metricsSnap.duration_ms,
        // Pre-flight timings feed the slow-step anomaly detector.
        preflight_ms: telemetry.preflight_ms,
        preflight_budget_pct: telemetry.preflight_budget_pct,
        budget_ms: telemetry.budget_ms,
        phases: telemetry.phases,
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
      srvLog.error("hourly-run: failed to persist run_metrics", e);
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
      portfolio_status: portfolioStatus,

      metrics: metricsSnap,
      telemetry,
    };
  } catch (err) {
    tel.failed(err);
    throw err;
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
}
