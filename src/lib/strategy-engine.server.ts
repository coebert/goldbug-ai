// Strategy engine: evaluates user-defined entry / stop-loss / take-profit
// rules per symbol and routes the resulting orders through the same pipeline
// the AI uses (Saxo adapter for live modes, local execution-realism fills for
// paper). Also enforces the per-position drawdown budget, which auto-closes
// any holding whose unrealised loss breaches the budget — the equity/crypto
// equivalent of the FX-leg auto-close.

import type { SupabaseClient } from "@supabase/supabase-js";

type AssetClassName = "stock" | "etf" | "crypto" | "commodity" | "fx";

type StrategyPatch = {
  last_evaluated_at?: string;
  last_error?: string | null;
  status?: "armed" | "open" | "closed" | "error";
  entered_at?: string;
  exited_at?: string;
  exit_reason?: string;
};

export type StrategyRow = {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string;
  instrument_ccy: string;
  quantity: number;
  entry_price: number;
  entry_mode: string;
  stop_loss: number | null;
  take_profit: number | null;
  enabled: boolean;
  status: string;
};

export type PortfolioLike = {
  id: string;
  mode: string;
  status: string;
  currency: string;
  current_cash: number;
  cash_by_ccy: Record<string, number> | null;
  live_paused: boolean;
  holding_dd_budget_pct?: number | null;
  holding_dd_autoclose?: boolean | null;
  concentration_cap_pct?: number | null;
  concentration_autotrim?: boolean | null;
};

export type StrategyAction = {
  symbol: string;
  action: "entry" | "stop_loss" | "take_profit" | "drawdown_budget" | "concentration_cap" | "none";
  side?: "buy" | "sell";
  qty?: number;
  price?: number;
  status?: string;
  detail: string;
};

/** Latest cached close for a symbol, normalised to the instrument base unit. */
export async function latestBasePrice(
  supabase: SupabaseClient,
  symbol: string,
  assetClass: string | null,
): Promise<number | null> {
  const { priceSymbolVariants } = await import("@/lib/price-symbol");
  const { normalizeLseDisplayPriceToBase: toBase } = await import(
    "@/lib/market-price-units"
  );
  const { data } = await supabase
    .from("price_cache")
    .select("close, price_date")
    .in("symbol", priceSymbolVariants(symbol))
    .order("price_date", { ascending: false })
    .limit(1);
  const close = data && data[0] ? Number(data[0].close) : NaN;
  if (!Number.isFinite(close) || close <= 0) return null;
  const base = toBase(symbol, close, assetClass ?? undefined);
  return Number.isFinite(base) && base > 0 ? base : null;
}

/**
 * Places one order. Live modes route through the broker adapter; paper /
 * backtest apply locally with execution-realism fills so the wallet, holdings
 * and trade tape stay consistent.
 */
