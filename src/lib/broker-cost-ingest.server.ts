/**
 * Ingest booked broker charges onto `live_fills`.
 *
 * The friction KPI's whole claim is "this is what trading actually cost".
 * Until this ran, every `live_fills.fee` was 0 and the KPI fell back to our
 * own model — a plausibility check dressed up as evidence. This pulls Saxo's
 * cost/activity report, matches it to the fill tape, and writes the itemised
 * legs plus a `fee_source` marker so the card can be honest about which rows
 * are invoiced and which are still estimated.
 *
 * Idempotent by construction: a fill already tied to a broker trade id is
 * re-matched on that id, so restatements overwrite rather than accumulate.
 */

import { createLogger } from "@/lib/_server/log";
import { convertAmount } from "./fx.server";
import { convertChargeLegs, matchChargesToFills, type IngestFill } from "./broker-cost-ingest";
import type { BrokerAdapter, BrokerTradeCharge } from "./brokers/adapter";

const log = createLogger("broker-cost-ingest");

/** Default tape depth. Comfortably covers the KPI's 30d window plus restatements. */
export const COST_INGEST_LOOKBACK_DAYS = 45;

export type CostIngestResult = {
  supported: boolean;
  endpoint?: string | null;
  fillsConsidered: number;
  chargesFetched: number;
  fillsUpdated: number;
  /** Charges belonging to no fill we hold — manual trades, or another portfolio. */
  unmatchedCharges: number;
  /** Fills still on modelled costs after this pass. */
  unmatchedFills: number;
  /** Total charge written, in each fill's own currency, summed after FX. */
  chargedTotal: number;
  currency: string;
  reason?: string;
};

function empty(partial: Partial<CostIngestResult>): CostIngestResult {
  return {
    supported: false,
    fillsConsidered: 0,
    chargesFetched: 0,
    fillsUpdated: 0,
    unmatchedCharges: 0,
    unmatchedFills: 0,
    chargedTotal: 0,
    currency: "GBP",
    ...partial,
  };
}

async function convertLeg(amount: number, from: string, to: string): Promise<number> {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (from === to) return amount;
  try {
    const res = await convertAmount(amount, from, to);
    return Number.isFinite(res.amount) ? res.amount : amount;
  } catch {
    // An FX outage must not park the charge at zero — that would understate
    // friction, which is the one direction this number must never err in.
    return amount;
  }
}

export async function ingestBrokerCostsForPortfolio(args: {
  portfolioId: string;
  userId: string;
  adapter: Pick<BrokerAdapter, "getTradeCharges">;
  lookbackDays?: number;
  now?: Date;
}): Promise<CostIngestResult> {
  const now = args.now ?? new Date();
  const lookbackDays = args.lookbackDays ?? COST_INGEST_LOOKBACK_DAYS;
  const fromIso = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();
  const toIso = now.toISOString();

  if (typeof args.adapter.getTradeCharges !== "function") {
    return empty({ reason: "broker adapter exposes no cost report" });
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const fillRes = await supabaseAdmin
    .from("live_fills")
    .select("id, order_id, symbol, side, quantity, fill_price, currency, filled_at, broker_fill_id, broker_trade_id, fee_source")
    .eq("portfolio_id", args.portfolioId)
    .gte("filled_at", fromIso)
    .order("filled_at", { ascending: true })
    .limit(2000);

  const fillRows = (fillRes.data ?? []) as Array<Record<string, unknown>>;
  const fills: IngestFill[] = fillRows.map((r) => ({
    id: String(r["id"]),
    symbol: String(r["symbol"] ?? ""),
    side: String(r["side"] ?? "").toLowerCase() === "sell" ? "sell" : "buy",
    quantity: Number(r["quantity"] ?? 0),
    fillPrice: Number(r["fill_price"] ?? 0),
    currency: String(r["currency"] ?? "GBP").toUpperCase(),
    filledAt: String(r["filled_at"] ?? ""),
    brokerFillId: r["broker_fill_id"] ? String(r["broker_fill_id"]) : null,
    brokerTradeId: r["broker_trade_id"] ? String(r["broker_trade_id"]) : null,
    feeSource: r["fee_source"] ? String(r["fee_source"]) : null,
  }));

  if (fills.length === 0) {
    return empty({ supported: true, reason: "no fills in lookback window" });
  }

  // Our own client references, so a report that echoes ExternalReference can
  // be matched exactly instead of falling through to attribute matching.
  const orderIds = [...new Set(fillRows.map((r) => String(r["order_id"] ?? "")).filter(Boolean))];
  const clientOrderIdsByFill: Record<string, string | null> = {};
  if (orderIds.length > 0) {
    const ordRes = await supabaseAdmin
      .from("live_orders")
      .select("id, client_order_id")
      .in("id", orderIds);
    const refByOrder = new Map<string, string | null>();
    for (const o of (ordRes.data ?? []) as Array<Record<string, unknown>>) {
      refByOrder.set(String(o["id"]), o["client_order_id"] ? String(o["client_order_id"]) : null);
    }
    for (const r of fillRows) {
      clientOrderIdsByFill[String(r["id"])] = refByOrder.get(String(r["order_id"] ?? "")) ?? null;
    }
  }

  let report: { supported: boolean; charges: BrokerTradeCharge[]; endpoint?: string | null; reason?: string };
  try {
    report = await args.adapter.getTradeCharges({ fromIso, toIso });
  } catch (e) {
    return empty({
      fillsConsidered: fills.length,
      unmatchedFills: fills.length,
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  if (!report.supported) {
    return empty({
      fillsConsidered: fills.length,
      unmatchedFills: fills.length,
      ...(report.endpoint !== undefined ? { endpoint: report.endpoint } : {}),
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
    });
  }

  const match = matchChargesToFills({ fills, charges: report.charges, clientOrderIdsByFill });
  const fillById = new Map(fills.map((f) => [f.id, f]));

  let updated = 0;
  let chargedTotal = 0;
  const baseCcy = fills[0]?.currency ?? "GBP";

  for (const u of match.updates) {
    const fill = fillById.get(u.fillId);
    if (!fill) continue;
    const target = fill.currency || "GBP";
    const legs = await convertChargeLegs(u, target, convertLeg);
    const total = legs.total;

    const { error } = await supabaseAdmin
      .from("live_fills")
      .update({
        fee: total,
        fee_commission: legs.commission,
        fee_exchange: legs.exchangeFee,
        fee_tax: legs.tax,
        fee_other: legs.other,
        fee_source: "broker",
        fee_synced_at: now.toISOString(),
        broker_trade_id: u.brokerTradeId,
      })
      .eq("id", u.fillId);

    if (error) {
      log.warn("failed to write broker charge", { fillId: u.fillId, error: error.message });
      continue;
    }
    updated += 1;
    chargedTotal += await convertLeg(total, target, baseCcy);
  }

  return {
    supported: true,
    ...(report.endpoint !== undefined ? { endpoint: report.endpoint } : {}),
    fillsConsidered: fills.length,
    chargesFetched: report.charges.length,
    fillsUpdated: updated,
    unmatchedCharges: match.unmatchedTradeIds.length,
    unmatchedFills: match.unmatchedFillIds.length,
    chargedTotal,
    currency: baseCcy,
  };
}
