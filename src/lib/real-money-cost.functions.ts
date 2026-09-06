/**
 * Real-money cost panel for the P&L page.
 *
 * The P&L page already shows what dealing took out of the account. This adds
 * the other half of the question: is the AI's cost floor actually set above
 * what this account pays, and how much of the governor's reserve is left?
 *
 * Everything here is portfolio-scoped and measured from `live_fills`, so the
 * floor the gate applies can be read against the money the broker took —
 * including how much of that money is invoiced rather than modelled.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MEASURED_FLOOR_HEADROOM, DEFAULT_EDGE_SAFETY_MULTIPLE } from "./net-edge-gate";
import {
  governorForNav,
  minTicketBase,
  DEFAULT_MAX_POSITION_PCT_OF_NAV,
  DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
} from "./cost-governor";

export type RealMoneyCostPanel = {
  currency: string;
  /** Ticket-weighted round trip measured from this account's fills, bps. */
  measuredRoundTripBps: number | null;
  measuredFeeBps: number | null;
  measuredSlippageBps: number | null;
  tickets: number;
  /** Safety multiplier applied to the measured tape. */
  floorHeadroom: number;
  /** Operator-set hurdle on top of the floor. */
  hurdleMultiple: number;
  /** What a buy's expected move must beat: round trip x headroom x hurdle. */
  effectiveFloorBps: number | null;
  /** Headroom between the floor and the measured cost, bps. */
  floorCushionBps: number | null;

  /** Trailing-window friction actually charged, in money and bps of NAV. */
  frictionBase: number;
  frictionBps: number | null;
  budgetBps: number;
  budgetUsed: number | null;
  windowDays: number;
  /** Share of window tickets priced off a broker invoice, 0..1. */
  invoicedShare: number;
  invoicedBase: number;
  estimatedBase: number;

  /** Governor reserve rules sized on this book. */
  navBase: number | null;
  minTicketBase: number | null;
  maxBuysPerDay: number;
  buysToday: number;
  maxPositionPctOfNav: number;
  reserveTickets: number;
  addCooldownDays: number;
  frictionBudgetBase: number | null;
  frictionRemainingBase: number | null;
};

export const getRealMoneyCostPanel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }): Promise<RealMoneyCostPanel> => {
    const db = context.supabase;

    const [{ data: symbolRows }, { data: controls }, { data: snap }] = await Promise.all([
      db
        .from("symbol_execution_costs")
        .select("round_trip_bps, fee_bps, slippage_bps, tickets")
        .eq("portfolio_id", data.portfolioId),
      db.from("trading_controls").select("cost_hurdle_multiple").eq("id", true).maybeSingle(),
      db
        .from("equity_snapshots")
        .select("total_value")
        .eq("portfolio_id", data.portfolioId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const measured = ((symbolRows ?? []) as Array<Record<string, unknown>>).filter(
      (r) => (Number(r["tickets"]) || 0) > 0,
    );
    const tickets = measured.reduce((s, r) => s + (Number(r["tickets"]) || 0), 0);
    const wavg = (key: string): number | null =>
      tickets > 0
        ? measured.reduce((s, r) => s + (Number(r[key]) || 0) * (Number(r["tickets"]) || 0), 0) /
          tickets
        : null;

    const roundTrip = wavg("round_trip_bps");
    const hurdleMultiple =
      Number((controls as { cost_hurdle_multiple?: number | null } | null)?.cost_hurdle_multiple) ||
      DEFAULT_EDGE_SAFETY_MULTIPLE;
    const effectiveFloorBps =
      roundTrip != null ? roundTrip * MEASURED_FLOOR_HEADROOM * hurdleMultiple : null;

    const { loadFrictionReport } = await import("./friction-kpi.server");
    const report = await loadFrictionReport({ db: db as never, portfolioId: data.portfolioId });
    const kpi = report.kpi;

    const navBase = Number(snap?.["total_value"] ?? kpi.navBase) || null;
    const gov = governorForNav(navBase ?? 10_000);
    const budgetBase = navBase != null ? navBase * gov.costBudgetPctOfNav : null;

    // Buys already dealt today, against the governor's daily ticket cap.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data: todayRows } = await db
      .from("live_fills")
      .select("order_id, symbol, side")
      .eq("portfolio_id", data.portfolioId)
      .eq("side", "buy")
      .gte("filled_at", dayStart.toISOString())
      .limit(200);
    const buysToday = new Set(
      ((todayRows ?? []) as Array<Record<string, unknown>>).map(
        (r) => String(r["order_id"] ?? r["symbol"] ?? ""),
      ),
    ).size;

    const invoicedShare = Number.isFinite(kpi.brokerCoverage) ? kpi.brokerCoverage : 0;

    return {
      currency: report.currency,
      measuredRoundTripBps: roundTrip,
      measuredFeeBps: wavg("fee_bps"),
      measuredSlippageBps: wavg("slippage_bps"),
      tickets,
      floorHeadroom: MEASURED_FLOOR_HEADROOM,
      hurdleMultiple,
      effectiveFloorBps,
      floorCushionBps:
        effectiveFloorBps != null && roundTrip != null ? effectiveFloorBps - roundTrip : null,

      frictionBase: kpi.frictionBase,
      frictionBps: kpi.frictionBps,
      budgetBps: kpi.budgetBps,
      budgetUsed: kpi.budgetUsed,
      windowDays: kpi.windowDays,
      invoicedShare,
      invoicedBase: kpi.realisedFrictionBase,
      estimatedBase: kpi.estimatedFrictionBase,

      navBase,
      minTicketBase: navBase != null ? minTicketBase({ navBase, ...gov }) : null,
      maxBuysPerDay: gov.maxBuysPerDay,
      buysToday,
      maxPositionPctOfNav: gov.maxPositionPctOfNav ?? DEFAULT_MAX_POSITION_PCT_OF_NAV,
      reserveTickets: gov.highEdgeReserveTickets ?? DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
      addCooldownDays: gov.addCooldownDays,
      frictionBudgetBase: budgetBase,
      frictionRemainingBase: budgetBase != null ? budgetBase - kpi.frictionBase : null,
    };
  });