export async function placeStrategyOrder(args: {
  portfolio: PortfolioLike;
  userId: string;
  symbol: string;
  assetClass: string;
  instrumentCcy: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  reason: string;
}): Promise<{ status: string; qty: number; price: number; brokerOrderId?: string | null }> {
  const { portfolio: p, side, qty, price } = args;
  const asOf = new Date().toISOString().slice(0, 10);

  if (p.status === "complete") throw new Error("Portfolio is complete — orders disabled.");
  if ((p.mode === "live_sim" || p.mode === "live_prod") && p.live_paused) {
    throw new Error("Live portfolio is paused. Resume it before placing orders.");
  }
  if (!(qty > 0) || !(price > 0)) throw new Error("Invalid order size or price.");

  if (p.mode === "live_sim" || p.mode === "live_prod") {
    const { routeOrdersToBroker } = await import("@/lib/live-executor.server");
    const results = await routeOrdersToBroker({
      portfolio: { id: p.id, mode: p.mode, live_paused: p.live_paused },
      userId: args.userId,
      asOf,
      decisionId: null,
      executed: [
        {
          symbol: args.symbol,
          side,
          quantity: qty,
          price,
          reason: args.reason,
          instrument_ccy: args.instrumentCcy,
        },
      ],
    });
    const r = results[0];
    return {
      status: r?.status ?? "submitted",
      qty,
      price,
      brokerOrderId: r?.brokerOrderId ?? null,
    };
  }

  // Paper / backtest: apply locally.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { applyBuyExecution, applySellExecution } = await import(
    "@/lib/execution-realism.server"
  );
  const { readWallet, applyDelta, writeWalletFields } = await import(
    "@/lib/portfolio-wallet"
  );
  const baseCcy = String(p.currency || "GBP").toUpperCase();
  const ccy = args.instrumentCcy.toUpperCase();
  const ac = args.assetClass as AssetClassName;

  let fillPrice = price;
  let filledQty = qty;
  let cashDelta = 0;

  if (side === "buy") {
    const out = applyBuyExecution({
      requestedSpend: qty * price,
      price,
      atrPct: null,
      adv20d: null,
      assetClass: ac,
      currency: ccy,
    });
    if (!(out.qty > 0)) throw new Error(out.notes.join("; ") || "Buy rejected by execution model.");
    fillPrice = out.fillPrice;
    filledQty = out.qty;
    cashDelta = -out.effectiveSpend;
  } else {
    const out = applySellExecution({
      qty,
      price,
      atrPct: null,
      assetClass: ac,
      currency: ccy,
    });
    fillPrice = out.fillPrice;
    cashDelta = out.proceedsNet;
  }

  const wallet = readWallet({
    currency: baseCcy,
    current_cash: Number(p.current_cash),
    cash_by_ccy: p.cash_by_ccy ?? null,
  });
  const walletWrite = writeWalletFields(applyDelta(wallet, ccy, cashDelta), baseCcy);

  const { data: existing } = await supabaseAdmin
    .from("holdings")
    .select("id, quantity, avg_cost")
    .eq("portfolio_id", p.id)
    .eq("symbol", args.symbol)
    .maybeSingle();

  if (side === "buy") {
    const prevQty = existing ? Number(existing.quantity) : 0;
    const prevCost = existing ? Number(existing.avg_cost) : 0;
    const newQty = prevQty + filledQty;
    const newAvg = newQty > 0 ? (prevQty * prevCost + filledQty * fillPrice) / newQty : fillPrice;
    if (existing) {
      await supabaseAdmin
        .from("holdings")
        .update({ quantity: newQty, avg_cost: newAvg, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await supabaseAdmin.from("holdings").insert({
        portfolio_id: p.id,
        symbol: args.symbol,
        asset_class: args.assetClass as AssetClassName,
        quantity: filledQty,
        avg_cost: newAvg,
        instrument_ccy: ccy,
      });
    }
  } else if (existing) {
    const remaining = Number(existing.quantity) - filledQty;
    if (remaining <= 1e-8) {
      await supabaseAdmin.from("holdings").delete().eq("id", existing.id);
    } else {
      await supabaseAdmin
        .from("holdings")
        .update({ quantity: remaining, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    }
  }

  await supabaseAdmin.from("trades").insert({
    portfolio_id: p.id,
    symbol: args.symbol,
    asset_class: args.assetClass as AssetClassName,
    side,
    quantity: filledQty,
    price: fillPrice,
    value: filledQty * fillPrice,
    executed_at: new Date().toISOString(),
    trade_date: asOf,
    reason: args.reason,
    instrument_ccy: ccy,
  });

  await supabaseAdmin
    .from("portfolios")
    .update({
      current_cash: walletWrite.current_cash,
      cash_by_ccy: walletWrite.cash_by_ccy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.id);
  // Keep the in-memory wallet current so a batch of actions compounds.
  p.current_cash = walletWrite.current_cash;
  p.cash_by_ccy = walletWrite.cash_by_ccy as Record<string, number> | null;

  return { status: "filled", qty: filledQty, price: fillPrice };
}

function entryTriggered(mode: string, price: number, entry: number): boolean {
  if (mode === "market") return true;
  if (mode === "breakout") return price >= entry;
  return price <= entry; // limit: buy the dip
}

/** Evaluates every enabled strategy for a portfolio and places any triggered order. */
export async function evaluateStrategies(args: {
  supabase: SupabaseClient;
  userId: string;
  portfolio: PortfolioLike;
  strategies: StrategyRow[];
}): Promise<StrategyAction[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const out: StrategyAction[] = [];

  for (const s of args.strategies) {
    if (!s.enabled || s.status === "closed") continue;
    const price = await latestBasePrice(args.supabase, s.symbol, s.asset_class);
    const patch: StrategyPatch = { last_evaluated_at: new Date().toISOString() };

    if (price == null) {
      out.push({ symbol: s.symbol, action: "none", detail: "no fresh price — skipped" });
      patch.last_error = "no price available";
      await supabaseAdmin.from("trade_strategies").update(patch).eq("id", s.id);
      continue;
    }

    try {
      if (s.status === "armed") {
        if (!entryTriggered(s.entry_mode, price, Number(s.entry_price))) {
          out.push({
            symbol: s.symbol,
            action: "none",
            price,
            detail: `waiting for entry (${s.entry_mode} ${s.entry_price})`,
          });
        } else {
          const r = await placeStrategyOrder({
            portfolio: args.portfolio,
            userId: args.userId,
            symbol: s.symbol,
            assetClass: s.asset_class,
            instrumentCcy: s.instrument_ccy,
            side: "buy",
            qty: Number(s.quantity),
            price,
            reason: `Strategy entry (${s.entry_mode} @ ${s.entry_price})`,
          });
          patch.status = "open";
          patch.entered_at = new Date().toISOString();
          patch.last_error = null;
          out.push({
            symbol: s.symbol,
            action: "entry",
            side: "buy",
            qty: r.qty,
            price: r.price,
            status: r.status,
            detail: `entry filled/placed at ${r.price}`,
          });
        }
      } else if (s.status === "open") {
        const stop = s.stop_loss != null ? Number(s.stop_loss) : null;
        const tp = s.take_profit != null ? Number(s.take_profit) : null;
        const hit: "stop_loss" | "take_profit" | null =
          stop != null && price <= stop
            ? "stop_loss"
            : tp != null && price >= tp
              ? "take_profit"
              : null;
        if (!hit) {
          out.push({ symbol: s.symbol, action: "none", price, detail: "position within bands" });
        } else {
          const { data: h } = await args.supabase
            .from("holdings")
            .select("quantity")
            .eq("portfolio_id", args.portfolio.id)
            .eq("symbol", s.symbol)
            .maybeSingle();
          const qty = Math.min(Number(s.quantity), h ? Number(h.quantity) : 0);
          if (!(qty > 0)) {
            patch.status = "closed";
            patch.exit_reason = "no position held";
            out.push({ symbol: s.symbol, action: "none", detail: "no position to exit" });
          } else {
            const r = await placeStrategyOrder({
              portfolio: args.portfolio,
              userId: args.userId,
              symbol: s.symbol,
              assetClass: s.asset_class,
              instrumentCcy: s.instrument_ccy,
              side: "sell",
              qty,
              price,
              reason: `Strategy ${hit} @ ${price}`,
            });
            patch.status = "closed";
            patch.exited_at = new Date().toISOString();
            patch.exit_reason = hit;
            patch.last_error = null;
            out.push({
              symbol: s.symbol,
              action: hit,
              side: "sell",
              qty: r.qty,
              price: r.price,
              status: r.status,
              detail: `${hit} exit at ${r.price}`,
            });
          }
        }
      }
    } catch (e) {
      patch.status = "error";
      patch.last_error = (e as Error).message;
      out.push({ symbol: s.symbol, action: "none", detail: `error: ${(e as Error).message}` });
    }

    await supabaseAdmin.from("trade_strategies").update(patch).eq("id", s.id);
  }

  return out;
}

/**
 * Per-position drawdown budget: any holding whose unrealised loss breaches the
 * budget is closed in full, mirroring the FX-leg auto-close.
 */
export async function evaluateHoldingDrawdownBudget(args: {
  supabase: SupabaseClient;
  userId: string;
  portfolio: PortfolioLike;
}): Promise<StrategyAction[]> {
  const budget = Number(args.portfolio.holding_dd_budget_pct ?? NaN);
  const out: StrategyAction[] = [];
  if (!args.portfolio.holding_dd_autoclose || !Number.isFinite(budget) || budget <= 0) return out;

  const { data: holdings } = await args.supabase
    .from("holdings")
    .select("id, symbol, quantity, avg_cost, asset_class, instrument_ccy")
    .eq("portfolio_id", args.portfolio.id);

  for (const h of holdings ?? []) {
    const qty = Number(h.quantity);
    const cost = Number(h.avg_cost);
    if (!(qty > 0) || !(cost > 0)) continue;
    if (h.asset_class === "fx") continue; // FX legs have their own auto-close
    const price = await latestBasePrice(args.supabase, h.symbol, h.asset_class);
    if (price == null) continue;
    const pnlPct = ((price - cost) / cost) * 100;
    if (pnlPct > -budget) continue;
    try {
      const r = await placeStrategyOrder({
        portfolio: args.portfolio,
        userId: args.userId,
        symbol: h.symbol,
        assetClass: String(h.asset_class),
        instrumentCcy: String(h.instrument_ccy || args.portfolio.currency),
        side: "sell",
        qty,
        price,
        reason: `Drawdown budget breach: ${pnlPct.toFixed(2)}% vs -${budget}% budget`,
      });
      out.push({
        symbol: h.symbol,
        action: "drawdown_budget",
        side: "sell",
        qty: r.qty,
        price: r.price,
        status: r.status,
        detail: `closed at ${pnlPct.toFixed(2)}% (budget -${budget}%)`,
      });
    } catch (e) {
      out.push({
        symbol: h.symbol,
        action: "none",
        detail: `auto-close failed: ${(e as Error).message}`,
      });
    }
  }
  return out;
}


/**
 * Risk-concentration guard. Any single non-FX holding whose market value
 * exceeds `concentration_cap_pct` of gross portfolio value (positions + cash)
 * is trimmed back to the cap by selling the excess. Unlike the drawdown
 * budget this fires on winners too — an unmanaged winner is the most common
 * way a diversified book turns into a single-name bet.
 */
export async function evaluateConcentrationCap(args: {
  supabase: SupabaseClient;
  userId: string;
  portfolio: PortfolioLike;
}): Promise<StrategyAction[]> {
  const cap = Number(args.portfolio.concentration_cap_pct ?? NaN);
  const out: StrategyAction[] = [];
  if (!args.portfolio.concentration_autotrim || !Number.isFinite(cap) || cap <= 0 || cap >= 100) {
    return out;
  }

  const { data: holdings } = await args.supabase
    .from("holdings")
    .select("id, symbol, quantity, avg_cost, asset_class, instrument_ccy")
    .eq("portfolio_id", args.portfolio.id);

  const baseCcy = String(args.portfolio.currency || "GBP").toUpperCase();
  const priced: Array<{
    symbol: string;
    qty: number;
    price: number;
    /** Market value in the instrument's own currency. */
    value: number;
    /** Market value converted into the portfolio base currency. */
    valueBase: number;
    asset_class: string;
    instrument_ccy: string;
  }> = [];
  const rawPriced: Array<{
    symbol: string;
    qty: number;
    price: number;
    value: number;
    asset_class: string;
    instrument_ccy: string;
  }> = [];
  for (const h of holdings ?? []) {
    const qty = Number(h.quantity);
    if (!(qty > 0)) continue;
    if (h.asset_class === "fx") continue; // FX funding legs sit in the cash wallet
    const price = await latestBasePrice(args.supabase, h.symbol, h.asset_class);
    if (price == null || !(price > 0)) continue;
    rawPriced.push({
      symbol: h.symbol,
      qty,
      price,
      value: qty * price,
      asset_class: String(h.asset_class),
      instrument_ccy: String(h.instrument_ccy || baseCcy).toUpperCase(),
    });
  }

  // Weights must be computed in one currency. Convert every holding value and
  // every cash bucket into the portfolio base currency first; a mixed-currency
  // `gross` inflates or deflates weights and can auto-trim a compliant holding.
  const { readWallet } = await import("@/lib/portfolio-wallet");
  const { getFxMatrix } = await import("@/lib/fx.server");
  const wallet = readWallet(args.portfolio);
  const pairs = [
    ...rawPriced.map((p) => ({ from: p.instrument_ccy, to: baseCcy })),
    ...Object.keys(wallet).map((c) => ({ from: c.toUpperCase(), to: baseCcy })),
  ];
  const fx = await getFxMatrix(pairs);
  const rateOf = (from: string) => {
    const f = from.toUpperCase();
    if (f === baseCcy) return { rate: 1, stale: false };
    const r = fx.get(`${f}${baseCcy}`);
    if (!r || !(r.rate > 0) || !Number.isFinite(r.rate)) return { rate: 1, stale: true };
    return { rate: r.rate, stale: r.stale };
  };

  let anyStale = false;
  let cash = 0;
  for (const [ccy, amt] of Object.entries(wallet)) {
    const v = Number(amt);
    if (!Number.isFinite(v)) continue;
    const r = rateOf(ccy);
    if (r.stale) anyStale = true;
    cash += v * r.rate;
  }
  cash = Math.max(0, cash);

  for (const p of rawPriced) {
    const r = rateOf(p.instrument_ccy);
    if (r.stale) anyStale = true;
    priced.push({ ...p, valueBase: p.value * r.rate });
  }

  // Never auto-sell on an FX rate we don't trust — weights would be wrong.
  if (anyStale) {
    return [
      {
        symbol: "-",
        action: "none",
        detail: "concentration trim skipped: stale or missing FX rate for base-currency valuation",
      },
    ];
  }

  const gross = priced.reduce((s, p) => s + p.valueBase, 0) + cash;
  if (!(gross > 0)) return out;

  for (const p of priced) {
    const weight = (p.valueBase / gross) * 100;
    if (weight <= cap) continue;
    // Sell the excess only: target value = cap% of gross (base currency).
    const targetValue = (cap / 100) * gross;
    const excessQty = (p.valueBase - targetValue) / (p.valueBase / p.qty);
    const sellQty = Math.min(p.qty, excessQty);
    if (!(sellQty > 0)) continue;

    try {
      const r = await placeStrategyOrder({
        portfolio: args.portfolio,
        userId: args.userId,
        symbol: p.symbol,
        assetClass: p.asset_class,
        instrumentCcy: p.instrument_ccy,
        side: "sell",
        qty: sellQty,
        price: p.price,
        reason: `Concentration cap breach: ${weight.toFixed(1)}% of book vs ${cap}% cap`,
      });
      out.push({
        symbol: p.symbol,
        action: "concentration_cap",
        side: "sell",
        qty: r.qty,
        price: r.price,
        status: r.status,
        detail: `trimmed from ${weight.toFixed(1)}% toward the ${cap}% cap`,
      });
    } catch (e) {
      out.push({
        symbol: p.symbol,
        action: "none",
        detail: `concentration trim failed: ${(e as Error).message}`,
      });
    }
  }
  return out;
}
