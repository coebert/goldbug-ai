// Records every AI trading decision (buy / sell / hold) into the
// ai_decision_audit table so the whole "why did the model do this?" chain is
// reconstructible after the fact: the symbol, requested quantity + price, the
// market inputs the model considered, the linked broker order id, and the
// outcome (placed / filled / rejected / skipped / hold).
//
// Called from src/lib/trading-engine.server.ts after the decision is
// persisted and (for live modes) after orders have been routed to the broker,
// so we can attach live_orders.id in the same insert. A DB trigger on
// live_orders then keeps `outcome` in sync as the broker updates status.
//
// All writes go through service_role: the table exposes only owner-read RLS
// to authenticated users.

import { asJson } from "@/lib/_server/db-json";
import type { Database } from "@/integrations/supabase/types";

type AuditInsert = Database["public"]["Tables"]["ai_decision_audit"]["Insert"];


export interface ExecutedAuditEntry {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value?: number;
  reason?: string;
  rejected?: string;
  instrument_ccy?: string;
}

export interface HoldingAuditEntry {
  symbol: string;
  quantity: number;
  asset_class?: string | null;
  instrument_ccy?: string | null;
}

export interface AuditContext {
  portfolioId: string;
  userId: string;
  decisionId: string | null;
  runDate: string;               // YYYY-MM-DD
  model: string;                 // e.g. "google/gemini-2.5-flash"
  executed: ExecutedAuditEntry[]; // buy/sell attempts (may be rejected)
  /** Portfolio mode. In live modes a missing live_orders row means the ticket never routed. */
  mode?: string | null;
  heldAfter: HoldingAuditEntry[]; // holdings remaining after sells → 'hold' rows

  features: Record<string, unknown> | null | undefined; // per-symbol signal snapshot
  regime?: unknown;
  rationale?: string;            // AI rationale for the whole run
  /**
   * Per-symbol sector evidence captured at sizing time: cycle phase
   * (growing / stagnating / shrinking), the raw 30d/90d momentum readings and
   * the exact sizing multiplier that was applied to the ticket.
   */
  sectorBySymbol?: Record<string, unknown> | null;
  /**
   * Per-symbol breakout gate evidence: the (cohort x regime) expectancy cell,
   * the volatility inputs that were read, the signal-age band, and the exact
   * skip / downsize reason applied to the ticket.
   */
  breakoutBySymbol?: Record<string, unknown> | null;
}

// Classify the source of a buy/sell into a coarse bucket so consumers can
// filter (AI-directed vs risk-driven exits vs hedging).
function classifySource(entry: ExecutedAuditEntry): string {
  const r = (entry.reason ?? "").toLowerCase();
  if (!r) return "ai_decision";
  if (r.includes("tail") || r.includes("hedge")) return "tail_hedge";
  if (r.includes("stop") || r.includes("trail") || r.includes("take-profit")
      || r.includes("take_profit") || r.includes("max-hold") || r.includes("max_hold")
      || r.includes("time-exit") || r.includes("blackout")) return "risk_exit";
  if (r.includes("crypto")) return "crypto_sleeve";
  if (r.includes("fx")) return "fx_intent";
  return "ai_decision";
}

function outcomeFor(
  entry: ExecutedAuditEntry,
  orderId: string | null,
  isLive: boolean,
): {
  outcome: string;
  detail: string | null;
} {
  if (entry.rejected) return { outcome: "skipped", detail: entry.rejected };
  // If we placed an order we mark 'placed' as the initial state; the
  // live_orders trigger will advance it to filled / rejected / etc.
  if (orderId) return { outcome: "placed", detail: null };
  // LIVE modes ALWAYS create a live_orders row for a routed ticket. No row
  // means the ticket never reached the broker (routing threw, the POST was
  // lost, or the order write failed) — recording "placed" here is what made
  // the daily report claim buys that never happened. Record the truth.
  if (isLive) {
    return {
      outcome: "error",
      detail: "no broker order was recorded for this ticket — it did not reach the broker",
    };
  }
  // Paper / backtest runs never create a live_orders row but the trade did
  // execute against the simulator — still "placed" (immediately filled at
  // the same price).
  return { outcome: "placed", detail: null };
}


function outcomeForOrderStatus(status: string | null | undefined, detail: string | null | undefined): {
  outcome: string;
  detail: string | null;
} | null {
  switch ((status ?? "").toLowerCase()) {
    case "filled":
      return { outcome: "filled", detail: detail ?? null };
    case "partial":
    case "partially_filled":
      return { outcome: "partial", detail: detail ?? null };
    case "rejected":
      return { outcome: "rejected", detail: detail ?? null };
    case "cancelled":
    case "canceled":
      return { outcome: "cancelled", detail: detail ?? null };
    case "error":
      return { outcome: "error", detail: detail ?? null };
    case "pending":
    case "working":
    case "submitted":
    case "accepted":
      return { outcome: "placed", detail: detail ?? null };
    default:
      return null;
  }
}

