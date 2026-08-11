/**
 * Server-side loader for the Phase 4 friction KPI.
 *
 * Reads the realised fill tape and prices each fill twice: what the broker
 * booked, and what our model says it should have cost. Both numbers travel to
 * the client so the card can say "the broker charged X, we modelled Y" rather
 * than presenting one of them as truth.
 */

import { estimateTradeCosts } from "./trade-viability-gate";
import { convertAmount } from "./fx.server";
import {
  computeFrictionKpi,
  beforeAfterAttribution,
  realisedCostOverlay,
  frictionTimeSeries,
  frictionBreakdown,
  FRICTION_WINDOW_DAYS,
  type BeforeAfterAttribution,
  type FrictionBreakdown,
  type FrictionFill,
  type FrictionKpi,
  type RealisedCostOverlay,
  type FrictionSeriesPoint,
} from "./friction-kpi";

/**
 * When the Phase 1 cost governor (min ticket, friction budget, daily cap,
 * per-symbol cooldown) started gating live routing. Fills before this instant
 * are the ungoverned tape the plan was written against.
 */
export const COST_GOVERNOR_CUTOVER_ISO = "2026-08-11T00:00:00.000Z";

/** How much tape the before/after split looks at. Long enough to have a "before". */
const ATTRIBUTION_DAYS = 90;

export type FrictionReport = {
  kpi: FrictionKpi;
  /**
   * Trailing-30d friction for each of the last 90 calendar days. The card
   * slices this to 30 or 90 days client-side, so switching range is instant
   * and cannot disagree with the headline number.
   */
  series: FrictionSeriesPoint[];
  /** Days of history the series covers. */
  seriesDays: number;
  attribution: BeforeAfterAttribution;
  overlay: RealisedCostOverlay;
  currency: string;
  asOf: string;
};

type DbClient = { from: (t: string) => any };

async function makeConverter(baseCcy: string) {
  const cache = new Map<string, number>();
  return async (amount: number, ccy: string): Promise<number> => {
    const from = (ccy || baseCcy).toUpperCase();
    if (!Number.isFinite(amount) || amount === 0) return 0;
    if (from === baseCcy) return amount;
    let rate = cache.get(from);
    if (rate === undefined) {
      try {
        const res = await convertAmount(1, from, baseCcy);
        rate = Number.isFinite(res.amount) && res.amount > 0 ? res.amount : 1;
      } catch {
        rate = 1;
      }
      cache.set(from, rate);
    }
    return amount * rate;
  };
}

