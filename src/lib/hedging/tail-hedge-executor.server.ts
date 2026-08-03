// Tail-hedge executor (Phase 6).
//
// `computeTailHedge` returns an *advisory* target notional. This module turns
// that advisory into concrete order-book effects.
//
// Paper / backtest portfolios:  the returned ExecutedTrade is appended and
// `holdingsByS` + `workingCash` are mutated in place so the trades/holdings
// writer in `runDailyTick` persists the hedge alongside every other fill.
//
// Live (live_sim / live_prod) portfolios: we still emit the ExecutedTrade so
// `routeOrdersToBroker` submits the hedge order to Saxo alongside every other
// live order, but we DO NOT mutate holdingsByS/workingCash — the broker is
// authoritative and `live-holdings-sync` reconciles the local mirror after
// routing. Sizing preserves the same no-leverage/no-borrow constraints as
// paper: buys are capped at available cash minus a safety buffer, sells are
// capped at the current held quantity.
//
// Instrument choice: cash-only accounts can't buy SPY puts, so we proxy the
// tail hedge with a physically-backed gold ETC/ETF that already sits in the
// universe. Callers can override per portfolio via `hedgeSymbol`.

import type { Database } from "@/integrations/supabase/types";
import type { TailHedgeDecision } from "./tail-hedge";
import { findSymbol } from "@/lib/universe.server";
import { engineSymbolKey, priceSymbolVariants } from "@/lib/price-symbol";
import { holdingAvgCostBase } from "@/lib/market-price-units";
import { isSymbolBlocked } from "@/lib/broker-instrument-blocks";
import { hedgeCandidatesFor, selectHedgeInstrument } from "./hedge-instrument-fallback";

import type { ExecutedTrade } from "@/lib/trading-engine.server";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

export function defaultHedgeSymbolFor(currency: string): string {
  const c = (currency || "GBP").toUpperCase();
  if (c === "USD") return "GLD";
  if (c === "EUR") return "SGLN.L"; // LSE gold ETC quotes in GBp/USD, still Saxo-tradable
  return "SGLN.L";
}

/** Quantities below this are dust — not worth a ticket, and not a blocker. */
const DUST_QTY = 1e-8;
/** Smallest notional worth booking as a hedge leg. */
const MIN_TICKET_NOTIONAL = 1;

/**
 * Look a holding up tolerantly.
 *
 * `holdingsByS` is keyed canonically by the engine, but a hedge position can
 * arrive from a broker sync spelled "SGLN:xlon" while the hedge symbol is
 * "SGLN.L". A raw `.get(symbol)` missed those and reported "no SGLN.L to
 * unwind" while the position was sitting right there — a correct trim
 * suppressed by a lookup, not by risk.
 */
function findHolding(
  holdingsByS: Map<string, Holding>,
  symbol: string,
): { key: string; holding: Holding } | null {
  const direct = holdingsByS.get(symbol);
  if (direct) return { key: symbol, holding: direct };
  for (const variant of [symbol, ...priceSymbolVariants(symbol)]) {
    for (const key of [variant, variant.toUpperCase(), variant.toLowerCase(), engineSymbolKey(variant)]) {
      const h = holdingsByS.get(key);
      if (h) return { key, holding: h };
    }
  }
  // Last resort: canonical-vs-canonical scan, which catches broker-native
  // spellings the variant list doesn't enumerate.
  const want = engineSymbolKey(symbol);
  for (const [key, h] of holdingsByS) {
    if (engineSymbolKey(key) === want || engineSymbolKey(h.symbol) === want) {
      return { key, holding: h };
    }
  }
  return null;
}

/** Resolve a hedge price tolerantly across symbol spellings. */
function findPrice(priceMap: Map<string, number>, symbol: string): number | null {
  for (const variant of [symbol, ...priceSymbolVariants(symbol)]) {
    for (const key of [variant, variant.toUpperCase(), variant.toLowerCase()]) {
      const p = priceMap.get(key);
      if (p != null && Number.isFinite(p) && p > 0) return p;
    }
  }
  return null;
}

