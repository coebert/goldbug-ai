// Routes AI-executed orders to the Saxo broker adapter for live_sim / live_prod
// portfolios. Idempotent via a deterministic client_order_id keyed on
// (portfolio_id, trade_date, symbol, side). Never called for paper mode.
//
// This runs AFTER the simulator has already updated local holdings/cash, so
// the local state is a best-effort mirror and the nightly reconciliation cron
// squares it against actual broker positions.

import type { BrokerOrderResult } from "@/lib/brokers/adapter";
import { asJson } from "@/lib/_server/db-json";
import { createHash } from "node:crypto";
import { assessTradeViability, modelledFillFee } from "@/lib/trade-viability-gate";
import { resolveFillRecord } from "@/lib/fill-record";
import { planMarketableLimit } from "@/lib/marketable-limit";
import { placeProtectiveStopAfterBuyFill } from "@/lib/protective-stop-placement.server";
import { shouldRetrySellAsMarket } from "@/lib/broker-sell-recovery";
import { findStaleWorkingSell } from "@/lib/stale-sell-order";


export interface ExecutedOrderLike {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason?: string;
  rejected?: string;
  /**
   * Phase B: currency the price is quoted in (e.g. "USD" for AAPL). When
   * omitted the executor resolves it from `saxo_instrument_cache` for
   * fx_enabled portfolios, and falls back to the portfolio base currency.
   */
  instrument_ccy?: string;
  /** Conviction in [0,1] from the unified systematic score, when known. */
  conviction?: number;
  /** Resolved sector for concentration budgeting, when known. */
  sector?: string;
}



export interface RouteResult {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
  brokerOrderId?: string;
  reason?: string;
  skipped?: string;
}

/**
 * Submit each executed order to the Saxo broker.
 * @param portfolio  the portfolio row (mode must be live_sim or live_prod)
 * @param userId     owner user id (for broker log + RLS-safe inserts)
 * @param asOf       ISO date string used in the client_order_id
 * @param decisionId decisions.id row this batch belongs to (nullable)
 * @param executed   executed[] array from trading-engine
 */
