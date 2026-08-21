// Loader for automatic execution assumptions.
//
// Pulls the three evidence streams `deriveAutoAssumptions` wants — calibrated
// spreads from `price_cache` bars, invoiced fees from `live_fills`, and
// order-vs-fill slippage — and caches the result briefly so a page rendering
// several backtest cards does not re-query per card.
//
// Never throws: if the database is unavailable the caller still gets a sane
// `realistic` assumption set with a basis note saying why.

import type { FeeScheduleDefaults } from "./fee-schedule-import";
import { calibrateSymbolExecution } from "../execution-calibration-from-bars";
import { estimateTradeCosts } from "../trade-viability-gate";
import { priceSymbolVariants } from "../price-symbol";
import {
  deriveAutoAssumptions,
  type AutoAssumptionResult,
  type FeeSample,
  type SlippageSample,
  type SpreadSample,
} from "./auto-assumptions";

export type LoadAutoAssumptionsOptions = {
  /** Restrict fee/slippage evidence to one portfolio. */
  portfolioId?: string | null;
  /** Extra symbols to calibrate beyond the ones we have traded. */
  symbols?: readonly string[];
  /** Trailing window for fills. Default 365 days. */
  fillLookbackDays?: number;
  /** Trailing window for bars. Default 400 days. */
  barLookbackDays?: number;
  /** Skip the cache. */
  fresh?: boolean;
  /**
   * Optional imported broker fee schedule (raw JSON/CSV paste or already
   * parsed defaults). Sets fees, stamp duty and levies when we lack invoiced
   * tickets to measure them from.
   */
  feeSchedule?: unknown;
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_SYMBOLS = 25;

let cache: { key: string; at: number; value: AutoAssumptionResult } | null = null;

const daysAgoIso = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString();

const dateAgo = (days: number): string => daysAgoIso(days).slice(0, 10);

export async function loadAutoAssumptions(
  opts: LoadAutoAssumptionsOptions = {},
): Promise<AutoAssumptionResult> {
  const key = JSON.stringify([
    opts.portfolioId ?? null,
    [...(opts.symbols ?? [])].sort(),
    opts.fillLookbackDays ?? 365,
    opts.barLookbackDays ?? 400,
    opts.feeSchedule ? JSON.stringify(opts.feeSchedule) : null,
  ]);
  if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  let fees: FeeSample[] = [];
  let slippage: SlippageSample[] = [];
  let spreads: SpreadSample[] = [];

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let fillQuery = supabaseAdmin
      .from("live_fills")
      .select(
        "symbol, side, quantity, fill_price, fee, fee_commission, fee_tax, fee_source, order_id, filled_at",
      )
      .gte("filled_at", daysAgoIso(opts.fillLookbackDays ?? 365))
      .order("filled_at", { ascending: false })
      .limit(500);
    if (opts.portfolioId) fillQuery = fillQuery.eq("portfolio_id", opts.portfolioId);
    const { data: fillRows } = await fillQuery;
    const fills = fillRows ?? [];

    // Invoiced fees vs the model.
    for (const f of fills) {
      if (f.fee_source !== "broker") continue;
      const qty = Number(f.quantity);
      const price = Number(f.fill_price);
      if (!(qty > 0) || !(price > 0)) continue;
      const modelled = estimateTradeCosts({
        symbol: f.symbol,
        side: f.side === "sell" ? "sell" : "buy",
        quantity: qty,
        price,
        assetClass: null,
      });
      fees.push({
        notional: qty * price,
        invoicedCommission: Number(f.fee_commission ?? f.fee ?? 0),
        modelledCommission: modelled.commission,
        invoicedTax: f.fee_tax == null ? null : Number(f.fee_tax),
        modelledStamp: modelled.stampDuty,
      });
    }

    // Order-vs-fill slippage: the marketable limit we sent is the reference.
    const orderIds = [...new Set(fills.map((f) => f.order_id).filter(Boolean))].slice(0, 200);
    if (orderIds.length) {
      const { data: orderRows } = await supabaseAdmin
        .from("live_orders")
        .select("id, limit_price")
        .in("id", orderIds as string[]);
      const refById = new Map(
        (orderRows ?? [])
          .filter((o) => o.limit_price != null && Number(o.limit_price) > 0)
          .map((o) => [o.id as string, Number(o.limit_price)]),
      );
      for (const f of fills) {
        const ref = refById.get(f.order_id);
        const px = Number(f.fill_price);
        if (!ref || !(px > 0)) continue;
        slippage.push({
          symbol: f.symbol,
          side: f.side === "sell" ? "sell" : "buy",
          referencePrice: ref,
          fillPrice: px,
        });
      }
    }

    // Spread calibration from bars for everything we trade.
    const symbols = [
      ...new Set([...(opts.symbols ?? []), ...fills.map((f) => f.symbol)]),
    ].slice(0, MAX_SYMBOLS);
    const fromDate = dateAgo(opts.barLookbackDays ?? 400);
    for (const symbol of symbols) {
      const variants = priceSymbolVariants(symbol);
      let bars: { date: string; close: number; high: number | null; low: number | null; volume: number | null }[] = [];
      for (const variant of variants) {
        const { data } = await supabaseAdmin
          .from("price_cache")
          .select("price_date, high, low, close, volume")
          .eq("symbol", variant)
          .gte("price_date", fromDate)
          .order("price_date", { ascending: true });
        if (data && data.length >= 40) {
          bars = data
            .filter((r) => r.close != null)
            .map((r) => ({
              date: r.price_date as string,
              close: Number(r.close),
              high: r.high == null ? null : Number(r.high),
              low: r.low == null ? null : Number(r.low),
              volume: r.volume == null ? null : Number(r.volume),
            }));
          break;
        }
      }
      if (bars.length < 40) continue;
      const calib = calibrateSymbolExecution({ symbol, bars });
      spreads.push({
        symbol,
        fullSpreadBps: calib.halfSpreadBps * 2,
        sampleBars: calib.sampleBars,
        source: calib.spreadSource,
      });
    }
  } catch {
    fees = [];
    slippage = [];
    spreads = [];
  }

  let feeScheduleDefaults: FeeScheduleDefaults | null = null;
  if (opts.feeSchedule) {
    const { importFeeSchedule } = await import("./fee-schedule-import");
    feeScheduleDefaults = importFeeSchedule(opts.feeSchedule).defaults;
  }
  const value = deriveAutoAssumptions({
    spreads,
    fees,
    slippage,
    feeSchedule: feeScheduleDefaults,
  });
  cache = { key, at: Date.now(), value };
  return value;
}

/** Drop the memoised result (used by tests and manual refresh). */
export function clearAutoAssumptionsCache(): void {
  cache = null;
}