export type TailHedgeExecInputs = {
  decision: TailHedgeDecision;
  holdingsByS: Map<string, Holding>;
  workingCash: number;
  priceMap: Map<string, number>;
  portfolioId: string;
  portfolioCurrency: string;
  isLivePortfolio: boolean;
  hedgeSymbol?: string | null;
  /**
   * Symbols the broker permanently refuses on this account (e.g. Saxo
   * suitability test not taken for gold ETCs). Blocks BUYs only — unwinding
   * an existing hedge must always stay possible.
   */
  blockedSymbols?: string[];
  cashBufferPct?: number; // fraction of cash to keep as safety, default 1%

};

export type TailHedgeExecResult = {
  applied: boolean;
  workingCash: number;
  trade?: ExecutedTrade;
  reason: string;
  symbol: string | null;
  qty: number;
  notional: number;
  /** True when the leg executed smaller than advised but still executed. */
  partial?: boolean;
  /** Set when the executor had to size off a stale/cost-basis price. */
  priceSource?: "live" | "avg_cost";
  /**
   * Audit record of instrument selection, emitted whenever the primary hedge
   * wrapper could not be used (substituted, or no substitute found).
   */
  fallback?: HedgeFallbackAudit;
};

/** One auditable hedge-instrument fallback event. */
export type HedgeFallbackAudit = {
  side: "buy" | "sell";
  /** The wrapper we intended to trade (override or currency default). */
  primarySymbol: string;
  /** The substitute actually selected, or null when none qualified. */
  chosenSymbol: string | null;
  /** Machine reason the primary was rejected. */
  reasonCode:
    | "broker_block"
    | "no_live_price"
    | "not_in_universe"
    | "nothing_held"
    | "ineligible"
    | "no_eligible_candidate";
  /** Human-readable explanation, including the full candidate ladder verdict. */
  reasonDetail: string;
  /** Every candidate that was rejected, with its reason. */
  candidates: Array<{ symbol: string; reason: string }>;
  targetNotional: number;
};

function classifyRejection(reason: string | undefined): HedgeFallbackAudit["reasonCode"] {
  if (!reason) return "ineligible";
  if (reason.includes("broker block")) return "broker_block";
  if (reason.includes("no live price")) return "no_live_price";
  if (reason.includes("not in universe")) return "not_in_universe";
  if (reason.includes("nothing held")) return "nothing_held";
  return "ineligible";
}

export function applyTailHedgeToPaperPortfolio(
  input: TailHedgeExecInputs,
): TailHedgeExecResult {
  const sink: { audit?: HedgeFallbackAudit } = {};
  const result = applyTailHedgeCore(input, sink);
  return sink.audit ? { ...result, fallback: sink.audit } : result;
}