export async function loadFrictionReport(args: {
  db: DbClient;
  portfolioId: string;
  baseCcy?: string;
  windowDays?: number;
  cutoverIso?: string;
  now?: Date;
}): Promise<FrictionReport> {
  const base = (args.baseCcy || "GBP").toUpperCase();
  const windowDays = args.windowDays ?? FRICTION_WINDOW_DAYS;
  const now = args.now ?? new Date();
  const toBase = await makeConverter(base);

  let navBase = 0;
  try {
    const snap = await args.db
      .from("equity_snapshots")
      .select("total_value")
      .eq("portfolio_id", args.portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    navBase = Number(snap?.data?.total_value ?? 0) || 0;
  } catch {
    navBase = 0;
  }

  const sinceAttribution = new Date(now.getTime() - ATTRIBUTION_DAYS * 86_400_000).toISOString();
  // The chart's left-hand points are trailing-window reads, so they need one
  // extra window of tape behind them. Without it the first 30 days of a 90-day
  // chart would slope up from zero purely because the history was truncated.
  const sinceSeries = new Date(
    now.getTime() - (ATTRIBUTION_DAYS + windowDays) * 86_400_000,
  ).toISOString();
  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = await args.db
      .from("live_fills")
      .select(
        "symbol, side, quantity, fill_price, fee, fee_commission, fee_exchange, fee_tax, fee_other, fee_source, currency, filled_at",
      )
      .eq("portfolio_id", args.portfolioId)
      .gte("filled_at", sinceSeries)
      .order("filled_at", { ascending: true })
      .limit(5000);
    rows = (res?.data ?? []) as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }

  const all: FrictionFill[] = [];
  for (const r of rows) {
    const symbol = String(r["symbol"] ?? "");
    const side = String(r["side"] ?? "").toLowerCase() === "sell" ? "sell" : "buy";
    const quantity = Number(r["quantity"] ?? 0);
    const price = Number(r["fill_price"] ?? 0);
    const filledAt = String(r["filled_at"] ?? "");
    if (!symbol || !(quantity > 0) || !(price > 0) || !filledAt) continue;
    const ccy = String(r["currency"] ?? base).toUpperCase();
    const c = estimateTradeCosts({ symbol, side, quantity, price });
    const reported = Number(r["fee"] ?? 0);
    const rawSource = String(r["fee_source"] ?? "none");
    const feeSource: "broker" | "model" | "none" =
      rawSource === "broker" ? "broker" : rawSource === "model" ? "model" : "none";

    // The broker itemises commission, exchange fees and duty — never the
    // half-spread, which stays modelled. Carry its split through so the
    // component breakdown reflects the invoice where one exists.
    const brokerCommission = Number(r["fee_commission"] ?? 0);
    const brokerExchange = Number(r["fee_exchange"] ?? 0);
    const brokerTax = Number(r["fee_tax"] ?? 0);
    const brokerOther = Number(r["fee_other"] ?? 0);
    const hasBrokerSplit =
      feeSource === "broker" &&
      [brokerCommission, brokerExchange, brokerTax, brokerOther].some((v) => Number.isFinite(v) && v > 0);

    all.push({
      symbol,
      side,
      notionalBase: await toBase(c.notional, ccy),
      feeReportedBase: await toBase(Number.isFinite(reported) ? Math.max(0, reported) : 0, ccy),
      feeModelledBase: await toBase(c.oneWayCost, ccy),
      commissionModelledBase: await toBase(c.commission, ccy),
      spreadModelledBase: await toBase(c.halfSpread, ccy),
      taxModelledBase: await toBase(c.stampDuty + c.ptmLevy, ccy),
      feeSource,
      ...(hasBrokerSplit
        ? {
            reportedComponents: {
              // Exchange/clearing fees are a commission-like charge, not a
              // tax: grouping them with duty would misattribute a cost the
              // governor can actually influence by trading less often.
              commissionBase:
                (await toBase(Math.max(0, brokerCommission), ccy)) +
                (await toBase(Math.max(0, brokerExchange), ccy)) +
                (await toBase(Math.max(0, brokerOther), ccy)),
              spreadBase: 0,
              taxBase: await toBase(Math.max(0, brokerTax), ccy),
            },
          }
        : {}),
      filledAt: new Date(Date.parse(filledAt)).toISOString(),
    });
  }


  // Attribution and the overlay keep their original 90-day tape; only the
  // chart looks further back.
  const attributionFills = all.filter((f) => Date.parse(f.filledAt) >= Date.parse(sinceAttribution));

  const windowStart = now.getTime() - windowDays * 86_400_000;
  const windowFills = all.filter((f) => Date.parse(f.filledAt) >= windowStart);

  let equity: Array<{ date: string; totalValue: number }> = [];
  try {
    const res = await args.db
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", args.portfolioId)
      .gte("snapshot_date", sinceSeries.slice(0, 10))
      .order("snapshot_date", { ascending: true })
      .limit(400);
    equity = ((res?.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
      date: String(e["snapshot_date"] ?? ""),
      totalValue: Number(e["total_value"] ?? 0),
    }));
  } catch {
    equity = [];
  }

  const navByDay = new Map<string, number>();
  for (const e of equity) {
    const d = e.date.slice(0, 10);
    if (d && Number.isFinite(e.totalValue) && e.totalValue > 0) navByDay.set(d, e.totalValue);
  }

  return {
    kpi: computeFrictionKpi({ fills: windowFills, navBase, windowDays }),
    series: frictionTimeSeries({
      fills: all,
      navBase,
      navByDay,
      days: ATTRIBUTION_DAYS,
      windowDays,
      now,
    }),
    seriesDays: ATTRIBUTION_DAYS,
    attribution: beforeAfterAttribution({
      fills: attributionFills,
      cutoverIso: args.cutoverIso ?? COST_GOVERNOR_CUTOVER_ISO,
      navBase,
      equity,
      toIso: now.toISOString(),
    }),
    overlay: realisedCostOverlay({ fills: attributionFills }),
    currency: base,
    asOf: now.toISOString(),
  };
}
