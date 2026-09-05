// Costs dashboard data: what this account really pays to deal each symbol,
// the broker's published tariff behind those charges, the reserve rules that
// ration tickets, and the operator-adjustable hurdle the net-edge gate applies.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MEASURED_FLOOR_HEADROOM, DEFAULT_EDGE_SAFETY_MULTIPLE } from "./net-edge-gate";
import { SAXO_FEE_SCHEDULE } from "./saxo-fees";
import {
  UK_STAMP_DUTY_BPS,
  PTM_LEVY_GBP,
  PTM_LEVY_THRESHOLD_GBP,
} from "./trade-viability-gate";
import {
  governorForNav,
  minTicketBase,
  DEFAULT_MAX_POSITION_PCT_OF_NAV,
  DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
  RESERVE_EDGE_MULTIPLE,
  RESERVE_MIN_CONVICTION,
  STALL_DAYS,
  STALL_RESERVE_EDGE_MULTIPLE,
  STALL_RESERVE_MIN_CONVICTION,
  CHURN_WINDOW_DAYS,
  CHURN_CALM_FILLS,
  MIN_BUDGET_TICKETS,
} from "./cost-governor";

export type SymbolCostRow = {
  symbol: string;
  /** Average one-way cost actually paid on buys, in bps of notional. */
  buyBps: number;
  /** Same on sells. */
  sellBps: number;
  /** Full round trip: buy + sell, in bps. */
  roundTripBps: number;
  /** Of which broker charges (commission, stamp, exchange), in bps one-way. */
  feeBps: number;
  /** Of which slippage vs the day's printed price, in bps one-way. */
  slippageBps: number;
  tickets: number;
  fills: number;
  invoicedFills: number;
  /** True when the figure comes from this account's own fills. */
  measured: boolean;
  firstFillAt: string | null;
  lastFillAt: string | null;
  /** Round trip with the safety headroom the gate applies, in bps. */
  floorBps: number;
};

/** One line of the broker's published commission tariff. */
export type BrokerTariffRow = {
  venue: string;
  currency: string;
  /** Per-side commission in bps of notional. */
  rateBps: number;
  /** Per-side minimum charge, in the trade currency. */
  minCharge: number;
};

export type BrokerCharges = {
  broker: string;
  tier: string;
  rows: BrokerTariffRow[];
  ukStampDutyBps: number;
  ptmLevyGbp: number;
  ptmLevyThresholdGbp: number;
};

/** The ticket-rationing rules the governor applies, sized for this book. */
export type ReserveRules = {
  navBase: number | null;
  navAsOf: string | null;
  portfolioName: string | null;
  minTicketBase: number | null;
  minTicketPctOfNav: number;
  absoluteMinTicketBase: number;
  maxBuysPerDay: number;
  addCooldownDays: number;
  frictionBudgetPctOfNav: number;
  frictionBudgetBase: number | null;
  minBudgetTickets: number;
  maxPositionPctOfNav: number;
  reserveTickets: number;
  reserveEdgeMultiple: number;
  reserveMinConviction: number;
  stallDays: number;
  stallEdgeMultiple: number;
  stallMinConviction: number;
  churnWindowDays: number;
  churnCalmFills: number;
};

export type CostDashboard = {
  hurdleMultiple: number;
  defaultHurdleMultiple: number;
  floorHeadroom: number;
  rows: SymbolCostRow[];
  broker: BrokerCharges;
  reserve: ReserveRules;
  /** Notional-weighted account averages measured from fills, in bps. */
  account: {
    feeBps: number | null;
    slippageBps: number | null;
    roundTripBps: number | null;
    tickets: number;
  };
};