function applyTailHedgeCore(
  input: TailHedgeExecInputs,
  sink: { audit?: HedgeFallbackAudit },
): TailHedgeExecResult {
  const { decision, holdingsByS, priceMap, portfolioId, portfolioCurrency, isLivePortfolio } = input;
  let { workingCash } = input;
  const bufferPct = input.cashBufferPct ?? 0.01;



  const base = {
    applied: false as boolean,
    workingCash,
    symbol: null as string | null,
    qty: 0,
    notional: 0,
  };

  if (decision.action === "hold" || Math.abs(decision.deltaNotional) < MIN_TICKET_NOTIONAL) {
    return { ...base, reason: `hold: ${decision.reason}` };
  }

  // Instrument selection with fallback: if the default gold wrapper is blocked
  // by the broker (Saxo ETC suitability) we hedge with an equivalent gold
  // ETC/ETF instead of dropping the hedge entirely. An explicit per-portfolio
  // `hedgeSymbol` override is honoured verbatim — the caller picked that
  // instrument deliberately, so we never silently substitute for it.
  const blocked = input.blockedSymbols ?? [];
  const override = (input.hedgeSymbol ?? "").trim();
  const primary = override || defaultHedgeSymbolFor(portfolioCurrency);
  const candidates = override ? [override] : hedgeCandidatesFor(portfolioCurrency);
  const selection = selectHedgeInstrument({
    candidates,
    side: decision.action === "buy" ? "buy" : "sell",
    eligibility: {
      isKnown: (s: string) => findSymbol(s) != null,
      hasPrice: (s: string) => findPrice(priceMap, s) != null,
      isBlocked: (s: string) => blocked.length > 0 && isSymbolBlocked(s, blocked),
      isHeld: (s: string) => {
        const h = findHolding(holdingsByS, s);
        return h != null && Number(h.holding.quantity) > DUST_QTY;
      },
    },
  });

  // Audit every non-trivial instrument selection: either we substituted away
  // from the primary wrapper, or nothing qualified at all. Both are decisions
  // the operator must be able to reconstruct later.
  {
    const primaryReason = selection.rejected.find(
      (r) => r.symbol.toUpperCase() === primary.toUpperCase(),
    )?.reason;
    if (selection.fallbackFrom != null || selection.symbol == null) {
      sink.audit = {
        side: decision.action === "buy" ? "buy" : "sell",
        primarySymbol: primary,
        chosenSymbol: selection.symbol,
        reasonCode:
          selection.symbol == null && primaryReason == null
            ? "no_eligible_candidate"
            : classifyRejection(primaryReason),
        reasonDetail: selection.note.trim() ||
          `${primary} unusable (${primaryReason ?? "ineligible"})`,
        candidates: selection.rejected,
        targetNotional: Math.abs(decision.deltaNotional),
      };
    }
  }

  // No substitute qualified. Fall through on the primary so the existing,
  // more specific diagnostics ("no price for X", "no X to unwind",

  // "insufficient cash") still apply — unless the primary itself is blocked,
  // where buying is genuinely pointless.
  const symbol = selection.symbol ?? primary;
  const meta = findSymbol(symbol);
  if (!meta) return { ...base, reason: `unknown hedge symbol ${symbol}` };

  if (
    decision.action === "buy" &&
    blocked.length > 0 &&
    isSymbolBlocked(symbol, blocked)
  ) {
    return {
      ...base,
      symbol,
      reason: `hedge buy skipped: broker blocks ${symbol} on this account (suitability/permissions) and no eligible gold substitute is available`,
    };
  }


  const found = findHolding(holdingsByS, symbol);
  const livePrice = findPrice(priceMap, symbol);

  // A SELL only needs a price to *size* the unwind. When the quote is missing
  // we can still safely reduce risk using the position's own cost basis, so
  // reducing exposure is never blocked by a data gap. A BUY genuinely needs a
  // live quote — spending cash on a stale mark is not "safe execution".
  let price = livePrice;
  let priceSource: "live" | "avg_cost" = "live";
  if (price == null && decision.action === "sell" && found) {
    const fallback = holdingAvgCostBase(found.holding.symbol, found.holding.avg_cost);
    if (Number.isFinite(fallback) && fallback > 0) {
      price = fallback;
      priceSource = "avg_cost";
    }
  }
  if (price == null || price <= 0) {
    return { ...base, symbol, reason: `no price for ${symbol}` };
  }
  const fallbackNote = selection.note;

  const executedAt = new Date().toISOString();

  // Shared no-leverage / no-borrow sizing. For BOTH paper and live modes:
  //   buy  → capped at workingCash * (1 - buffer) (cash-only, never borrow)
  //   sell → capped at current holdings quantity (never short)
  // For live portfolios we additionally do NOT mutate holdingsByS/workingCash;
  // the broker is authoritative and live-holdings-sync reconciles the mirror
  // after routeOrdersToBroker submits the resulting ExecutedTrade to Saxo.
  const mutateLocalState = !isLivePortfolio;

  if (decision.action === "buy") {
    // Shared sizing rule (see tail-hedge-sizing.ts) so the Phase 6 backtest
    // runner and this executor can never disagree about affordability.
    const sized = sizeHedgeBuy({
      deltaNotional: decision.deltaNotional,
      cash: workingCash,
      price,
      bufferPct,
      wholeShares: isLivePortfolio,
    });
    if (!sized.ok) {
      return { ...base, symbol, reason: `insufficient cash for 1 share of ${symbol}` };
    }
    const { qty, partial } = sized;


    if (mutateLocalState) {
      workingCash -= qty * price;
      const key = found?.key ?? engineSymbolKey(symbol);
      const cur = found?.holding;
      if (cur) {
        const newQty = Number(cur.quantity) + qty;
        const newCost = (Number(cur.avg_cost) * Number(cur.quantity) + qty * price) / newQty;
        const curHwm = Number(
          (cur as unknown as { high_water_mark?: number | null }).high_water_mark ?? Number(cur.avg_cost),
        );
        holdingsByS.set(key, {
          ...cur,
          quantity: newQty,
          avg_cost: newCost,
          high_water_mark: Math.max(curHwm, price),
        } as Holding);
      } else {
        holdingsByS.set(key, {
          id: crypto.randomUUID(),
          portfolio_id: portfolioId,
          symbol,
          asset_class: meta.asset_class,
          quantity: qty,
          avg_cost: price,
          updated_at: executedAt,
          opened_at: executedAt,
          high_water_mark: price,
        } as Holding);
      }
    }

    const routingNote = isLivePortfolio ? " [live: routed via broker executor]" : "";
    const partialNote = partial ? " [partial: cash-capped]" : "";
    const trade: ExecutedTrade = {
      symbol, side: "buy", quantity: qty, price, value: qty * price,
      reason: `tail_hedge buy → target ${(decision.targetPctNav * 100).toFixed(2)}% NAV (${decision.reason})${partialNote}${fallbackNote}${routingNote}`,
    };
    return {
      applied: true, workingCash, symbol, qty, notional: qty * price,
      trade, reason: trade.reason, partial, priceSource,
    };
  }

  // action === "sell": unwind up to |delta| notional of the existing hedge.
  // No-borrow: never sell more than the current held quantity (mirrored from
  // broker for live modes by live-holdings-sync).
  //
  // Gating principle for reductions: a de-risking trim is only suppressed when
  // there is genuinely nothing to sell. Anything the position *can* support —
  // a smaller-than-advised clip, an odd lot, a stale quote — executes at the
  // safe size rather than being dropped.
  if (!found || Number(found.holding.quantity) <= DUST_QTY) {
    return { ...base, symbol, reason: `no ${symbol} to unwind` };
  }
  const heldQty = Number(found.holding.quantity);
  const sized = sizeHedgeSell({
    deltaNotional: decision.deltaNotional,
    heldQty,
    price,
    wholeShares: isLivePortfolio,
  });
  if (!sized.ok) return { ...base, symbol, reason: "computed sell qty is zero" };
  const { qty, partial } = sized;


  if (mutateLocalState) {
    const remaining = heldQty - qty;
    workingCash += qty * price;
    if (remaining <= DUST_QTY) holdingsByS.delete(found.key);
    else holdingsByS.set(found.key, { ...found.holding, quantity: remaining } as Holding);
  }

  const routingNote = isLivePortfolio ? " [live: routed via broker executor]" : "";
  const partialNote = partial ? " [partial: position-capped]" : "";
  const priceNote = priceSource === "avg_cost" ? " [sized off cost basis — no live quote]" : "";
  const trade: ExecutedTrade = {
    symbol, side: "sell", quantity: qty, price, value: qty * price,
    reason: `tail_hedge sell → target ${(decision.targetPctNav * 100).toFixed(2)}% NAV (${decision.reason})${partialNote}${priceNote}${fallbackNote}${routingNote}`,
  };
  return {
    applied: true, workingCash, symbol, qty, notional: qty * price,
    trade, reason: trade.reason, partial, priceSource,
  };
}