export async function routeOrdersToBroker(params: {
  portfolio: {
    id: string;
    mode: string;
    live_paused?: boolean | null;
    broker?: string | null;
    broker_account_id?: string | null;
  };
  userId: string;
  asOf: string;
  decisionId: string | null;
  executed: ExecutedOrderLike[];
  /**
   * Phase B — optional algo-regime snapshot. When
   * `multipliers.blockNewBuys` is true every BUY in `executed` is
   * pre-skipped (SELLs still route) and the block is logged to
   * live_broker_log with method `PRE_PLACE_ALGO_REGIME_BLOCK`. Omit for
   * the legacy path.
   */
  algoRegime?: import("./microstructure/algo-regime").AlgoRegimeSnapshot | null;
}): Promise<RouteResult[]> {
  const { portfolio, userId, asOf, decisionId, executed, algoRegime } = params;
  const results: RouteResult[] = [];

  // Post-broker reconciliation state. Populated by the buys branch so the
  // reconciler at the end of routing can verify each buy landed with the
  // FX legs the trimmer planned. Empty for sells-only / non-fx runs.
  const reconPlannedLegs: import("./post-broker-reconciliation").PlannedFxLegLite[] = [];
  const reconFxOutcomes: import("./post-broker-reconciliation").FxLegOutcome[] = [];

  if (portfolio.mode !== "live_sim" && portfolio.mode !== "live_prod") return results;
  if (portfolio.live_paused) return results;

  // Global kill-switch: when LIVE_SIM_PAPER_ONLY is truthy, live_sim portfolios
  // stay fully paper-traded and never touch the broker adapter, regardless of
  // how they're marked. live_prod is unaffected.
  const paperOnlyFlag = (process.env.LIVE_SIM_PAPER_ONLY ?? "").toLowerCase();
  const paperOnly = paperOnlyFlag === "1" || paperOnlyFlag === "true" || paperOnlyFlag === "yes";
  if (paperOnly && portfolio.mode === "live_sim") {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: "sim",
        method: "ROUTE_SKIPPED_PAPER_ONLY",
        path: "/route/paper-only",
        status: 0,
        request: asJson({ asOf, decisionId, count: executed.length }),
        response: null,
        error: "LIVE_SIM_PAPER_ONLY env flag active",
      });
    } catch {
      // best-effort log only
    }
    return results;
  }

  // Which broker account does THIS portfolio trade? Orders must never be sent
  // to a default/shared account — that is what made two sim portfolios mirror
  // one another. Fields may be absent on the caller's row, so re-read them.
  const { resolvePortfolioBrokerLink } = await import(
    "@/lib/brokers/portfolio-broker-link.server"
  );
  let brokerRow: { broker?: string | null; broker_account_id?: string | null } = portfolio;
  if (portfolio.broker === undefined || portfolio.broker_account_id === undefined) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("portfolios")
      .select("broker, broker_account_id")
      .eq("id", portfolio.id)
      .maybeSingle();
    brokerRow = data ?? {};
  }
  const brokerLink = resolvePortfolioBrokerLink(brokerRow);
  if (!brokerLink.linked) {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "ROUTE_SKIPPED_NO_BROKER_ACCOUNT",
        path: "/route/no-broker-account",
        status: 0,
        request: asJson({ asOf, decisionId, count: executed.length }),
        response: null,
        error: brokerLink.reason,
      });
    } catch {
      /* best-effort log only */
    }
    return executed.map((e) => ({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      status: "skipped",
      skipped: brokerLink.reason,
    }));
  }

  // Hard safety gate (independent of strategy logic): admin kill switch plus a
  // per-day BUY notional ceiling. Fails closed — see trading-controls.server.
  const { loadTradingGate } = await import("./trading-controls.server");
  // A practice book scales the day's buy ceiling to its own NAV; the
  // real-money figure the operator set stays exactly as configured.
  const gateNavBase = await (async (): Promise<number | null> => {
    if (portfolio.mode === "live_prod") return null;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data } = await supabaseAdmin
        .from("equity_snapshots")
        .select("total_value")
        .eq("portfolio_id", portfolio.id)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nav = Number((data as { total_value?: number | null } | null)?.total_value);
      return Number.isFinite(nav) && nav > 0 ? nav : null;
    } catch {
      return null;
    }
  })();
  const gate = await loadTradingGate({ mode: portfolio.mode, navBase: gateNavBase });

  let routable = executed.filter(
    (e) => !e.rejected && e.quantity > 0 && Number.isFinite(e.quantity) && Number.isFinite(e.price),
  );
  if (routable.length === 0) return results;

  // ---------- Intent-level ticket aggregation.
  // One idea must cost one commission. Collapse same-symbol/same-side tickets
  // into a single order and net opposing intents in the same name before any
  // gate or the broker sees them (evidence: MKS.L bought 9 times, VMID.L 5
  // times, for one position each).
  {
    const { aggregateOrders } = await import("./order-aggregation");
    const agg = aggregateOrders(routable);
    if (agg.ticketsSaved > 0) {
      routable = agg.orders;
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_TICKET_AGGREGATION",
          path: "/reconcile/pre-place/aggregate",
          status: 200,
          request: asJson({ asOf, decisionId, before: executed.length }),
          response: asJson({ after: routable.length, ticketsSaved: agg.ticketsSaved, notes: agg.notes }),
          error: null,
        });
      } catch {
        /* best-effort log only */
      }
    } else {
      routable = agg.orders;
    }
    if (routable.length === 0) return results;
  }


  const logGuard = async (method: string, detail: Record<string, unknown>, error: string) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method,
        path: "/route/trading-controls",
        status: 0,
        request: asJson({ asOf, decisionId, ...detail }),
        response: null,
        error,
      });
    } catch {
      /* best-effort log only */
    }
  };

  if (!gate.enabled) {
    // A controls-row read failure fails closed for BUYs only. Stranding exits
    // behind an infrastructure hiccup is how a losing position bleeds out, so
    // SELLs keep routing unless an operator explicitly halted trading.
    const sellsOnly = gate.sellsEnabled ? routable.filter((e) => e.side === "sell") : [];
    await logGuard(
      "ROUTE_SKIPPED_KILL_SWITCH",
      {
        count: routable.length - sellsOnly.length,
        sellsStillRouting: sellsOnly.length,
        haltReason: gate.haltReason,
      },
      gate.haltReason ?? "trading_controls.trading_enabled = false",
    );
    if (sellsOnly.length === 0) return results;
    routable = sellsOnly;
  }

  // Daily ceiling: SELLs always route (they reduce risk); BUYs are admitted in
  // order until the remaining daily budget is exhausted.
  // Unspent daily BUY notional, shared with the placement loop below.
  let dailyBuyHeadroom = 0;
  let budget = gate.remaining;
  const admitted: ExecutedOrderLike[] = [];
  const capped: { symbol: string; notional: number }[] = [];
  // The owner-set core top-up gets first call on the day's BUY budget: it is
  // an allocation instruction, so it must never lose its slot to short-term
  // ideas queued ahead of it. The money ceiling itself still binds.
  const coreKeyForOrder = await (async () => {
    try {
      const { loadCoreAllocationSettings } = await import("./trading-controls.server");
      const { engineSymbolKey } = await import("./price-symbol");
      const c = await loadCoreAllocationSettings();
      return c.targetPct > 0 ? engineSymbolKey(c.symbol) : null;
    } catch {
      return null;
    }
  })();
  const orderedForDailyCap = coreKeyForOrder
    ? await (async () => {
        const { engineSymbolKey } = await import("./price-symbol");
        const isCoreOrder = (e: ExecutedOrderLike) =>
          e.side === "buy" && engineSymbolKey(e.symbol) === coreKeyForOrder;
        return [...routable.filter(isCoreOrder), ...routable.filter((e) => !isCoreOrder(e))];
      })()
    : routable;
  const { engineSymbolKey: dailyCapKeyOf } = await import("./price-symbol");
  for (const e of orderedForDailyCap) {
    if (e.side !== "buy") {
      admitted.push(e);
      continue;
    }
    const notional = e.quantity * e.price;
    // The owner-set core is an allocation instruction sized by its own
    // target + drift cap and the cash reserve. Building it in one large
    // ticket costs one dealing fee instead of many, so the day's ticket
    // budget must not chop it into pieces.
    const isCoreBuy = coreKeyForOrder != null && dailyCapKeyOf(e.symbol) === coreKeyForOrder;
    if (notional > budget && !isCoreBuy) {
      // Dropping the whole idea because it is bigger than the day's leftover
      // money threw away good signals outright (a £25k sim ticket against a
      // £10k ceiling routed nothing at all). Trim it to the headroom instead,
      // provided a whole-share ticket of at least the minimum worthwhile size
      // still fits. The ceiling itself is never exceeded.
      const trimmedQty = e.price > 0 ? Math.floor(budget / e.price) : 0;
      const trimmedNotional = trimmedQty * e.price;
      if (trimmedQty >= 1 && trimmedNotional >= DAILY_CAP_TRIM_MIN_TICKET_BASE) {
        budget -= trimmedNotional;
        admitted.push({ ...e, quantity: trimmedQty });
        trimmed.push({ symbol: e.symbol, from: notional, to: trimmedNotional });
        continue;
      }
      capped.push({ symbol: e.symbol, notional });
      continue;
    }
    budget -= notional;
    admitted.push(e);
  }
  if (trimmed.length > 0) {
    await logGuard(
      "ROUTE_TRIMMED_TO_DAILY_NOTIONAL_CAP",
      { trimmed, dailyLimit: gate.dailyLimit, spentToday: gate.spentToday, remaining: gate.remaining },
      `Buy trimmed to the day's remaining budget instead of being skipped ` +
        `(limit ${gate.dailyLimit}, spent ${gate.spentToday.toFixed(2)})`,
    );
  }
  budget = Math.max(0, budget);
  if (capped.length > 0) {
    await logGuard(
      "ROUTE_SKIPPED_DAILY_NOTIONAL_CAP",
      {
        capped,
        dailyLimit: gate.dailyLimit,
        spentToday: gate.spentToday,
        remaining: gate.remaining,
      },
      `Daily BUY notional cap reached (limit ${gate.dailyLimit}, spent ${gate.spentToday.toFixed(2)})`,
    );
  }
  routable = admitted;
  // Whatever daily BUY notional survives the admission loop is the only extra
  // spend later size-ups may use. Without this, a £200 ticket enlarged to £800
  // would route £600 the daily ceiling never sanctioned.
  dailyBuyHeadroom = Math.max(0, budget);
  if (routable.length === 0) return results;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let adapter: import("@/lib/brokers/saxo.server").SaxoAdapter;
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    adapter = await buildSaxoAdapter({
      userId,
      portfolioId: portfolio.id,
      envOverride: portfolio.mode === "live_prod" ? "live" : "sim",
      accountKey: brokerLink.accountKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Adapter unavailable (missing SAXO_ACCESS_TOKEN etc.). Record once and bail.
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "ROUTE_SKIPPED",
      path: "/route/adapter-unavailable",
      status: 503,
      request: asJson({ asOf, count: routable.length }),
      response: null,
      error: msg,
    });
    return routable.map((e) => ({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      status: "skipped",
      skipped: msg,
    }));
  }

  // Fetch broker account currency + available cash once per batch. We use
  // currency to record the FX rate the AI sized against, and cash to gate the
  // pre-placement reconciliation below. Non-blocking: on failure we fall
  // through with rate=1 stale and skip the affordability trim.
  let accountCurrency: string | null = null;
  let brokerCashAvailable: number | null = null;
  try {
    const bal = await adapter.getBalance();
    accountCurrency = bal.currency;
    const rawCash = Number(bal.cashAvailable ?? bal.cash);
    brokerCashAvailable = Number.isFinite(rawCash) ? rawCash : null;
  } catch {
    /* best-effort */
  }
  const pfRow = await supabaseAdmin
    .from("portfolios")
    .select("currency, fx_enabled, cash_by_ccy, fx_execution_mode, current_cash")
    .eq("id", portfolio.id)
    .maybeSingle();
  const pfRowData = pfRow.data as
    | { currency?: string; fx_enabled?: boolean; cash_by_ccy?: Record<string, number> | null; fx_execution_mode?: string; current_cash?: number }
    | null;
  const portfolioCurrency = pfRowData?.currency?.toUpperCase() ?? "GBP";
  const fxEnabled = pfRowData?.fx_enabled === true;
  // Default to "spot" so every planned FX leg is placed at the broker
  // before the dependent buy is submitted. Only the explicit
  // fx_execution_mode='synthetic' opt-out keeps the wallet-only path.
  const fxExecutionMode: "synthetic" | "spot" =
    pfRowData?.fx_execution_mode === "synthetic" ? "synthetic" : "spot";



  let fxRate = 1;
  let fxStale = false;
  let fxSource = "identity";
  if (accountCurrency && accountCurrency.toUpperCase() !== portfolioCurrency) {
    const { getFxRate } = await import("@/lib/fx.server");
    const fx = await getFxRate(portfolioCurrency, accountCurrency);
    fxRate = fx.rate;
    fxStale = fx.stale;
    fxSource = fx.source;
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "FX_CAPTURE",
      path: `/fx/${portfolioCurrency}->${accountCurrency}`,
      status: fxStale ? 206 : 200,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson({ rate: fxRate, source: fxSource, stale: fxStale }),
      error: fxStale ? "fx rate stale or fallback" : null,
    });
    // Fire an out-of-UI alert when the FX providers are actually down
    // (rate=1 identity fallback) so the operator hears about it even if
    // they don't have the portfolio page open.
    try {
      const { maybeNotifyFxUnhealthy } = await import("./fx-health-notify.server");
      maybeNotifyFxUnhealthy({
        portfolioId: portfolio.id,
        userId,
        pair: `${portfolioCurrency}->${accountCurrency}`,
        rate: fxRate,
        source: fxSource,
        stale: fxStale,
      });
    } catch {
      // never let a notifier crash the tick
    }

  }

  // ---------- Pre-placement cash reconciliation.
  // Refresh the local `current_cash` from the broker one more time immediately
  // before we start placing orders — top-of-tick sync ran minutes ago and
  // external deposits, withdrawals, or in-flight fills may have moved the
  // real number. Then trim any buys whose combined broker-currency notional
  // exceeds what the broker actually has available, so we never hand Saxo an
  // order that will come straight back as InsufficientCash.
  const preSkips = new Map<string, string>(); // clientOrderId key by symbol+side
  // Room left under each name's position cap AFTER its admitted ticket. Any
  // later enlargement of a ticket (fee-viable size-up) must fit inside it.
  const capRoomBySymbol = new Map<string, number>();

  // ---------- Phase B: algo-regime block-new-buys guardrail.
  // When the caller supplied a snapshot whose multipliers recommend
  // blocking new market buys, pre-skip every BUY in `routable` before we
  // touch the broker. SELLs (protective exits) still route. Idempotent
  // and logged for audit.
  if (algoRegime?.multipliers.blockNewBuys) {
    const reason = `algo_regime_${algoRegime.tier}:${algoRegime.reason}`;
    let blocked = 0;
    for (const o of routable) {
      if (o.side === "buy") {
        preSkips.set(`${o.symbol}:${o.side}`, reason);
        blocked += 1;
      }
    }
    if (blocked > 0) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "PRE_PLACE_ALGO_REGIME_BLOCK",
        path: "/reconcile/pre-place/algo-regime",
        status: 200,
        request: asJson({
          asOf, decisionId,
          tier: algoRegime.tier,
          score: algoRegime.score,
          maxParticipation: algoRegime.multipliers.maxParticipation,
        }),
        response: asJson({ blocked, totalRoutable: routable.length }),
        error: reason,
      });
    }
  }

  // ---------- Portfolio cost governor + sector concentration budget.
  // The per-ticket viability gate is memoryless: fifty individually "viable"
  // small tickets still burn a fortnight's returns in commission floors and
  // stamp duty. This pass adds portfolio memory — a NAV-scaled minimum ticket,
  // a rolling friction budget as a % of NAV, a daily BUY-ticket cap and a
  // per-symbol re-entry cooldown — plus a per-sector share-of-NAV cap.
  // SELLs are never gated by either.
  //
  // Fail-CLOSED for buys: this used to swallow its own errors and route the
  // full unfiltered basket, which is precisely the state that produced the
  // cost bleed. If we cannot prove a buy is affordable, we do not send it.
  try {
    const { loadGovernorInputs } = await import("./cost-governor.server");
    const { planAdmissions, governorForNav } = await import("./cost-governor");
    const { planSectorAdmissions, DEFAULT_SECTOR_BUDGET } = await import("./sector-concentration");
    const { resolveChurnPolicy } = await import("./churn-policy");
    const { estimateTradeCosts, attractsStampDuty } = await import("./trade-viability-gate");
    const { isDiversifiedFund } = await import("./diversified-fund");
    const { companyName: symbolDisplayName } = await import("./symbol-names");
    const { convertAmount } = await import("./fx.server");
    const { inferSaxoCurrency } = await import("./saxo-fees");
    const { symbolSector } = await import("./sector-rotation.server");

    const inputs = await loadGovernorInputs({
      supabaseAdmin: supabaseAdmin as never,
      portfolioId: portfolio.id,
      baseCcy: portfolioCurrency,
    });

    if (!(inputs.navBase > 0)) {
      throw new Error("governor has no NAV to size against");
    }

    // Style-vs-cost cooldown reconciliation: whichever rests the name longer
    // wins, so a swing style can never re-enter inside the commission floor.
    const styleReentryMinDays = (() => {
      const raw = (portfolio as { risk_config?: unknown }).risk_config;
      const v = (raw as { reentry_min_days?: unknown } | null)?.reentry_min_days;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const navProfile = governorForNav(inputs.navBase);
    const churn = resolveChurnPolicy({
      styleReentryMinDays,
      governorCooldownDays: navProfile.addCooldownDays,
      style: (portfolio as { risk_config?: { trading_style?: string } }).risk_config?.trading_style ?? null,
    });

    const fxCache = new Map<string, number>([[portfolioCurrency, 1]]);
    const rateTo = async (ccy: string) => {
      const from = ccy.toUpperCase();
      const hit = fxCache.get(from);
      if (hit !== undefined) return hit;
      let r = 1;
      try {
        const res = await convertAmount(1, from, portfolioCurrency);
        if (Number.isFinite(res.amount) && res.amount > 0) r = res.amount;
      } catch {
        r = 1;
      }
      fxCache.set(from, r);
      return r;
    };

    // ---------- Cross-run batching window.
    // A buy under the minimum economic ticket is parked rather than thrown
    // away; later signals in the same name top it up until one full-size
    // ticket can be sent. Sells bypass the window entirely.
    {
      const [{ applyBatchWindow }, { minTicketBase }] = await Promise.all([
        import("./order-batching.server"),
        import("./cost-governor"),
      ]);
      const minTicket = minTicketBase({
        navBase: inputs.navBase,
        minTicketPctOfNav: navProfile.minTicketPctOfNav,
        absoluteMinTicketBase: navProfile.absoluteMinTicketBase,
      });
      const notionalOf = async (o: (typeof routable)[number]) => {
        const ccy = o.instrument_ccy?.toUpperCase() ?? inferSaxoCurrency(o.symbol);
        return Math.floor(o.quantity) * o.price * (await rateTo(ccy));
      };
      const notionals = new Map<string, number>();
      for (const o of routable) notionals.set(`${o.symbol}:${o.side}`, await notionalOf(o));

      const batch = await applyBatchWindow({
        db: supabaseAdmin as unknown as { from: (t: string) => unknown },
        portfolioId: portfolio.id,
        userId,
        orders: routable,
        notionalBase: (o) => notionals.get(`${o.symbol}:${o.side}`) ?? 0,
        minTicketBase: minTicket,
      });
      if (batch.parked.length > 0 || batch.dropped.length > 0 || batch.releasedWithParked > 0) {
        try {
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "PRE_PLACE_BATCH_WINDOW",
            path: "/reconcile/pre-place/batch-window",
            status: 200,
            request: asJson({ asOf, decisionId, minTicket, before: routable.length }),
            response: asJson({
              after: batch.orders.length,
              parked: batch.parked,
              dropped: batch.dropped,
              releasedWithParked: batch.releasedWithParked,
            }),
            error: null,
          });
        } catch {
          /* best-effort log only */
        }
      }
      routable = batch.orders;
      if (routable.length === 0) return results;
    }

    // Stamp-exempt preference (user setting): prefer ETFs/ETCs and non-UK
    // listings over UK single stocks when signal strength is comparable, since
    // the exempt instrument needs ~50bps less to break even.
    const stampExemptPreference = (() => {
      const raw = (portfolio as { risk_config?: { stamp_exempt_preference?: unknown } }).risk_config;
      const v = raw?.stamp_exempt_preference;
      return v === "off" || v === "balanced" || v === "strong" ? v : "balanced";
    })();

    const { expectedMovePct } = await import("./net-edge-gate");

    const candidates: Array<{
      symbol: string;
      side: "buy" | "sell";
      notionalBase: number;
      estCostBase: number;
      isAdd?: boolean;
      edgeScore?: number;
      expectedMovePct?: number;
      stampLiable?: boolean;
      diversifiedFund?: boolean;
    }> = [];
    const notionalBySymbol = new Map<string, number>();
    for (const o of routable) {
      if (preSkips.has(`${o.symbol}:${o.side}`)) continue;
      const qty = Math.floor(o.quantity);
      if (qty <= 0) continue;
      const ccy = o.instrument_ccy?.toUpperCase() ?? inferSaxoCurrency(o.symbol);
      const fx = await rateTo(ccy);
      const side = o.side === "sell" ? "sell" : "buy";
      const costs = estimateTradeCosts({ symbol: o.symbol, side, quantity: qty, price: o.price });
      const notionalBase = qty * o.price * fx;
      notionalBySymbol.set(`${o.symbol}:${side}`, notionalBase);
      candidates.push({
        symbol: o.symbol,
        side,
        notionalBase,
        estCostBase: costs.oneWayCost * fx,
        isAdd: inputs.heldSymbols.has(o.symbol.toUpperCase()),
        edgeScore: Number.isFinite(o.conviction) ? Number(o.conviction) : undefined,
        // Rank on the move this idea can realistically make (ATR- and
        // conviction-scaled) rather than a flat 2% assumption, so the governor
        // spends the day's cost budget where the edge outruns the friction.
        expectedMovePct: expectedMovePct({
          atrPct: (o as { atr_pct?: number | null }).atr_pct ?? null,
          conviction: Number.isFinite(o.conviction) ? Number(o.conviction) : null,
        }),
        stampLiable:
          side === "buy" &&
          attractsStampDuty(
            o.symbol,
            (o as { asset_class?: string | null }).asset_class ?? null,
          ),
        // Broad index funds are not single-name risk, so they sit under the
        // wider concentration cap.
        diversifiedFund: isDiversifiedFund({
          symbol: o.symbol,
          assetClass: (o as { asset_class?: string | null }).asset_class ?? null,
          name: (o as { name?: string | null }).name ?? symbolDisplayName(o.symbol),
        }),
      });
    }


    // How much of the book is actually at work. A cash-heavy book is not
    // over-trading, so the daily ticket cap lifts while the friction budget
    // keeps pricing the cost of each extra trade.
    const investedBase = Object.values(inputs.positionExposureBase ?? {}).reduce(
      (s, v) => s + (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0),
      0,
    );
    const investedFraction = inputs.navBase > 0 ? investedBase / inputs.navBase : undefined;

    // The owner-set core holding is a deliberate baseline, not a single-name
    // bet, so it sits under its own cap (target + drift band).
    const coreCaps = await (async () => {
      try {
        const { loadCoreAllocationSettings } = await import("./trading-controls.server");
        const c = await loadCoreAllocationSettings();
        if (!(c.targetPct > 0)) return {};
        return {
          coreSymbolKey: c.symbol,
          coreCapPctOfNav: Math.min(0.95, c.targetPct + Math.max(0, c.bandPct)),
        };
      } catch {
        return {};
      }
    })();

    const plan = planAdmissions(candidates, {
      navBase: inputs.navBase,
      ...coreCaps,
      buysAlreadyToday: inputs.buysAlreadyToday,
      investedFraction,
      trailingCostBase: inputs.trailingCostBase,
      lastBuyDaysAgo: inputs.lastBuyDaysAgo,
      daysSinceLastBuyFill: inputs.daysSinceLastBuyFill,
      recentBuyFills: inputs.recentBuyFills,
      churnWindowDays: inputs.churnWindowDays,
      tapeVolZ: inputs.tapeVolZ,
      positionExposureBase: inputs.positionExposureBase,
      ...navProfile,
      addCooldownDays: churn.cooldownDays,
      stampExemptPreference,
    });


    const blocked: Array<{ symbol: string; reason: string }> = [];
    for (const d of plan.decisions) {
      if (d.kind === "skip") {
        preSkips.set(`${d.candidate.symbol}:${d.candidate.side}`, d.reason);
        blocked.push({ symbol: d.candidate.symbol, reason: d.reason });
      } else if (d.candidate.side === "buy" && Number.isFinite(d.capRoomBase as number)) {
        capRoomBySymbol.set(d.candidate.symbol.toUpperCase(), Math.max(0, Number(d.capRoomBase)));
      }
    }

    // Sector budget runs on what survived the cost governor, so concentration
    // is measured on the trades we would actually send.
    const sectorCandidates = plan.decisions
      .filter((d) => d.kind === "admit" && d.candidate.side === "buy")
      .map((d) => {
        const c = (
          d as {
            candidate: {
              symbol: string;
              notionalBase: number;
              edgeScore?: number;
              expectedMovePct?: number;
              estCostBase?: number;
            };
          }
        ).candidate;
        const held = routable.find((o) => o.symbol === c.symbol && o.side === "buy");
        const meta = held as { sector?: string | null; assetClass?: string | null; name?: string | null } | undefined;
        return {
          symbol: c.symbol,
          sector: held?.sector ?? symbolSector(c.symbol),
          notionalBase: c.notionalBase,
          // Lets an exceptionally strong, cost-clearing idea stretch the
          // sector cap instead of being turned away.
          edgeScore: c.edgeScore,
          expectedMovePct: c.expectedMovePct,
          estCostBase: c.estCostBase,
          // Broad global/market trackers span every sector; the per-name
          // position cap governs them, not the sector budget.
          diversified: isDiversifiedFund({
            symbol: c.symbol,
            assetClass: meta?.assetClass ?? null,
            name: meta?.name ?? symbolDisplayName(c.symbol) ?? null,
          }),
        };
      });
    // The owner-set core holding is a deliberate baseline governed by its own
    // target + drift cap, so the sector budget must never block it.
    if (coreCaps.coreSymbolKey) {
      const { engineSymbolKey: coreKeyOf } = await import("./price-symbol");
      const coreKey = coreKeyOf(coreCaps.coreSymbolKey);
      for (const c of sectorCandidates) {
        if (coreKeyOf(c.symbol) === coreKey) c.diversified = true;
      }
    }
    const sectorPlan = planSectorAdmissions(sectorCandidates, inputs.sectorExposureBase, {
      navBase: inputs.navBase,
      ...DEFAULT_SECTOR_BUDGET,
    });
    for (const d of sectorPlan.decisions) {
      if (d.kind === "skip") {
        preSkips.set(`${d.candidate.symbol}:buy`, d.reason);
        blocked.push({ symbol: d.candidate.symbol, reason: d.reason });
      }
    }

    if (blocked.length > 0) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "PRE_PLACE_COST_GOVERNOR",
        path: "/reconcile/pre-place/cost-governor",
        status: 200,
        request: asJson({
          asOf,
          decisionId,
          navBase: inputs.navBase,
          trailingCostBase: inputs.trailingCostBase,
          windowDays: inputs.windowDays,
          buysAlreadyToday: inputs.buysAlreadyToday,
          minTicketBase: plan.minTicketBase,
          cooldownDays: churn.cooldownDays,
          cooldownBoundBy: churn.boundBy,
        }),
        response: asJson({
          blocked,
          budgetRemaining: plan.costBudgetRemainingBase,
          sectorExposureAfter: sectorPlan.exposureAfter,
        }),
        error: `cost governor blocked ${blocked.length} buy(s)`,
      });
    }
  } catch (err) {
    // Fail closed: block every BUY this tick, let SELLs through.
    const reason = `cost governor unavailable — buys suppressed (${err instanceof Error ? err.message : String(err)})`;
    for (const o of routable) {
      if (o.side !== "sell") preSkips.set(`${o.symbol}:${o.side}`, reason);
    }
    try {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "PRE_PLACE_COST_GOVERNOR",
        path: "/reconcile/pre-place/cost-governor",
        status: 500,
        request: asJson({ asOf, decisionId }),
        response: asJson({ failClosed: true }),
        error: reason,
      });
    } catch {
      /* logging must not mask the fail-closed behaviour */
    }
  }




  try {
    const { syncLiveCashFromBroker } = await import("./live-cash-sync.server");
    const { withOwnedClient } = await import("./_server/owned-client");
    const preSync = await syncLiveCashFromBroker(portfolio.id, withOwnedClient(userId));
    // If the drift-update ran, capture the fresh broker spendable cash so the
    // affordability check below does not use ledger cash reserved by Saxo.
    if (!preSync.skipped && Number.isFinite(preSync.brokerCash)) {
      brokerCashAvailable = preSync.brokerSpendableCash != null
        ? Number(preSync.brokerSpendableCash)
        : Number(preSync.brokerCash);
    }
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_RECONCILE",
      path: "/reconcile/pre-place",
      status: preSync.skipped ? 206 : 200,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson(preSync),
      error: preSync.skipped ? preSync.reason : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_RECONCILE",
      path: "/reconcile/pre-place",
      status: 500,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: null,
      error: msg,
    });
  }

  // ---------- Broker SpendingPower reconciliation.
  // The CASH_SYNC step above writes `portfolios.current_cash` from
  // `cashAvailable ?? cash`, which in Saxo's `getBalance()` collapses to the
  // MAX of {settled, settled+notBooked, SpendingPower, CashAvailableForTrading}.
  // That's the right figure for equity/NAV tiles, but it's optimistic for
  // pre-trade gating: SpendingPower can be strictly lower than cash once
  // per-sub-account ring-fencing, margin haircuts, or unbooked in-flight
  // fills are applied — and it's SpendingPower that Saxo enforces at precheck
  // and POST /orders. Re-read the balance fresh here (separate from the
  // NAV-oriented sync above), then constrain `brokerCashAvailable` to the
  // MIN of {SpendingPower, CashAvailableForTrading, local current_cash} so
  // every downstream affordability trim and precheck uses the authoritative
  // spendable number. Non-blocking on failure.
  try {
    const bal2 = await adapter.getBalance();
    const rawSp = Number((bal2 as { spendingPower?: number }).spendingPower ?? NaN);
    const rawAvail = Number(bal2.cashAvailable ?? NaN);
    const localCash = Number((pfRowData as { current_cash?: number } | null)?.current_cash ?? NaN);
    const candidates: Array<{ label: string; value: number }> = [];
    if (Number.isFinite(rawSp)) candidates.push({ label: "spendingPower", value: rawSp });
    if (Number.isFinite(rawAvail)) candidates.push({ label: "cashAvailable", value: rawAvail });
    if (Number.isFinite(localCash)) candidates.push({ label: "localCash", value: localCash });
    if (candidates.length > 0) {
      const reconciled = candidates.reduce((m, c) => (c.value < m.value ? c : m));
      const before = brokerCashAvailable;
      brokerCashAvailable = Math.max(0, reconciled.value);
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "PRE_PLACE_SPENDING_POWER_RECON",
        path: "/reconcile/pre-place/spending-power",
        status: 200,
        request: asJson({ asOf, decisionId, brokerCashBefore: before }),
        response: asJson({
          spendingPower: Number.isFinite(rawSp) ? rawSp : null,
          cashAvailable: Number.isFinite(rawAvail) ? rawAvail : null,
          localCash: Number.isFinite(localCash) ? localCash : null,
          reconciledSource: reconciled.label,
          reconciledSpendable: brokerCashAvailable,
          currency: bal2.currency,
        }),
        error: null,
      });
    }
  } catch (e) {
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_SPENDING_POWER_RECON",
      path: "/reconcile/pre-place/spending-power",
      status: 502,
      request: asJson({ asOf, decisionId }),
      response: null,
      error: e instanceof Error ? e.message : String(e),
    });
  }


  // ---------- Subtract cash reserved by open working buy orders.
  // Saxo's `SpendingPower` / `CashAvailableForTrading` does NOT deduct the
  // notional of open working orders, so a buy that "fits" against
  // brokerCashAvailable can still be rejected at precheck with
  // InsufficientCash when prior day-old GTC orders are queued. Pull the
  // working-order book once per batch and reduce our headroom accordingly so
  // the affordability trim skips buys before we ever hit precheck.
  const reservedByCcy: Record<string, number> = {};
  let reservedTotalAcctCcy = 0;
  try {
    if (typeof adapter.listWorkingOrders === "function") {
      const working = await adapter.listWorkingOrders();
      for (const wo of working) {
        if (wo.buySell !== "Buy") continue;
        const remaining = Math.max(0, Number(wo.amount ?? 0) - Number(wo.filledAmount ?? 0));
        const px = Number(wo.price ?? 0);
        if (!(remaining > 0) || !(px > 0)) continue;
        const notional = remaining * px;
        const ccy = (wo.currency ?? accountCurrency ?? portfolioCurrency).toUpperCase();
        reservedByCcy[ccy] = (reservedByCcy[ccy] ?? 0) + notional;
        // Rough conversion into account currency for the scalar cash gate.
        // If we don't know a rate here, treat notional as already in account
        // ccy — under-estimation is safer than ignoring the reservation.
        reservedTotalAcctCcy += notional;
      }
      if (reservedTotalAcctCcy > 0) {
        const before = brokerCashAvailable;
        if (brokerCashAvailable != null) {
          brokerCashAvailable = Math.max(0, brokerCashAvailable - reservedTotalAcctCcy);
        }
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_OPEN_ORDER_RESERVATION",
          path: "/port/v1/orders/me",
          status: 200,
          request: asJson({ asOf, decisionId, count: working.length }),
          response: asJson({
            reservedByCcy,
            reservedTotalAcctCcy,
            brokerCashBefore: before,
            brokerCashAfter: brokerCashAvailable,
          }),
          error: null,
        });
      }
    }
  } catch (err) {
    // Non-blocking: if we can't read working orders we fall through with the
    // raw broker cash number and rely on precheck to catch overspends.
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_OPEN_ORDER_RESERVATION",
      path: "/port/v1/orders/me",
      status: 502,
      request: asJson({ asOf, decisionId }),
      response: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---------- Cross-currency guard when FX routing is disabled.
  // When `fx_enabled=false`, the executor has no way to route a USD/GBP buy
  // against an EUR wallet (or any other base-vs-instrument mismatch): the
  // multi-ccy trimmer only runs in the `fxEnabled` branch, and the single-
  // currency fallback debits the base wallet in the base currency. Sending
  // such orders to Saxo just triggers InsufficientCash rejects — which then
  // trip the 24h learned-cash lockout below and block ALL subsequent buys,
  // including valid same-currency ones. Skip cross-currency buys here so
  // Saxo is never asked and the lockout stays quiet. Sells are unaffected;
  // they only free cash.
  if (!fxEnabled) {
    const mismatched: Array<{ symbol: string; instCcy: string }> = [];
    const needCcyLookup = Array.from(
      new Set(
        routable
          .filter((o) => o.side === "buy" && !o.instrument_ccy)
          .map((o) => o.symbol),
      ),
    );
    const ccyBySymbol = new Map<string, string>();
    for (const o of routable) {
      if (o.instrument_ccy) ccyBySymbol.set(o.symbol, o.instrument_ccy.toUpperCase());
    }
    if (needCcyLookup.length > 0) {
      const cache = await supabaseAdmin
        .from("saxo_instrument_cache")
        .select("symbol, currency")
        .in("symbol", needCcyLookup);
      for (const row of cache.data ?? []) {
        if (row.currency) ccyBySymbol.set(row.symbol as string, String(row.currency).toUpperCase());
      }
    }
    for (const o of routable) {
      if (o.side !== "buy") continue;
      const instCcy = ccyBySymbol.get(o.symbol);
      if (instCcy && instCcy !== portfolioCurrency) {
        preSkips.set(
          `${o.symbol}:${o.side}`,
          `cross-currency buy skipped: instrument is ${instCcy} but portfolio base is ${portfolioCurrency} and fx_enabled=false; enable FX to trade this instrument`,
        );
        mismatched.push({ symbol: o.symbol, instCcy });
      }
    }
    if (mismatched.length > 0) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "PRE_PLACE_FX_DISABLED_SKIP",
        path: "/reconcile/pre-place/fx-disabled",
        status: 200,
        request: asJson({ asOf, decisionId, portfolioCurrency }),
        response: asJson({ skipped: mismatched }),
        error: `skipped ${mismatched.length} cross-currency buy(s) because fx_enabled=false`,
      });
    }
  }


  // ---------- Learned-cash lockout.
  // If Saxo has rejected any buy on this portfolio with `InsufficientCash`
  // in the recent past AND the broker cash figure we're about to size against
  // hasn't materially grown since, block ALL new buys this tick. Saxo has
  // empirically proven our `SpendingPower`/`CashAvailableForTrading` reads
  // are optimistic (per-sub-account ring-fencing, unbooked in-flight fills,
  // margin haircuts) and re-queuing the same buys just spams the rejection
  // log. The lockout self-clears the moment a later CASH_SYNC shows
  // meaningfully more cash than we had when the reject was recorded.
  const LEARN_LOCKOUT_HOURS = 24;
  try {
    const { decideInsufficientCashLockout } = await import("./insufficient-cash-lockout");
    const cutoff = new Date(Date.now() - LEARN_LOCKOUT_HOURS * 3600_000).toISOString();
    const { data: recentRejects } = await supabaseAdmin
      .from("live_orders")
      .select("id, symbol, side, quantity, updated_at, reject_reason, status")
      .eq("portfolio_id", portfolio.id)
      .eq("side", "buy")
      .in("status", ["rejected", "error"])
      .ilike("reject_reason", "%InsufficientCash%")
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(10);
    const rejects = recentRejects ?? [];
    if (rejects.length > 0) {
      const newestRejectAt = rejects[0].updated_at as string;
      const { data: syncsAfter } = await supabaseAdmin
        .from("live_broker_log")
        .select("response, created_at")
        .eq("portfolio_id", portfolio.id)
        .eq("method", "CASH_SYNC")
        .gt("created_at", newestRejectAt)
        .order("created_at", { ascending: false })
        .limit(20);
      const decision = decideInsufficientCashLockout({
        rejects: rejects.map((r) => ({
          at: r.updated_at as string,
          symbol: r.symbol as string,
          quantity: Number(r.quantity),
        })),
        cashSyncs: (syncsAfter ?? []).map((r) => ({
          at: r.created_at as string,
          brokerCash: Number((r.response as { brokerCash?: number } | null)?.brokerCash ?? NaN),
        })),
      });
      if (decision.lockout) {
        for (const o of routable) {
          if (o.side === "buy") preSkips.set(`${o.symbol}:${o.side}`, decision.reason!);
        }
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_INSUFFICIENT_CASH_LOCKOUT",
          path: "/reconcile/pre-place/lockout",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            brokerCashAvailable,
            recentRejectCount: rejects.length,
            newestRejectAt,
          }),
          response: asJson({
            blocked: routable.filter((o) => o.side === "buy").length,
            rejects: rejects.map((r) => ({
              symbol: r.symbol,
              quantity: Number(r.quantity),
              at: r.updated_at,
            })),
            cashSinceReject: {
              min: decision.stats.minCashSinceReject,
              max: decision.stats.maxCashSinceReject,
              samples: decision.stats.samplesSinceReject,
            },
          }),
          error: decision.reason,
        });
      }
    }
  } catch {
    // Never let the lockout heuristic itself crash the tick.
  }

  // ---------- Adaptive buy-order cap.
  // The lockout above is binary: it stops ALL buys once InsufficientCash has
  // been seen and cash hasn't grown. But most of the time we're in a soft
  // state — some buys succeed at Saxo, others reject — and the smart response
  // is to keep trading at a size the broker actually accepts, not to fully
  // stop. Learn the maximum notional the broker has recently ACCEPTED (or,
  // failing that, a safe fraction below the smallest recent InsufficientCash
  // reject) and haircut `brokerCashAvailable` by the observed reject rate.
  //
  // Runs only when the lockout hasn't already skipped every buy this tick.
  const buysStillRoutable = routable.filter(
    (o) => o.side === "buy" && !preSkips.has(`${o.symbol}:${o.side}`),
  );
  if (buysStillRoutable.length > 0) {
    try {
      const { computeAdaptiveBuyCap } = await import("./adaptive-buy-cap");
      const LOOKBACK_HOURS = 24;
      const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
      const { data: recentBuys } = await supabaseAdmin
        .from("live_orders")
        .select(
          "id, symbol, quantity, limit_price, status, reject_reason, instrument_ccy, updated_at",
        )
        .eq("portfolio_id", portfolio.id)
        .eq("side", "buy")
        .gte("updated_at", cutoff)
        .order("updated_at", { ascending: false })
        .limit(200);

      const orderRows = recentBuys ?? [];
      const successOrderIds = orderRows
        .filter((r) => r.status === "filled" || r.status === "partial")
        .map((r) => r.id as string);
      const fillsByOrder = new Map<string, { qty: number; price: number; ccy: string }>();
      if (successOrderIds.length > 0) {
        const { data: fills } = await supabaseAdmin
          .from("live_fills")
          .select("order_id, quantity, fill_price, currency")
          .in("order_id", successOrderIds);
        for (const f of fills ?? []) {
          const oid = f.order_id as string;
          const prev = fillsByOrder.get(oid);
          const qty = Number(f.quantity);
          const px = Number(f.fill_price);
          if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) continue;
          if (prev) {
            const totalQty = prev.qty + qty;
            const vwap = (prev.qty * prev.price + qty * px) / totalQty;
            fillsByOrder.set(oid, { qty: totalQty, price: vwap, ccy: prev.ccy });
          } else {
            fillsByOrder.set(oid, { qty, price: px, ccy: String(f.currency ?? "").toUpperCase() });
          }
        }
      }

      // Convert an instrument-ccy notional to account-ccy for the cap. When
      // it's already the account ccy, no-op. Otherwise multiply by the
      // current tick's fxRate (portfolio->account) as a best-effort proxy.
      const acctCcy = (accountCurrency ?? portfolioCurrency).toUpperCase();
      const toAcctCcy = (n: number, instCcy: string): number | null => {
        if (!Number.isFinite(n) || n <= 0) return null;
        const c = instCcy.toUpperCase();
        if (c === acctCcy) return n;
        if (c === portfolioCurrency && Number.isFinite(fxRate) && fxRate > 0) return n * fxRate;
        // Unknown FX for this sample — drop it rather than distort the learner.
        return null;
      };

      const samples: {
        status: "filled" | "submitted" | "partial" | "rejected" | "error";
        notionalAcctCcy: number;
        rejectReason?: string | null;
      }[] = [];
      for (const r of orderRows) {
        const instCcy = String(r.instrument_ccy ?? acctCcy).toUpperCase();
        const status = r.status as string;
        if (status === "filled" || status === "partial") {
          const fill = fillsByOrder.get(r.id as string);
          if (!fill) continue;
          const n = toAcctCcy(fill.qty * fill.price, fill.ccy || instCcy);
          if (n == null) continue;
          samples.push({ status: status as "filled" | "partial", notionalAcctCcy: n });
        } else if (status === "submitted") {
          const qty = Number(r.quantity);
          const px = Number(r.limit_price);
          if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) continue;
          const n = toAcctCcy(qty * px, instCcy);
          if (n == null) continue;
          samples.push({ status: "submitted", notionalAcctCcy: n });
        } else if (status === "rejected" || status === "error") {
          const qty = Number(r.quantity);
          const px = Number(r.limit_price);
          if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) continue;
          const n = toAcctCcy(qty * px, instCcy);
          if (n == null) continue;
          samples.push({
            status: status as "rejected" | "error",
            notionalAcctCcy: n,
            rejectReason: r.reject_reason as string | null,
          });
        }
      }

      const cap = computeAdaptiveBuyCap({
        brokerCashAvailable,
        recentBuys: samples,
      });

      // Nothing to do when there's no reject-rate signal AND no ceiling to
      // enforce. Skip logging in the pure no-op case.
      const willAdjustAggregate =
        cap.aggregateCap != null &&
        brokerCashAvailable != null &&
        cap.aggregateCap < brokerCashAvailable - 1e-6;
      const perOrderSkips: {
        symbol: string;
        notionalAcctCcy: number;
        capAcctCcy: number;
      }[] = [];
      const perOrderTrims: {
        symbol: string;
        fromQuantity: number;
        toQuantity: number;
        capAcctCcy: number;
      }[] = [];
      // Smallest ticket worth dealing after charges; a trimmed order below this
      // is not worth routing, so it is skipped instead.
      const MIN_TRIMMED_NOTIONAL = 250;
      if (cap.perOrderCap != null && cap.perOrderCap > 0) {
        const { engineSymbolKey: adaptiveKeyOf } = await import("./price-symbol");
        for (const o of buysStillRoutable) {
          // Core top-ups are deliberately large so the whole allocation is
          // bought in one or two tickets; the learned per-order ceiling is a
          // reject-rate heuristic for short-term ideas, not for the core.
          if (coreKeyForOrder != null && adaptiveKeyOf(o.symbol) === coreKeyForOrder) continue;
          const instCcy = (o.instrument_ccy ?? acctCcy).toUpperCase();
          const notionalRaw = o.quantity * o.price;
          const notional = toAcctCcy(notionalRaw, instCcy);
          if (notional == null) continue;
          if (notional > cap.perOrderCap) {
            // An oversized ticket is a sizing question, not a reason to skip
            // the idea: cut it to the learned ceiling and route the smaller
            // order whenever what is left is still worth dealing.
            const perShareAcct = notional / o.quantity;
            const trimmedQty = Math.floor(cap.perOrderCap / perShareAcct);
            const trimmedNotional = trimmedQty * perShareAcct;
            if (trimmedQty >= 1 && trimmedNotional >= MIN_TRIMMED_NOTIONAL) {
              perOrderTrims.push({
                symbol: o.symbol,
                fromQuantity: o.quantity,
                toQuantity: trimmedQty,
                capAcctCcy: cap.perOrderCap,
              });
              o.quantity = trimmedQty;
              continue;
            }
            const reason = `adaptive-cap: order ${notional.toFixed(2)} ${acctCcy} exceeds learned per-order ceiling ${cap.perOrderCap.toFixed(2)} ${acctCcy} (source=${cap.learnedSource}, rejectRate=${cap.rejectRate.toFixed(2)})`;
            preSkips.set(`${o.symbol}:${o.side}`, reason);
            perOrderSkips.push({
              symbol: o.symbol,
              notionalAcctCcy: notional,
              capAcctCcy: cap.perOrderCap,
            });
          }
        }
      }


      if (willAdjustAggregate) {
        brokerCashAvailable = cap.aggregateCap;
      }

      if (
        willAdjustAggregate ||
        perOrderSkips.length > 0 ||
        perOrderTrims.length > 0 ||
        cap.samples.total > 0
      ) {

        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_ADAPTIVE_BUY_CAP",
          path: "/reconcile/pre-place/adaptive-cap",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            lookbackHours: LOOKBACK_HOURS,
            samples: cap.samples,
            rejectRate: cap.rejectRate,
            aggregateMultiplier: cap.aggregateMultiplier,
            perOrderCap: cap.perOrderCap,
            aggregateCap: cap.aggregateCap,
            learnedCeiling: cap.learnedCeiling,
            learnedSource: cap.learnedSource,
            acctCcy,
          }),
          response: asJson({
            appliedAggregateHaircut: willAdjustAggregate,
            brokerCashAvailableAfter: brokerCashAvailable,
            perOrderSkips,
            perOrderTrims,

            notes: cap.notes,
          }),
          error: null,
        });
      }
    } catch {
      // Never let the adaptive-cap heuristic itself crash the tick.
    }
  }


  // Build per-currency cash view for the multi-ccy trim path, net of the
  // open-order reservations captured above.
  const cashByCcyRaw = pfRowData?.cash_by_ccy ?? null;
  const cashByCcyAdjusted: Record<string, number> | null = cashByCcyRaw
    ? Object.fromEntries(
        Object.entries(cashByCcyRaw).map(([ccy, amt]) => {
          const reserved = reservedByCcy[ccy.toUpperCase()] ?? 0;
          return [ccy, Math.max(0, Number(amt) - reserved)];
        }),
      )
    : null;


  // If broker and portfolio currencies differ but FX resolution collapsed to
  // the identity fallback (both live FX providers unreachable and no cached
  // rate available), the affordability trim would badly under-estimate the
  // broker-currency cost of every buy, causing InsufficientCash rejects at
  // the broker. Block cross-currency buys in that state rather than send
  // them to certain rejection. Sells are unaffected — they free cash.
  const fxIsBroken =
    accountCurrency != null &&
    accountCurrency.toUpperCase() !== portfolioCurrency &&
    fxStale &&
    fxRate === 1 &&
    fxSource.startsWith("fallback:");

  // Persistent circuit breaker: even if THIS tick's FX capture succeeded, a
  // recent identity-fallback in the log keeps the breaker OPEN until we see a
  // live provider capture strictly newer than the last fallback. This stops
  // cross-currency buys from resuming during a flaky recovery window.
  let fxCircuitOpen = false;
  let fxCircuitReason: string | null = null;
  if (
    accountCurrency != null &&
    accountCurrency.toUpperCase() !== portfolioCurrency
  ) {
    try {
      const { getFxCircuitState } = await import("./fx-circuit.server");
      const state = await getFxCircuitState(supabaseAdmin, portfolio.id, 24);
      fxCircuitOpen = state.open;
      fxCircuitReason = state.reason;
    } catch {
      /* fail-open on circuit lookup errors — the fxIsBroken check still guards */
    }
  }

  if (fxIsBroken || fxCircuitOpen) {
    const reason = fxIsBroken
      ? `fx ${portfolioCurrency}->${accountCurrency} unavailable; buy skipped to avoid InsufficientCash reject`
      : `fx circuit OPEN — pausing cross-currency buys until live FX provider recovers (${fxCircuitReason ?? "recent fallback"})`;
    for (const o of routable) {
      if (o.side === "buy") {
        preSkips.set(`${o.symbol}:${o.side}`, reason);
      }
    }
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: fxIsBroken ? "PRE_PLACE_FX_BLOCK" : "PRE_PLACE_FX_CIRCUIT_OPEN",
      path: `/fx/${portfolioCurrency}->${accountCurrency}`,
      status: 424,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson({ fxSource, fxStale, fxCircuitOpen, fxCircuitReason }),
      error: reason,
    });
  } else if (fxEnabled) {
    // ---------- Phase B: per-currency wallet routing.
    // Rather than measure every buy against a single broker-cash number, walk
    // the portfolio's per-currency wallet (`cash_by_ccy`) and pay each buy
    // from its instrument's own quote currency. When the target currency is
    // short, top it up from the base currency via a synthetic FX conversion
    // leg captured at the same rate the AI sized against.
    const buys = routable
      .filter((o) => o.side === "buy")
      .slice()
      .sort((a, b) => b.quantity * b.price - a.quantity * a.price);

    if (buys.length > 0) {
      // Resolve instrument currency per symbol. Prefer the value the caller
      // passed on the ExecutedOrder; fall back to saxo_instrument_cache; then
      // to the portfolio base currency so we never crash on an unknown row.
      const symbols = Array.from(new Set(buys.map((o) => o.symbol)));
      const symToCcy = new Map<string, string>();
      for (const o of buys) {
        if (o.instrument_ccy) symToCcy.set(o.symbol, o.instrument_ccy.toUpperCase());
      }
      const missing = symbols.filter((s) => !symToCcy.has(s));
      if (missing.length > 0) {
        const cache = await supabaseAdmin
          .from("saxo_instrument_cache")
          .select("symbol, currency")
          .in("symbol", missing);
        for (const row of cache.data ?? []) {
          if (row.currency) symToCcy.set(row.symbol, row.currency.toUpperCase());
        }
      }
      for (const s of symbols) if (!symToCcy.has(s)) symToCcy.set(s, portfolioCurrency);

      // Bulk FX matrix: base_ccy -> every instrument currency we'll spend in.
      const targetCcys = Array.from(new Set(symToCcy.values())).filter(
        (c) => c !== portfolioCurrency,
      );
      const { getFxMatrix, refreshFxMatrix } = await import("@/lib/fx.server");
      let matrix =
        targetCcys.length > 0
          ? await getFxMatrix(targetCcys.map((c) => ({ from: portfolioCurrency, to: c })))
          : new Map<string, { rate: number; stale: boolean; source: string }>();

      // Pre-trade FX matrix guard: block buys whose required base->ccy
      // conversion is missing, identity-fallback, or stale. The trimmer's
      // per-order lookup already skips buys with a null rate, but a stale
      // (non-null) rate would otherwise route with just a wider safety
      // buffer. When the operator's expectation is "no trades on bad FX",
      // this pre-empts that path deterministically and gives one audit row
      // per blocked pair.
      //
      // Refresh-and-retry: when the first pass blocks any pair, evict just
      // those pairs from the FX cache and re-query the live providers once.
      // Blocks that recover (e.g. a rate that was stale because the TTL
      // elapsed while providers were momentarily slow) then route normally
      // in this same tick instead of waiting for the next one. Pairs that
      // are still bad on the retry fall through to the original skip path
      // with a `retriedAt` marker so the audit row records both attempts.
      if (targetCcys.length > 0) {
        const { guardFxMatrix } = await import("./fx-matrix-guard");
        let guard = guardFxMatrix(portfolioCurrency, targetCcys, matrix);
        let retriedAt: string | null = null;
        if (guard.hasBlock) {
          const refreshPairs = guard.blocked.map((b) => ({ from: b.from, to: b.to }));
          const before = guard.blocked.map((b) => ({
            to: b.to,
            reason: b.reason,
            source: b.source ?? null,
          }));
          retriedAt = new Date().toISOString();
          try {
            const refreshed = await refreshFxMatrix(refreshPairs);
            for (const [k, v] of refreshed) matrix.set(k, v);
          } catch (err) {
            // Refresh itself failed (network); keep the original matrix and
            // let the guard block as before. Record why.
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolio.id,
              user_id: userId,
              broker: "saxo",
              env: portfolio.mode === "live_prod" ? "live" : "sim",
              method: "PRE_PLACE_FX_MATRIX_REFRESH",
              path: `/fx/refresh`,
              status: 502,
              request: asJson({ asOf, decisionId, pairs: refreshPairs }),
              response: asJson({ before }),
              error: `fx refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          const guardAfter = guardFxMatrix(portfolioCurrency, targetCcys, matrix);
          const recovered = guard.blocked
            .filter((b) => !guardAfter.blockedCcys.has(b.to))
            .map((b) => b.to);
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "PRE_PLACE_FX_MATRIX_REFRESH",
            path: `/fx/refresh`,
            status: recovered.length > 0 ? 200 : 424,
            request: asJson({ asOf, decisionId, pairs: refreshPairs }),
            response: asJson({
              before,
              after: guardAfter.blocked.map((b) => ({
                to: b.to,
                reason: b.reason,
                source: b.source ?? null,
              })),
              recovered,
            }),
            error:
              recovered.length > 0
                ? null
                : `fx refresh did not recover any of: ${refreshPairs
                    .map((p) => `${p.from}->${p.to}`)
                    .join(", ")}`,
          });
          guard = guardAfter;
        }
        if (guard.hasBlock) {
          for (const b of guard.blocked) {
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolio.id,
              user_id: userId,
              broker: "saxo",
              env: portfolio.mode === "live_prod" ? "live" : "sim",
              method: "PRE_PLACE_FX_MATRIX_BLOCK",
              path: `/fx/${b.from}->${b.to}`,
              status: 424,
              request: asJson({ asOf, decisionId, reason: b.reason, retriedAt }),
              response: asJson({ source: b.source ?? null }),
              error: b.detail,
            });
          }
          // Skip every buy whose instrument currency is blocked. Sells are
          // unaffected — they free cash and don't need FX to route.
          for (const o of buys) {
            const ccy = (o.instrument_ccy ?? symToCcy.get(o.symbol) ?? portfolioCurrency).toUpperCase();
            if (guard.blockedCcys.has(ccy)) {
              const detail = guard.blocked.find((x) => x.to === ccy)?.detail ?? `fx ${portfolioCurrency}->${ccy} blocked`;
              preSkips.set(`${o.symbol}:${o.side}`, detail);
            }
          }
        }
      }



      const { readWallet, writeWalletFields } = await import("./portfolio-wallet");
      const { trimBuysToBudgetByCurrency } = await import("./pre-place-budget-multi-ccy");

      const wallet = readWallet({
        currency: portfolioCurrency,
        current_cash: brokerCashAvailable ?? undefined,
        cash_by_ccy: cashByCcyAdjusted,
      });

      const fxLookup = (from: string, to: string): number | null => {
        if (from === to) return 1;
        const hit = matrix.get(`${from}${to}`);
        if (!hit) return null;
        // A rate=1 identity fallback (both providers down) is unusable —
        // let the trimmer skip the buy instead of amplifying the reject.
        if (hit.source.startsWith("fallback:")) return null;
        return hit.rate;
      };
      const isStale = (from: string, to: string) => matrix.get(`${from}${to}`)?.stale === true;

      const anyStale = targetCcys.some((c) => matrix.get(`${portfolioCurrency}${c}`)?.stale);
      const safetyBufferPct = anyStale ? 0.05 : 0.01;

      const buyOrders = buys.map((o) => ({
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        price: o.price,
        instrument_ccy: symToCcy.get(o.symbol) ?? portfolioCurrency,
      }));

      const { quoteFxCost } = await import("./fx-cost-model");
      const fxCostBps = (from: string, to: string) =>
        quoteFxCost(from, to, fxExecutionMode === "spot" ? "spot" : "wallet").totalBps;

      let trim = trimBuysToBudgetByCurrency(
        buyOrders,
        wallet,
        portfolioCurrency,
        fxLookup,
        { safetyBufferPct, allowFxConversion: true, isRateStale: isStale, fxCostBps },
      );


      // Phase C: real spot FX. When fx_execution_mode='spot' and the adapter
      // implements placeFxSpot, submit each planned leg to the broker and
      // drop any buy whose leg failed. Then re-run the trimmer over the
      // survivors so wallet math reflects only successful legs.
      if (fxExecutionMode === "spot" && trim.fxLegs.length > 0 && typeof adapter.placeFxSpot !== "function") {
        // Spot FX is required to fund these buys, but the adapter can't
        // place FX. Drop every dependent buy and log one row per leg so
        // no order is submitted with an unfunded currency leg.
        for (const leg of trim.fxLegs) {
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "FX_SPOT_UNSUPPORTED",
            path: `/fx-spot/${leg.fromCcy}->${leg.toCcy}`,
            status: 501,
            request: asJson({ asOf, decisionId, amountFrom: leg.amountFrom, plannedRate: leg.rate }),
            response: asJson({ reason: "adapter does not implement placeFxSpot" }),
            error: "adapter does not implement placeFxSpot",
          });
          preSkips.set(`${leg.triggeredBySymbol}:buy`, "fx spot unsupported by adapter");
        }
        trim = { ...trim, fxLegs: [], decisions: trim.decisions.filter((d) => {
          if (d.kind !== "allow") return true;
          return !trim.fxLegs.some((l) => l.triggeredBySymbol === d.order.symbol);
        }) };
      }
      if (fxExecutionMode === "spot" && trim.fxLegs.length > 0 && typeof adapter.placeFxSpot === "function") {

        const { survivingBuysAfterFxSpot } = await import("./fx-spot-plan");
        const { consolidateFxLegs } = await import("./fx-leg-consolidation");
        type SpotOutcome = import("./fx-spot-plan").FxSpotOutcome;
        const outcomes: SpotOutcome[] = [];
        // One conversion per currency pair, rounded up to the broker's
        // minimum ticket when the wallet can cover it. Sub-minimum legs were
        // the single biggest reason US buys never got funded.
        const consolidated = consolidateFxLegs(trim.fxLegs, { available: wallet });
        for (const leg of consolidated) {
          // A leg the wallet cannot lift to the pair minimum is a certain
          // broker reject. Don't spend an order slot proving it — record the
          // real reason so the dependent buys read "not enough spare GBP to
          // reach the 1,000 minimum conversion", not "fx spot rejected".
          if (leg.shortfallReason) {
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolio.id,
              user_id: userId,
              broker: "saxo",
              env: portfolio.mode === "live_prod" ? "live" : "sim",
              method: "FX_SPOT_BELOW_MINIMUM",
              path: `/fx-spot/${leg.fromCcy}->${leg.toCcy}`,
              status: 412,
              request: asJson({
                asOf,
                decisionId,
                requiredFrom: leg.requiredFrom,
                triggerSymbols: leg.triggerSymbols,
              }),
              response: asJson({ skippedBeforeBroker: true }),
              error: leg.shortfallReason,
            });
            for (const triggerSymbol of leg.triggerSymbols) {
              outcomes.push({ kind: "failed", triggerSymbol, reason: leg.shortfallReason });
              reconFxOutcomes.push({ triggerSymbol, kind: "failed", reason: leg.shortfallReason });
            }
            continue;
          }
          // Saxo caps ExternalReference at 50 chars; a raw uuid + symbol + pair
          // overflows it and the whole order is rejected with InvalidModelState.
          // Hash instead so the key stays deterministic (idempotent retries) and short.
          const clientOrderId = `fx:${createHash("sha256")
            .update(`${decisionId}:${leg.fromCcy}${leg.toCcy}:${leg.triggerSymbols.join(",")}`)
            .digest("hex")
            .slice(0, 24)}`;
          const spot = await adapter.placeFxSpot!({
            fromCcy: leg.fromCcy,
            toCcy: leg.toCcy,
            amountFrom: leg.amountFrom,
            clientOrderId,
          });
          const ok = spot.status === "submitted" || spot.status === "filled";
          const reason = spot.reason ?? leg.shortfallReason ?? "fx spot rejected";
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: ok ? "FX_SPOT_PLACED" : "FX_SPOT_FAILED",
            path: `/fx-spot/${leg.fromCcy}->${leg.toCcy}`,
            status: ok ? 200 : 400,
            request: asJson({
              asOf,
              decisionId,
              clientOrderId,
              amountFrom: leg.amountFrom,
              requiredFrom: leg.requiredFrom,
              toppedUp: leg.toppedUp,
              triggerSymbols: leg.triggerSymbols,
              plannedRate: leg.rate,
            }),
            response: asJson({
              brokerOrderId: spot.brokerOrderId,
              pairSymbol: spot.pairSymbol,
              fillRate: spot.fillRate,
              amountTo: spot.amountTo,
              status: spot.status,
              reason: spot.reason,
            }),
            error: ok ? null : reason,
          });
          for (const triggerSymbol of leg.triggerSymbols) {
            outcomes.push(
              ok
                ? { kind: "ok", triggerSymbol, fillRate: spot.fillRate ?? leg.rate, amountTo: spot.amountTo ?? leg.amountTo }
                : { kind: "failed", triggerSymbol, reason },
            );
            reconFxOutcomes.push(
              ok ? { triggerSymbol, kind: "ok" } : { triggerSymbol, kind: "failed", reason },
            );
          }
        }
        const { survivors, droppedSymbols } = survivingBuysAfterFxSpot(buyOrders, trim, outcomes);
        if (droppedSymbols.size > 0) {
          // Re-plan against survivors so the persisted wallet & subsequent
          // per-symbol skip list reflect only successful legs.
          trim = trimBuysToBudgetByCurrency(
            survivors,
            wallet,
            portfolioCurrency,
            fxLookup,
            { safetyBufferPct, allowFxConversion: true, isRateStale: isStale, fxCostBps },
          );

          for (const [sym, reason] of droppedSymbols) {
            preSkips.set(`${sym}:buy`, `fx spot failed: ${reason}`);
          }
        }
      }

      // Snapshot the final, actually-submitted FX legs for the post-broker
      // reconciler. This is the set the reconciler expects to see reflected
      // in successful outcomes, one entry per triggered symbol.
      for (const leg of trim.fxLegs) {
        reconPlannedLegs.push({
          triggeredBySymbol: leg.triggeredBySymbol,
          fromCcy: leg.fromCcy,
          toCcy: leg.toCcy,
          amountFrom: leg.amountFrom,
          amountTo: leg.amountTo,
          rate: leg.rate,
          stale: leg.stale,
        });
      }

      for (const d of trim.decisions) {
        if (d.kind === "skip") preSkips.set(`${d.order.symbol}:${d.order.side}`, d.reason);
      }


      // Persist wallet updates (FX conversion legs + buy debits are all
      // reflected in `finalWallet`). Sells will be credited by the fill
      // handler later; this write only reflects the pre-placement state.
      if (trim.fxLegs.length > 0) {
        const fields = writeWalletFields(trim.finalWallet, portfolioCurrency);
        await supabaseAdmin
          .from("portfolios")
          .update({ cash_by_ccy: asJson(fields.cash_by_ccy), current_cash: fields.current_cash })
          .eq("id", portfolio.id);

        for (const leg of trim.fxLegs) {
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "FX_LEG",
            path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
            status: leg.stale ? 206 : 200,
            request: asJson({ asOf, decisionId, triggeredBySymbol: leg.triggeredBySymbol }),
            response: asJson({
              fromCcy: leg.fromCcy,
              toCcy: leg.toCcy,
              amountFrom: leg.amountFrom,
              amountTo: leg.amountTo,
              rate: leg.rate,
              stale: leg.stale,
            }),
            error: leg.stale ? "fx leg used stale rate" : null,
          });
        }
      }

      if (trim.skippedCount > 0 || trim.fxLegs.length > 0) {
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_MULTI_CCY_TRIM",
          path: "/reconcile/pre-place/trim-multi-ccy",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            baseCcy: portfolioCurrency,
            wallet,
            safetyBufferPct,
            targetCcys,
            requestedByCcy: trim.totalRequestedByCcy,
            allowedByCcy: trim.totalAllowedByCcy,
          }),
          response: asJson({
            skippedCount: trim.skippedCount,
            fxLegs: trim.fxLegs,
            skipped: trim.decisions
              .filter((d) => d.kind === "skip")
              .map((d) => ({
                symbol: d.order.symbol,
                side: d.order.side,
                instrument_ccy: d.order.instrument_ccy,
                notionalNative: d.notionalNative,
                reason: d.reason,
              })),
            finalWallet: trim.finalWallet,
          }),
          error: null,
        });
      }
    }
  } else if (brokerCashAvailable != null) {
    const { trimBuysToBudget } = await import("./pre-place-budget");
    // Rank buys by broker-ccy notional so the biggest, most conviction-heavy
    // buys get the budget first. Sells are never gated on cash.
    const buys = routable
      .filter((o) => o.side === "buy")
      .slice()
      .sort((a, b) => b.quantity * b.price - a.quantity * a.price);
    if (buys.length > 0) {
      // When FX is stale (cached-stale) but non-identity, apply a wider
      // safety buffer to absorb intra-day drift. Fresh FX keeps the 1%
      // default; a stale non-identity rate widens to 5%.
      const safetyBufferPct = fxStale ? 0.05 : 0.01;
      const trim = trimBuysToBudget(buys, brokerCashAvailable, fxRate, { safetyBufferPct });
      for (const d of trim.decisions) {
        if (d.kind === "skip") {
          preSkips.set(`${d.order.symbol}:${d.order.side}`, d.reason);
        }
      }
      if (trim.skippedCount > 0) {
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_AFFORDABILITY",
          path: "/reconcile/pre-place/trim",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            brokerCashAvailable,
            fxRate,
            fxStale,
            safetyBufferPct,
            requested: trim.totalRequestedBrokerCcy,
            allowed: trim.totalAllowedBrokerCcy,
          }),
          response: asJson({
            skippedCount: trim.skippedCount,
            skipped: trim.decisions
              .filter((d) => d.kind === "skip")
              .map((d) => ({
                symbol: d.order.symbol,
                side: d.order.side,
                notionalBrokerCcy: d.notionalBrokerCcy,
                reason: d.reason,
              })),
          }),
          error: null,
        });
      }
    }
  }




  // ---------- Preflight: resolve every symbol to a Saxo instrument up front.
  // If any lookup fails, block the entire batch so we never place a partial
  // set of orders where some symbols would silently be dropped.
  const uniqueSymbols = Array.from(new Set(routable.map((o) => o.symbol)));
  const preflight: Array<{ symbol: string; ok: boolean; error?: string }> = [];
  for (const sym of uniqueSymbols) {
    try {
      await adapter.lookupUic(sym);
      preflight.push({ symbol: sym, ok: true });
    } catch (err) {
      preflight.push({
        symbol: sym,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const missing = preflight.filter((p) => !p.ok);
  if (missing.length > 0) {
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PREFLIGHT_BLOCKED",
      path: "/route/preflight",
      status: 424,
      request: asJson({ asOf, decisionId, symbols: uniqueSymbols }),
      response: asJson({ preflight }),
      error: `Unresolved Saxo instrument(s): ${missing.map((m) => m.symbol).join(", ")}`,
    });
    const missingSet = new Set(missing.map((m) => m.symbol));
    return routable.map((e) => ({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      status: "skipped",
      skipped: missingSet.has(e.symbol)
        ? `preflight: ${missing.find((m) => m.symbol === e.symbol)?.error ?? "instrument not found"}`
        : "preflight blocked: another symbol in this batch failed instrument lookup",
    }));
  }

  // Broker-safe idempotency key. Scope it to the decision row when available so
  // a failed manual run can be retried in the same hour, while duplicate inserts
  // inside one decision still collapse on live_orders.client_order_id.
  const attemptSeed = decisionId ?? new Date().toISOString().slice(0, 16);


  // Saxo's /trade/v2/orders endpoint is rate-limited to roughly 1 request per
  // second per app. Space out submissions so a multi-order run doesn't get the
  // first order accepted and every follow-up rejected with HTTP 429.
  const ORDER_SPACING_MS = 1500;
  let firstOrder = true;

  // Resolve the true instrument currency for every routable order so each
  // live_orders row carries the correct currency stamp. The DB now enforces
  // NOT NULL + ISO-4217 CHECK on instrument_ccy, so a wrong/missing value
  // fails the insert instead of masquerading as GBP. Priority:
  //   caller hint > saxo_instrument_cache > portfolio base
  const { resolveOrderCurrencies } = await import("@/lib/live-order-currency");
  const cacheMap = new Map<string, string | null | undefined>();
  {
    const missing = Array.from(new Set(routable.map((o) => o.symbol))).filter(
      (s) => !routable.find((o) => o.symbol === s && o.instrument_ccy),
    );
    if (missing.length > 0) {
      const cache = await supabaseAdmin
        .from("saxo_instrument_cache")
        .select("symbol, currency")
        .in("symbol", missing);
      for (const row of cache.data ?? []) {
        cacheMap.set(row.symbol, row.currency);
      }
    }
  }
  const routeSymToCcy = resolveOrderCurrencies(routable, {
    cache: cacheMap,
    portfolioCurrency,
  });


  // Per-currency spend ledger for the fee-viable size-up. Starts from the
  // reconciled wallet (or the account balance for the base currency) and is
  // debited as each buy is routed, so an uplift can never spend cash twice.
  const { planViableSizeUp } = await import("./viable-size-up");
  const spendLedger = new Map<string, number>();
  for (const [ccy, amt] of Object.entries(cashByCcyAdjusted ?? {})) {
    spendLedger.set(ccy.toUpperCase(), Math.max(0, Number(amt) || 0));
  }
  if (!spendLedger.has(portfolioCurrency) && brokerCashAvailable != null) {
    spendLedger.set(portfolioCurrency, Math.max(0, brokerCashAvailable));
  }

  for (const order of routable) {
    // Pre-placement affordability trim: buys that don't fit the freshly
    // reconciled broker cash are skipped before we ever call placeOrder.
    const skipReason = preSkips.get(`${order.symbol}:${order.side}`);
    if (skipReason) {
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        status: "skipped",
        skipped: skipReason,
      });
      continue;
    }
    if (!firstOrder) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_SPACING_MS));
    }
    firstOrder = false;

    const clientOrderId = makeClientOrderId({
      portfolioId: portfolio.id,
      attemptSeed,
      symbol: order.symbol,
      side: order.side,
    });

    // Round quantity to a whole share (Saxo Stock/Etf orders reject fractional
    // Amount). Skip if this rounds to zero.
    let qty = Math.floor(order.quantity);
    if (qty <= 0) {
      // A buy trimmed to a fraction of a share is not an error — the idea
      // survived every merit gate and then lost the rounding. Buy one whole
      // share when the cash is genuinely there, otherwise say plainly why
      // nothing was bought instead of emitting a bare "quantity < 1".
      const orderCcy = (routeSymToCcy.get(order.symbol) ?? portfolioCurrency).toUpperCase();
      const spendable = spendLedger.get(orderCcy) ?? 0;
      const onePrice = Number(order.price) || 0;
      const extraOne = Math.max(0, (1 - Math.max(0, Number(order.quantity) || 0)) * onePrice);
      const headroomOne = Math.min(
        dailyBuyHeadroom,
        capRoomBySymbol.get(order.symbol.toUpperCase()) ?? Infinity,
      );
      if (order.side === "buy" && onePrice > 0 && spendable >= onePrice && extraOne <= headroomOne) {
        qty = 1;
        dailyBuyHeadroom = Math.max(0, dailyBuyHeadroom - extraOne);
        const roomOne = capRoomBySymbol.get(order.symbol.toUpperCase());
        if (roomOne !== undefined) {
          capRoomBySymbol.set(order.symbol.toUpperCase(), Math.max(0, roomOne - extraOne));
        }
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: adapter.env,
          method: "TRADE_ROUNDED_UP_TO_ONE_SHARE",
          path: "live_orders",
          status: 200,
          request: asJson({ symbol: order.symbol, requested: order.quantity, price: onePrice }),
          response: asJson({ quantity: 1, spendable }),
        });
      } else {
        const reason =
          order.side === "buy" && onePrice > 0 && extraOne > headroomOne
            ? `ticket trimmed below one share and rounding up to one ${order.symbol} share ` +
              `would exceed today's remaining trading limit — nothing was bought`
            : order.side === "buy" && onePrice > 0
            ? `ticket trimmed below one share: one ${order.symbol} share costs ` +
              `${onePrice.toFixed(2)} ${orderCcy} and only ${spendable.toFixed(2)} ${orderCcy} ` +
              `is spendable this run — nothing was bought and no money was spent`
            : "quantity < 1 whole share";
        results.push({
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          status: "skipped",
          skipped: reason,
        });
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: adapter.env,
          method: "TRADE_SUB_SHARE_SKIPPED",
          path: "live_orders",
          status: 412,
          request: asJson({ symbol: order.symbol, side: order.side, requested: order.quantity, price: onePrice }),
          response: asJson({ spendable, currency: orderCcy }),
          error: reason,
        });
        continue;
      }
    }

    // Trade-viability gate. Sizing upstream works on a *notional* budget, but
    // whole-share rounding can drop the real ticket far below it (1 share of a
    // £36 ETF against a £3 commission floor = 830bps one way). Re-check the
    // post-rounding economics here — the last place that knows the true
    // quantity — and skip BUYs whose round-trip friction (commission floor +
    // UK stamp duty + PTM levy + half-spread) exceeds the budget. Sells are
    // never blocked: exits must always be able to execute.
    let viability = assessTradeViability({
      symbol: order.symbol,
      side: order.side,
      quantity: qty,
      price: order.price,
    });
    let sizeUpNote: string | null = null;
    let sizeUpApplied = false;
    // The idea already passed every merit gate upstream; if the only problem
    // is that the ticket is too small to carry the fee floor, buy enough to
    // make it viable rather than discarding the trade.
    if (!viability.viable && order.side === "buy") {
      const orderCcy = (routeSymToCcy.get(order.symbol) ?? portfolioCurrency).toUpperCase();
      const spendable = spendLedger.get(orderCcy) ?? 0;
      // An uplift is extra spend the daily BUY ceiling and the single-name cap
      // never sanctioned upstream, so it is bounded by whatever room each has
      // left — cash alone is not a safety limit.
      const capRoom = capRoomBySymbol.get(order.symbol.toUpperCase());
      const baseNotional = qty * order.price;
      const maxNotional = Math.min(
        baseNotional + dailyBuyHeadroom,
        capRoom === undefined ? Infinity : baseNotional + capRoom,
      );
      const plan = planViableSizeUp({
        quantity: qty,
        price: order.price,
        minViableNotional: viability.minViableNotional,
        spendable,
        maxNotional,
      });
      sizeUpNote = plan.note;
      if (plan.applied) {
        sizeUpApplied = true;
        const extra = Math.max(0, (plan.quantity - qty) * order.price);
        dailyBuyHeadroom = Math.max(0, dailyBuyHeadroom - extra);
        if (capRoom !== undefined) {
          capRoomBySymbol.set(order.symbol.toUpperCase(), Math.max(0, capRoom - extra));
        }
        qty = plan.quantity;
        viability = assessTradeViability({
          symbol: order.symbol,
          side: order.side,
          quantity: qty,
          price: order.price,
        });
      }
    }
    if (!viability.viable) {
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        status: "skipped",
        skipped: viability.reason,
      });
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: adapter.env,
        method: "TRADE_VIABILITY_BLOCKED",
        path: "live_orders",
        status: null,
        request: asJson({
          symbol: order.symbol,
          side: order.side,
          quantity: qty,
          price: order.price,
          costs: viability.costs,
          budgetBps: viability.budgetBps,
          minViableNotional: viability.minViableNotional,
          sizeUp: sizeUpNote,
        }),
        error: viability.reason ?? null,
      });
      continue;
    }
    // Every routed buy consumes cash, whether or not it was sized up, so the
    // ledger must be debited for all of them — otherwise a later uplift would
    // spend money an earlier ticket has already committed.
    if (order.side === "buy") {
      const orderCcy = (routeSymToCcy.get(order.symbol) ?? portfolioCurrency).toUpperCase();
      spendLedger.set(orderCcy, Math.max(0, (spendLedger.get(orderCcy) ?? 0) - qty * order.price));
    }
    if (sizeUpApplied) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: adapter.env,
        method: "TRADE_SIZED_UP",
        path: "live_orders",
        status: 200,
        request: asJson({ symbol: order.symbol, quantity: qty, price: order.price }),
        response: asJson({ note: sizeUpNote }),
      });
    }



    // Phase 2 — marketable limit instead of a naked market order. Still
    // crosses the book (fills like a market order in normal conditions) but
    // caps the worst price we will accept if the book gaps away.
    const limitPlan = planMarketableLimit({
      side: order.side,
      referencePrice: order.price,
      currency: routeSymToCcy.get(order.symbol) ?? portfolioCurrency,
    });

    // A marketable limit is only marketable against the quote used to create
    // it. Replace an aged sell before submitting the current exit; otherwise
    // Saxo rejects the new order as a duplicate while the old limit can sit
    // above a falling market indefinitely. Never place the replacement unless
    // the broker confirms cancellation, preventing two live sells.
    if (order.side === "sell" && typeof adapter.listWorkingOrders === "function") {
      try {
        const working = await adapter.listWorkingOrders();
        const stale = findStaleWorkingSell({ working, symbol: order.symbol });
        if (stale) {
          const cancelled = await adapter.cancelOrder(stale.brokerOrderId);
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: adapter.env,
            method: "STALE_SELL_REPLACE",
            path: `/trade/v2/orders/${stale.brokerOrderId}`,
            status: cancelled.ok ? 200 : 409,
            request: asJson({
              symbol: order.symbol,
              quantity: qty,
              staleBrokerOrderId: stale.brokerOrderId,
              staleOrderTime: stale.orderTime ?? null,
              replacementLimit: limitPlan?.limitPrice ?? null,
            }),
            response: asJson({ cancelled: cancelled.ok }),
            error: cancelled.reason ?? null,
          });
          if (!cancelled.ok) {
            results.push({
              symbol: order.symbol,
              side: order.side,
              quantity: qty,
              status: "skipped",
              brokerOrderId: stale.brokerOrderId,
              skipped: "stale sell remains open; replacement withheld to prevent duplicate sale",
            });
            continue;
          }
          await supabaseAdmin
            .from("live_orders")
            .update({ status: "cancelled", reject_reason: "replaced after stale marketable limit" })
            .eq("portfolio_id", portfolio.id)
            .eq("broker_order_id", stale.brokerOrderId);
        }
      } catch (err) {
        // The broker's working-order listing is a *diagnostic*. When it fails
        // (network/auth blip) we must not strand the exit — fall back to our
        // own order book: if we have no open sell recorded for this symbol,
        // there is nothing to duplicate and the sell goes through.
        let openSells = 0;
        try {
          const { data: openRows } = await supabaseAdmin
            .from("live_orders")
            .select("id")
            .eq("portfolio_id", portfolio.id)
            .eq("symbol", order.symbol)
            .eq("side", "sell")
            .in("status", ["pending", "submitted", "working", "partially_filled"]);
          openSells = (openRows ?? []).length;
        } catch {
          openSells = 0;
        }
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: adapter.env,
          method: "STALE_SELL_VERIFY_FAILED",
          path: `/trade/v2/orders/working/${order.symbol}`,
          status: openSells > 0 ? 409 : 200,
          request: asJson({ symbol: order.symbol, quantity: qty }),
          response: asJson({ openSellsInLedger: openSells, proceeded: openSells === 0 }),
          error: err instanceof Error ? err.message : String(err),
        });
        if (openSells > 0) {
          results.push({
            symbol: order.symbol,
            side: order.side,
            quantity: qty,
            status: "skipped",
            skipped: "could not verify stale sell orders and an open sell exists in the ledger",
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

    }

    // Insert-first: DB unique index on client_order_id is the source of truth
    // for idempotency. On unique violation (23505) we look up the winner and
    // report it — no broker call is made for the duplicate.
    const inserted = await supabaseAdmin
      .from("live_orders")
      .insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        decision_id: decisionId,
        broker: "saxo",
        client_order_id: clientOrderId,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        order_type: limitPlan ? "limit" : "market",
        limit_price: limitPlan ? limitPlan.limitPrice : order.price,
        status: "pending",
        submitted_at: new Date().toISOString(),
        instrument_ccy: routeSymToCcy.get(order.symbol) ?? portfolioCurrency,
        // Model self-rated confidence for this order, kept on the ledger so
        // the trade list can show how sure the model was before the buy.
        conviction: Number.isFinite(order.conviction) ? Number(order.conviction) : null,
      })
      .select("id")
      .single();


    if (inserted.error || !inserted.data) {
      const isDuplicate = inserted.error?.code === "23505";
      if (isDuplicate) {
        const existing = await supabaseAdmin
          .from("live_orders")
          .select("id, status, broker_order_id")
          .eq("client_order_id", clientOrderId)
          .maybeSingle();
        results.push({
          symbol: order.symbol,
          side: order.side,
          quantity: qty,
          status: existing.data?.status ?? "duplicate",
          brokerOrderId: existing.data?.broker_order_id ?? undefined,
          skipped: "duplicate client_order_id (already routed this hour)",
        });
        continue;
      }
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        status: "error",
        reason: inserted.error?.message ?? "insert failed",
      });
      continue;
    }
    const liveOrderId = inserted.data.id as string;


    let brokerRes: BrokerOrderResult;
    try {
      brokerRes = await adapter.placeOrder({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        ...(limitPlan
          ? { orderType: "limit" as const, limitPrice: limitPlan.limitPrice }
          : { orderType: "market" as const }),
        clientOrderId,
      });
      // A malformed limit price must never strand an exit. If Saxo accepts
      // the instrument/quantity but rejects only the tick or tolerance, retry
      // the SELL once as a market order. BUYs never use this escape hatch.
      if (
        limitPlan &&
        shouldRetrySellAsMarket({
          side: order.side,
          status: brokerRes.status,
          reason: brokerRes.reason,
        })
      ) {
        const firstReason = brokerRes.reason ?? brokerRes.status;
        brokerRes = await adapter.placeOrder({
          symbol: order.symbol,
          side: "sell",
          quantity: qty,
          orderType: "market",
          clientOrderId: `${clientOrderId}-mkt`.slice(0, 50),
        });
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: adapter.env,
          method: "SELL_PRICE_REJECTION_MARKET_RETRY",
          path: "live_orders",
          status: null,
          request: asJson({
            symbol: order.symbol,
            quantity: qty,
            rejectedLimit: limitPlan.limitPrice,
            firstReason,
          }),
          response: asJson({
            status: brokerRes.status,
            brokerOrderId: brokerRes.brokerOrderId,
            reason: brokerRes.reason ?? null,
          }),
          error:
            brokerRes.status === "rejected" || brokerRes.status === "error"
              ? (brokerRes.reason ?? brokerRes.status)
              : null,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin
        .from("live_orders")
        .update({ status: "error", reject_reason: msg.slice(0, 500) })
        .eq("id", liveOrderId);
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        status: "error",
        reason: msg,
      });
      // Alert the owner: the order never even reached the broker cleanly.
      const { notifyTradeRejected } = await import("./trade-open-notify.server");
      notifyTradeRejected({
        userId,
        portfolioId: portfolio.id,
        orderId: liveOrderId,
        decisionId: decisionId ?? null,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        price: limitPlan ? limitPlan.limitPrice : (order.price ?? null),
        currency: routeSymToCcy.get(order.symbol) ?? portfolioCurrency,
        status: "error",
        rejectReason: msg.slice(0, 500),
      });
      continue;
    }

    await supabaseAdmin
      .from("live_orders")
      .update({
        status: brokerRes.status,
        broker_order_id: brokerRes.brokerOrderId || null,
        reject_reason: brokerRes.reason ?? null,
      })
      .eq("id", liveOrderId);

    // Live alert the moment the trade is accepted by the broker — stock, size
    // and the signals behind it — so the owner can act without waiting for
    // the fill reconciliation.
    if (brokerRes.status !== "rejected" && brokerRes.status !== "error") {
      const { notifyTradeOpened } = await import("./trade-open-notify.server");
      notifyTradeOpened({
        userId,
        portfolioId: portfolio.id,
        orderId: liveOrderId,
        decisionId: decisionId ?? null,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        price: brokerRes.avgFillPrice ?? (limitPlan ? limitPlan.limitPrice : (order.price ?? null)),
        currency: routeSymToCcy.get(order.symbol) ?? portfolioCurrency,
        status: brokerRes.status,
        orderType: limitPlan ? "limit" : "market",
        limitPrice: limitPlan ? limitPlan.limitPrice : null,
      });
    }



    // Learn permanent, account-level rejections (e.g. Saxo's "suitability
    // test has not been taken" on complex products such as gold ETCs) so the
    // engine stops re-proposing the same symbol every hour.
    if (brokerRes.status === "rejected" || brokerRes.status === "error") {
      try {
        const { recordBrokerRejection } = await import("./broker-instrument-blocks.server");
        await recordBrokerRejection({
          userId,
          portfolioId: portfolio.id,
          broker: "saxo",
          symbol: order.symbol,
          rejectReason: brokerRes.reason ?? null,
          orderId: brokerRes.brokerOrderId || liveOrderId,
          side: order.side,
          quantity: order.quantity ?? null,
        });
      } catch (e) {
        console.warn("[live-executor] block recording failed:", e);
      }

      // Same visibility as a fill: alert the owner with the broker's reason.
      const { notifyTradeRejected } = await import("./trade-open-notify.server");
      notifyTradeRejected({
        userId,
        portfolioId: portfolio.id,
        orderId: liveOrderId,
        decisionId: decisionId ?? null,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        price: limitPlan ? limitPlan.limitPrice : (order.price ?? null),
        currency: routeSymToCcy.get(order.symbol) ?? portfolioCurrency,
        status: brokerRes.status,
        rejectReason: brokerRes.reason ?? null,
      });
    }


    if (brokerRes.status === "filled" && brokerRes.filledQuantity && brokerRes.avgFillPrice) {
      // Saxo returns LSE common stocks in GBX (pence). Booking that raw
      // number stored HSBA at 1556.20 "GBP" next to 15.52 GBP rows from the
      // reconcile path — the same instrument in two units, which corrupts
      // cost basis, realised PnL and every holdings/fills reconciliation.
      // Resolve through the shared rule so both write paths agree.
      const resolved = resolveFillRecord({
        symbol: order.symbol,
        candidates: [{ source: "broker_avg_fill_price", value: brokerRes.avgFillPrice, raw: true }],
        orderCcy: routeSymToCcy.get(order.symbol) ?? null,
        portfolioCurrency,
      });
      if (!resolved) {
        console.warn(
          `[live-executor] fill_price_unavailable for ${order.symbol}; skipping live_fills insert`,
        );
      } else {
        const fillCcy = resolved.currency;
        await supabaseAdmin.from("live_fills").insert({
          order_id: liveOrderId,
          portfolio_id: portfolio.id,
          user_id: userId,
          symbol: order.symbol,
          side: order.side,
          quantity: brokerRes.filledQuantity,
          fill_price: resolved.fillPrice,
          fee: modelledFillFee({
            symbol: order.symbol,
            side: order.side === "sell" ? "sell" : "buy",
            quantity: brokerRes.filledQuantity,
            price: resolved.fillPrice,
          }),
          currency: fillCcy,
          // Tariff estimate until the broker's charge report is matched;
          // the trade card labels it as estimated on the strength of this.
          fee_source: "model",
          broker_fill_id: brokerRes.brokerOrderId || null,
          filled_at: new Date().toISOString(),
        });
        // Rest a protective stop for an immediate fill. Submitted orders get
        // the same protection when reconciliation later confirms the fill.
        await placeProtectiveStopAfterBuyFill({
          adapter,
          portfolioId: portfolio.id,
          userId,
          orderId: liveOrderId,
          symbol: order.symbol,
          side: order.side,
          quantity: brokerRes.filledQuantity,
          fillPrice: resolved.fillPrice,
          source: "live_executor:immediate",
        });

        const { notifyTradeFilled } = await import("./trade-fill-notify.server");
        notifyTradeFilled({
          userId,
          portfolioId: portfolio.id,
          orderId: liveOrderId,
          symbol: order.symbol,
          side: order.side,
          quantity: brokerRes.filledQuantity,
          fillPrice: resolved.fillPrice,
          currency: fillCcy,
          source: "live_executor",
        });
      }
    }


    results.push({
      symbol: order.symbol,
      side: order.side,
      quantity: qty,
      status: brokerRes.status,
      brokerOrderId: brokerRes.brokerOrderId,
      reason: brokerRes.reason,
    });
  }

  // ---------- Post-broker reconciliation.
  // Verify every routed buy landed with the FX legs the trimmer planned.
  // Each entry is written as its own audit row so the FX health card + trade
  // error dashboard can render funded vs failed at a glance, and so a rerun
  // never silently overwrites a prior verdict for the same buy.
  if (results.some((r) => r.side === "buy")) {
    const { reconcileBuysWithFxLegs } = await import("./post-broker-reconciliation");
    const recon = reconcileBuysWithFxLegs(
      results.map((r) => ({
        symbol: r.symbol,
        side: r.side,
        status: r.status,
        reason: r.reason,
        skipped: r.skipped,
      })),
      reconPlannedLegs,
      reconFxOutcomes,
    );
    for (const entry of recon) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "POST_BROKER_RECON",
        path: `/reconcile/post-broker/${entry.symbol}`,
        status: entry.status === "fully_funded" ? 200 : 424,
        request: asJson({
          asOf,
          decisionId,
          expectedFxLegs: entry.expectedFxLegs,
          orderStatus: entry.orderStatus,
        }),
        response: asJson({
          status: entry.status,
          fulfilledFxLegs: entry.fulfilledFxLegs,
          reason: entry.reason,
        }),
        error: entry.status === "failed" ? entry.reason : null,
      });
    }
  }

  // Anything that actually reached the broker changes positions/cash, so
  // kick off an immediate re-valuation instead of waiting for the next tick.
  if (results.some((r) => !r.skipped && r.brokerOrderId)) {
    const { triggerLiveValuationRefresh } = await import(
      "@/lib/live-valuation-trigger.server"
    );
    triggerLiveValuationRefresh({
      portfolioId: portfolio.id,
      userId,
      reason: "broker-order-routed",
    });
  }

  return results;
}


function makeClientOrderId(args: {
  portfolioId: string;
  attemptSeed: string;
  symbol: string;
  side: "buy" | "sell";
}): string {
  const hash = createHash("sha256")
    .update(`${args.portfolioId}:${args.attemptSeed}:${args.symbol}:${args.side}`)
    .digest("hex")
    .slice(0, 24);
  return `aegis:${hash}`;
}