export const getCostDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CostDashboard> => {
    const [{ data: rows }, { data: controls }, { data: books }] = await Promise.all([
      context.supabase
        .from("symbol_execution_costs")
        .select(
          "symbol, buy_bps, sell_bps, round_trip_bps, fee_bps, slippage_bps, tickets, fills, invoiced_fills, measured, first_fill_at, last_fill_at",
        )
        .order("round_trip_bps", { ascending: false }),
      context.supabase
        .from("trading_controls")
        .select("cost_hurdle_multiple")
        .eq("id", true)
        .maybeSingle(),
      context.supabase
        .from("portfolios")
        .select("id, name, mode, status, current_cash")
        .in("mode", ["live_prod", "live_sim"])
        .eq("status", "active")
        .order("live_activated_at", { ascending: false, nullsFirst: false })
        .limit(1),
    ]);

    const book = (books ?? [])[0] ?? null;
    let navBase: number | null = book ? Number(book.current_cash) || 0 : null;
    let navAsOf: string | null = null;
    if (book) {
      const { data: snap } = await context.supabase
        .from("equity_snapshots")
        .select("total_value, snapshot_date")
        .eq("portfolio_id", book.id)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snap && Number(snap.total_value) > 0) {
        navBase = Number(snap.total_value);
        navAsOf = String(snap.snapshot_date);
      }
    }

    const gov = governorForNav(navBase ?? 10_000);
    const reserve: ReserveRules = {
      navBase,
      navAsOf,
      portfolioName: book ? String(book.name) : null,
      minTicketBase:
        navBase != null ? minTicketBase({ navBase, ...gov }) : null,
      minTicketPctOfNav: gov.minTicketPctOfNav,
      absoluteMinTicketBase: gov.absoluteMinTicketBase,
      maxBuysPerDay: gov.maxBuysPerDay,
      addCooldownDays: gov.addCooldownDays,
      frictionBudgetPctOfNav: gov.costBudgetPctOfNav,
      frictionBudgetBase: navBase != null ? navBase * gov.costBudgetPctOfNav : null,
      minBudgetTickets: MIN_BUDGET_TICKETS,
      maxPositionPctOfNav:
        gov.maxPositionPctOfNav ?? DEFAULT_MAX_POSITION_PCT_OF_NAV,
      reserveTickets: gov.highEdgeReserveTickets ?? DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
      reserveEdgeMultiple: RESERVE_EDGE_MULTIPLE,
      reserveMinConviction: RESERVE_MIN_CONVICTION,
      stallDays: STALL_DAYS,
      stallEdgeMultiple: STALL_RESERVE_EDGE_MULTIPLE,
      stallMinConviction: STALL_RESERVE_MIN_CONVICTION,
      churnWindowDays: CHURN_WINDOW_DAYS,
      churnCalmFills: CHURN_CALM_FILLS,
    };

    const broker: BrokerCharges = {
      broker: "Saxo",
      tier: "Classic",
      rows: Object.values(SAXO_FEE_SCHEDULE).map((t) => ({
        venue: t.venue,
        currency: t.currency,
        rateBps: t.rate * 10_000,
        minCharge: t.min,
      })),
      ukStampDutyBps: UK_STAMP_DUTY_BPS,
      ptmLevyGbp: PTM_LEVY_GBP,
      ptmLevyThresholdGbp: PTM_LEVY_THRESHOLD_GBP,
    };

    const measuredRows = (rows ?? []).filter((r) => Number(r.tickets) > 0);
    const totalTickets = measuredRows.reduce((s, r) => s + (Number(r.tickets) || 0), 0);
    const wavg = (pick: (r: (typeof measuredRows)[number]) => number) =>
      totalTickets > 0
        ? measuredRows.reduce((s, r) => s + pick(r) * (Number(r.tickets) || 0), 0) / totalTickets
        : null;

    return {
      broker,
      reserve,
      account: {
        feeBps: wavg((r) => Number(r.fee_bps) || 0),
        slippageBps: wavg((r) => Number(r.slippage_bps) || 0),
        roundTripBps: wavg((r) => Number(r.round_trip_bps) || 0),
        tickets: totalTickets,
      },
      hurdleMultiple:
        Number((controls as { cost_hurdle_multiple?: number | null } | null)?.cost_hurdle_multiple) ||
        DEFAULT_EDGE_SAFETY_MULTIPLE,
      defaultHurdleMultiple: DEFAULT_EDGE_SAFETY_MULTIPLE,
      floorHeadroom: MEASURED_FLOOR_HEADROOM,
      rows: (rows ?? []).map((r) => {
        const rt = Number(r.round_trip_bps) || 0;
        return {
          symbol: String(r.symbol),
          buyBps: Number(r.buy_bps) || 0,
          sellBps: Number(r.sell_bps) || 0,
          roundTripBps: rt,
          feeBps: Number(r.fee_bps) || 0,
          slippageBps: Number(r.slippage_bps) || 0,
          tickets: Number(r.tickets) || 0,
          fills: Number(r.fills) || 0,
          invoicedFills: Number(r.invoiced_fills) || 0,
          measured: Boolean(r.measured),
          firstFillAt: r.first_fill_at ? String(r.first_fill_at) : null,
          lastFillAt: r.last_fill_at ? String(r.last_fill_at) : null,
          floorBps: rt * MEASURED_FLOOR_HEADROOM,
        };
      }),
    };
  });

export const saveCostHurdle = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({ multiple: z.number().min(1).max(2.5) })
      .parse(data),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("trading_controls")
      .update({ cost_hurdle_multiple: data.multiple })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true as const, multiple: data.multiple };
  });