export async function recordAiDecisionAudit(ctx: AuditContext): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Fetch live_orders created for this decision so we can attach their ids.
  // Match on (symbol, side); Saxo's client_order_id is deterministic per
  // (portfolio, date, symbol, side) so there's exactly one row per pair.
  const orderIdMap = new Map<string, string>();
  const orderStatusMap = new Map<string, { status: string | null; rejectReason: string | null }>();
  if (ctx.decisionId) {
    const { data: orders } = await supabaseAdmin
      .from("live_orders")
      .select("id, symbol, side, status, reject_reason")
      .eq("portfolio_id", ctx.portfolioId)
      .eq("decision_id", ctx.decisionId);
    for (const o of orders ?? []) {
      const key = `${String(o.symbol).toUpperCase()}|${o.side}`;
      orderIdMap.set(key, o.id as string);
      orderStatusMap.set(key, {
        status: (o.status as string | null) ?? null,
        rejectReason: (o.reject_reason as string | null) ?? null,
      });
    }
  }

  const now = new Date().toISOString();
  // The engine passes its candidate-feature ARRAY here; older callers pass a
  // symbol map. Normalise to a map or every per-symbol feature block (and the
  // price levels derived from it) comes out null.
  const rawFeatures = ctx.features ?? {};
  const features: Record<string, unknown> = Array.isArray(rawFeatures)
    ? Object.fromEntries(
        (rawFeatures as unknown[])
          .map((f) => {
            const sym = String((f as Record<string, unknown> | null)?.["symbol"] ?? "").toUpperCase();
            return sym ? ([sym, f] as const) : null;
          })
          .filter((e): e is readonly [string, unknown] => e !== null),
      )
    : (rawFeatures as Record<string, unknown>);
  const regimeSlim = ctx.regime ?? null;

  const sectorMap = ctx.sectorBySymbol ?? {};
  const sectorFor = (sym: string) => sectorMap[sym] ?? null;

  const breakoutMap = ctx.breakoutBySymbol ?? {};
  const breakoutFor = (sym: string) => breakoutMap[sym] ?? null;

  const rows: AuditInsert[] = [];

  const sellSymbols = new Set<string>();

  for (const e of ctx.executed) {
    const sym = String(e.symbol ?? "").toUpperCase();
    if (!sym) continue;
    const key = `${sym}|${e.side}`;
    const orderId = orderIdMap.get(key) ?? null;
    const orderOutcome = orderStatusMap.has(key)
      ? outcomeForOrderStatus(orderStatusMap.get(key)?.status, orderStatusMap.get(key)?.rejectReason)
      : null;
    const isLive = String(ctx.mode ?? "").startsWith("live");
    const { outcome, detail } = orderOutcome ?? outcomeFor(e, orderId, isLive);

    const source = classifySource(e);
    if (e.side === "sell") sellSymbols.add(sym);
    const featureBlock = (features as Record<string, unknown>)[sym] ?? null;
    rows.push({
      decision_id: ctx.decisionId,
      portfolio_id: ctx.portfolioId,
      user_id: ctx.userId,
      run_date: ctx.runDate,
      decided_at: now,
      symbol: sym,
      asset_class: null,
      action: e.side,
      source,
      model: ctx.model,
      requested_quantity: Number.isFinite(e.quantity) ? e.quantity : 0,
      price: Number.isFinite(e.price) ? e.price : null,
      notional: Number.isFinite(e.value)
        ? e.value
        : Number.isFinite(e.quantity * e.price)
          ? Number((e.quantity * e.price).toFixed(2))
          : null,
      instrument_ccy: e.instrument_ccy ?? null,
      rationale: e.reason ?? ctx.rationale ?? null,
      market_inputs: asJson({
        features: featureBlock,
        regime: regimeSlim,
        sector: sectorFor(sym),
        breakout: breakoutFor(sym),
        run_rationale: ctx.rationale ?? null,
      }),
      order_id: orderId,
      outcome,
      outcome_detail: detail,
      outcome_at: outcome === "placed" ? now : null,
    });
  }

  // Emit a 'hold' row for every still-held position we did NOT sell this
  // tick — that's the "did nothing / kept holding" audit trail.
  for (const h of ctx.heldAfter) {
    const sym = String(h.symbol ?? "").toUpperCase();
    if (!sym || sellSymbols.has(sym)) continue;
    if (!(Number(h.quantity) > 0)) continue;
    const featureBlock = (features as Record<string, unknown>)[sym] ?? null;
    rows.push({
      decision_id: ctx.decisionId,
      portfolio_id: ctx.portfolioId,
      user_id: ctx.userId,
      run_date: ctx.runDate,
      decided_at: now,
      symbol: sym,
      asset_class: h.asset_class ?? null,
      action: "hold",
      source: "ai_decision",
      model: ctx.model,
      requested_quantity: Number(h.quantity),
      price: null,
      notional: null,
      instrument_ccy: h.instrument_ccy ?? null,
      rationale: ctx.rationale ?? null,
      market_inputs: asJson({
        features: featureBlock,
        regime: regimeSlim,
        sector: sectorFor(sym),
        run_rationale: ctx.rationale ?? null,
      }),
      order_id: null,
      outcome: "hold",
      outcome_detail: null,
      outcome_at: now,
    });
  }

  if (rows.length === 0) return;

  const { error } = await supabaseAdmin.from("ai_decision_audit").insert(rows);
  if (error) {
    // Never fail the trading tick because of an audit-log write failure —
    // just surface it. The DB trigger will still keep outcomes in sync
    // once the initial insert eventually lands (retried next tick).
    console.warn("ai_decision_audit insert failed:", error.message);
  }
}
