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
import type { FeeSyncStatus } from "./fee-sync-status";
import { convertAmount } from "./fx.server";
import { convertChargeLegs, matchChargesToFills, type IngestFill } from "./broker-cost-ingest";
import {
  checkChargeUnits,
  summariseUnitChecks,
  type UnitCheckResult,
} from "./valuation/unit-validation";
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
  /** Charges held back because their pence/pound unit could not be trusted. */
  unitMismatches: number;
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
    unitMismatches: 0,
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

/**
 * Stamp why a fill is (or isn't) broker-priced. Written on every pass so the
 * card can distinguish "the broker hasn't published this yet" from "we asked
 * and nothing came back", instead of showing one undifferentiated gap.
 */
async function markFeeSync(args: {
  fillIds: readonly string[];
  status: FeeSyncStatus;
  reason: string | null;
  attemptedAt: string;
}): Promise<void> {
  if (args.fillIds.length === 0) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  for (let i = 0; i < args.fillIds.length; i += 200) {
    const batch = args.fillIds.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("live_fills")
      .update({
        fee_sync_status: args.status,
        fee_sync_reason: args.reason,
        fee_sync_attempted_at: args.attemptedAt,
      })
      .in("id", batch);
    if (error) log.warn("failed to stamp fee sync status", { status: args.status, error: error.message });
  }
}

/**
 * A fill placed in the last day has simply not been invoiced yet; older ones
 * that still have no charge are a genuine matching gap worth surfacing.
 */
const PENDING_GRACE_MS = 36 * 3_600_000;

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
    await markFeeSync({
      fillIds: fills.map((f) => f.id),
      status: "pending",
      reason: `cost report unavailable: ${e instanceof Error ? e.message : String(e)}`,
      attemptedAt: now.toISOString(),
    });
    return empty({
      fillsConsidered: fills.length,
      unmatchedFills: fills.length,
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  if (!report.supported) {
    await markFeeSync({
      fillIds: fills.map((f) => f.id),
      status: "unsupported",
      reason: report.reason ?? "broker publishes no cost report for this account",
      attemptedAt: now.toISOString(),
    });
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
  const unitChecks: UnitCheckResult[] = [];
  const baseCcy = fills[0]?.currency ?? "GBP";

  for (const u of match.updates) {
    const fill = fillById.get(u.fillId);
    if (!fill) continue;
    const target = fill.currency || "GBP";
    // Unit gate. A charge whose scale contradicts the trade it belongs to is
    // never written: a single pence-as-pounds fee would flow straight into the
    // cash line and the friction KPI the kernel values the book from.
    const unitCheck = checkChargeUnits({
      id: u.fillId,
      symbol: fill.symbol,
      quantity: fill.quantity,
      fillPrice: fill.fillPrice,
      fillCurrency: fill.currency,
      chargeTotal: u.total,
      chargeCurrency: u.currency,
    });
    unitChecks.push(unitCheck);
    if (unitCheck.blocked) {
      log.warn("charge held on unit check", {
        fillId: u.fillId,
        symbol: fill.symbol,
        chargeCurrency: u.currency,
        fillCurrency: fill.currency,
        reason: unitCheck.reason,
      });
      const held = await supabaseAdmin
        .from("live_fills")
        .update({
          fee_sync_status: "unit_mismatch",
          fee_sync_reason: unitCheck.reason,
          fee_sync_attempted_at: now.toISOString(),
          broker_trade_id: u.brokerTradeId,
        })
        .eq("id", u.fillId);
      if (held.error) {
        // A held charge that fails to record its status looks identical to a
        // normally synced fill in the UI, so never let this pass quietly.
        log.error("failed to record unit-mismatch hold", {
          fillId: u.fillId,
          error: held.error.message,
        });
      }
      continue;

    }

    const legs = await convertChargeLegs(u, target, convertLeg);
    const total = legs.total;

    // A matched charge line with no money on it means Saxo has not billed the
    // trade yet — it is NOT evidence that the trade was free. Overwriting the
    // modelled fee with 0 here is how every row in live_fills came to read
    // zero commission on a real-money account. Leave the modelled fee alone
    // and keep the fill queued for a later sync.
    if (!(total > 0)) {
      // Log the column names Saxo actually sent. A zero here is almost always
      // a schema we do not read yet, and without the key list every tick just
      // repeats "zero charges" with nothing to act on.
      const raw = (u as { raw?: unknown }).raw;
      if (raw && typeof raw === "object") {
        log.warn("matched charge row carried no money", {
          fillId: u.fillId,
          symbol: fill.symbol,
          brokerTradeId: u.brokerTradeId,
          rowKeys: Object.keys(raw as Record<string, unknown>).sort(),
        });
      }
      await supabaseAdmin
        .from("live_fills")
        .update({
          fee_sync_status: "pending",
          fee_sync_reason: "broker charge report returned zero charges for this trade",
          fee_sync_attempted_at: now.toISOString(),
          broker_trade_id: u.brokerTradeId,
          // A zero fee stamped `broker` reads downstream as "the broker says
          // this trade was free". It was not billed yet: keep it modelled.
          ...(fill.feeSource === "broker" ? { fee_source: "none" } : {}),
        })
        .eq("id", u.fillId);
      continue;
    }

    const { error } = await supabaseAdmin
      .from("live_fills")
      .update({
        fee: total,
        fee_commission: legs.commission,
        fee_exchange: legs.exchangeFee,
        fee_tax: legs.tax,
        fee_other: legs.other,
        fee_source: "broker",
        fee_sync_status: "invoiced",
        fee_sync_reason: null,
        fee_synced_at: now.toISOString(),
        fee_sync_attempted_at: now.toISOString(),
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

  // Everything the report did not cover: recent fills are simply not billed
  // yet, older ones are a real gap.
  const nowMs = now.getTime();
  const stillMissing = match.unmatchedFillIds
    .map((id) => fillById.get(id))
    .filter((f): f is IngestFill => !!f);
  const pending = stillMissing.filter((f) => nowMs - Date.parse(f.filledAt) < PENDING_GRACE_MS);
  const unmatched = stillMissing.filter((f) => !pending.includes(f));
  await markFeeSync({
    fillIds: pending.map((f) => f.id),
    status: "pending",
    reason: "broker has not published charges for this trade yet",
    attemptedAt: now.toISOString(),
  });
  await markFeeSync({
    fillIds: unmatched.map((f) => f.id),
    status: "unmatched",
    reason: "no charge in the broker report matched this trade",
    attemptedAt: now.toISOString(),
  });

  const unitSummary = summariseUnitChecks(unitChecks);
  if (unitSummary.blocked > 0 || unitSummary.rescaled > 0) {
    log.info("charge unit validation", {
      portfolioId: args.portfolioId,
      checked: unitSummary.checked,
      rescaled: unitSummary.rescaled,
      blocked: unitSummary.blocked,
      blockedIds: unitSummary.blockedIds,
      byCode: unitSummary.byCode,
    });
  }

  return {
    supported: true,
    ...(report.endpoint !== undefined ? { endpoint: report.endpoint } : {}),
    fillsConsidered: fills.length,
    chargesFetched: report.charges.length,
    fillsUpdated: updated,
    unmatchedCharges: match.unmatchedTradeIds.length,
    unmatchedFills: match.unmatchedFillIds.length,
    unitMismatches: unitSummary.blocked,
    chargedTotal,
    currency: baseCcy,
  };
}
