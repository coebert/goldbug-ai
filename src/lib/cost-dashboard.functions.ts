// Costs dashboard data: what this account really pays to deal each symbol,
// and the operator-adjustable hurdle the net-edge gate applies on top.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MEASURED_FLOOR_HEADROOM, DEFAULT_EDGE_SAFETY_MULTIPLE } from "./net-edge-gate";

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

export type CostDashboard = {
  hurdleMultiple: number;
  defaultHurdleMultiple: number;
  floorHeadroom: number;
  rows: SymbolCostRow[];
};

export const getCostDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CostDashboard> => {
    const [{ data: rows }, { data: controls }] = await Promise.all([
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
    ]);

    return {
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
