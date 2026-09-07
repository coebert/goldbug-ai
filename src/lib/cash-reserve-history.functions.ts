import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { estimateTradeCosts } from "./trade-viability-gate";
import { chargedFriction, type FrictionFill, FRICTION_WINDOW_DAYS } from "./friction-kpi";
import { buildCashReserveHistory } from "./cash-reserve-history";
import {
  CHURN_WINDOW_DAYS,
  DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
  RESERVE_EDGE_MULTIPLE,
  RESERVE_MIN_CONVICTION,
  STALL_DAYS,
  STALL_RESERVE_EDGE_MULTIPLE,
  governorForNav,
} from "./cost-governor";

export const getCashReserveHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const [{ data: portfolio, error: portfolioError }, { data: snapshots, error: snapshotError }, { data: fills, error: fillError }] = await Promise.all([
      db.from("portfolios").select("id,name,mode,currency").eq("id", data.portfolioId).single(),
      db.from("equity_snapshots").select("snapshot_date,cash,total_value").eq("portfolio_id", data.portfolioId).order("snapshot_date", { ascending: true }),
      db.from("live_fills").select("symbol,side,quantity,fill_price,fee,fee_source,currency,filled_at").eq("portfolio_id", data.portfolioId).order("filled_at", { ascending: true }).limit(5000),
    ]);
    if (portfolioError || !portfolio) throw new Error(portfolioError?.message ?? "Portfolio not found");
    if (snapshotError) throw new Error(snapshotError.message);
    if (fillError) throw new Error(fillError.message);

    const baseCurrency = String(portfolio.currency ?? "GBP").toUpperCase();
    const { convertAmount } = await import("./fx.server");
    const fxCache = new Map<string, number>();
    const toBase = async (amount: number, currency: string) => {
      const from = (currency || baseCurrency).toUpperCase();
      if (!Number.isFinite(amount) || amount === 0 || from === baseCurrency) return amount;
      let rate = fxCache.get(from);
      if (rate == null) {
        try {
          const converted = await convertAmount(1, from, baseCurrency);
          rate = Number.isFinite(converted.amount) && converted.amount > 0 ? converted.amount : 1;
        } catch {
          rate = 1;
        }
        fxCache.set(from, rate);
      }
      return amount * rate;
    };

    const costRows: Array<{ date: string; costBase: number }> = [];
    for (const row of fills ?? []) {
      const symbol = String(row.symbol ?? "");
      const side = String(row.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
      const quantity = Number(row.quantity ?? 0);
      const price = Number(row.fill_price ?? 0);
      const filledAt = String(row.filled_at ?? "");
      if (!symbol || !(quantity > 0) || !(price > 0) || !filledAt) continue;
      const currency = String(row.currency ?? baseCurrency).toUpperCase();
      const estimate = estimateTradeCosts({ symbol, side, quantity, price });
      const fill: FrictionFill = {
        symbol,
        side,
        notionalBase: await toBase(estimate.notional, currency),
        feeReportedBase: await toBase(Number(row.fee ?? 0), currency),
        feeModelledBase: await toBase(estimate.oneWayCost, currency),
        commissionModelledBase: await toBase(estimate.commission, currency),
        spreadModelledBase: await toBase(estimate.halfSpread, currency),
        taxModelledBase: await toBase(estimate.stampDuty + estimate.ptmLevy, currency),
        feeSource: row.fee_source === "broker" ? "broker" : row.fee_source === "model" ? "model" : "none",
        filledAt,
      };
      costRows.push({ date: filledAt.slice(0, 10), costBase: chargedFriction(fill) });
    }

    const series = buildCashReserveHistory(
      (snapshots ?? []).map((row) => ({
        date: String(row.snapshot_date ?? ""),
        cash: row.cash == null ? null : Number(row.cash),
        nav: Number(row.total_value ?? 0),
      })),
      costRows,
    );
    const latestNav = series.at(-1)?.nav ?? 10_000;
    const gov = governorForNav(latestNav);

    return {
      portfolioName: String(portfolio.name ?? "Real-money account"),
      mode: String(portfolio.mode ?? ""),
      currency: baseCurrency,
      windowDays: FRICTION_WINDOW_DAYS,
      series,
      rules: {
        reserveTickets: gov.highEdgeReserveTickets ?? DEFAULT_HIGH_EDGE_RESERVE_TICKETS,
        maxBuysPerDay: gov.maxBuysPerDay,
        addCooldownDays: gov.addCooldownDays,
        reserveEdgeMultiple: RESERVE_EDGE_MULTIPLE,
        reserveMinConviction: RESERVE_MIN_CONVICTION,
        stallDays: STALL_DAYS,
        stallReserveEdgeMultiple: STALL_RESERVE_EDGE_MULTIPLE,
        churnWindowDays: CHURN_WINDOW_DAYS,
      },
    };
  });
