// Server read behind the equity tile's "what moved today" breakdown.
// See src/lib/day-attribution.ts for the arithmetic contract.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildDayAttribution, type DayAttribution, type MoverInput } from "@/lib/day-attribution";

export type TodayMoversResult = DayAttribution & {
  baseCurrency: string;
  prevDate: string | null;
  currDate: string | null;
  prevEquity: number;
  currEquity: number;
  portfolioCount: number;
  /** Real-money portfolio ids behind these numbers (for the daily rollup). */
  portfolioIds: string[];
  /** True when the real-money portfolios do not share one base currency. */
  mixedCurrency: boolean;
  warnings: string[];
};

const EMPTY: TodayMoversResult = {
  lines: [],
  positionsTotal: 0,
  fees: 0,
  netFlow: 0,
  totalChange: 0,
  residual: 0,
  unpricedCount: 0,
  baseCurrency: "GBP",
  prevDate: null,
  currDate: null,
  prevEquity: 0,
  currEquity: 0,
  portfolioCount: 0,
  portfolioIds: [],
  mixedCurrency: false,
  warnings: [],
};

export const getTodayMovers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ mode: z.enum(["live_prod", "sim"]).optional() })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<TodayMoversResult> => {
    const { supabase } = context;
    const realOnly = (data.mode ?? "live_prod") === "live_prod";

    const { data: portfolioRows } = await supabase
      .from("portfolios")
      .select("id, currency, mode");
    const portfolios = (portfolioRows ?? []).filter((p) =>
      realOnly ? p.mode === "live_prod" : p.mode !== "live_prod",
    );
    if (portfolios.length === 0) return EMPTY;

    const currencies = [
      ...new Set(portfolios.map((p) => String(p.currency || "GBP").toUpperCase())),
    ];
    const baseCcy = currencies[0] ?? "GBP";
    const warnings: string[] = [];
    const usable = portfolios.filter(
      (p) => String(p.currency || "GBP").toUpperCase() === baseCcy,
    );
    if (currencies.length > 1) {
      warnings.push(
        `Only ${baseCcy} portfolios are included — others report in ${currencies.slice(1).join(", ")}.`,
      );
    }

    const [{ normalizeLseDisplayPriceToBase }, { priceSymbolVariants }, { loadFxRates }, { majorUnitCurrency }] =
      await Promise.all([
        import("@/lib/market-price-units"),
        import("@/lib/price-symbol"),
        import("@/lib/valuation/value-holdings.server"),
        import("@/lib/valuation/kernel"),
      ]);

    let prevEquity = 0;
    let currEquity = 0;
    let prevDate: string | null = null;
    let currDate: string | null = null;
    let fees = 0;
    let netFlow = 0;
    const inputs: MoverInput[] = [];
    const feeCcy = new Map<string, number>();

    for (const p of usable) {
      const { data: snaps } = await supabase
        .from("equity_snapshots")
        .select("snapshot_date, total_value")
        .eq("portfolio_id", p.id)
        .order("snapshot_date", { ascending: false })
        .limit(2);
      const latest = snaps?.[0];
      const previous = snaps?.[1];
      if (!latest || !previous) continue;

      currEquity += Number(latest.total_value) || 0;
      prevEquity += Number(previous.total_value) || 0;
      if (!currDate || String(latest.snapshot_date) > currDate) currDate = String(latest.snapshot_date);
      if (!prevDate || String(previous.snapshot_date) > prevDate) prevDate = String(previous.snapshot_date);

      const windowStart = String(previous.snapshot_date);
      const dayStartIso = `${String(latest.snapshot_date)}T00:00:00.000Z`;

      const { data: holdingRows } = await supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, instrument_ccy, opened_at")
        .eq("portfolio_id", p.id);

      for (const h of holdingRows ?? []) {
        const qty = Number(h.quantity);
        if (!Number.isFinite(qty) || qty === 0) continue;

        // Look a few days back so a bank-holiday gap still yields a prior close.
        const lookback = new Date(`${windowStart}T00:00:00Z`);
        lookback.setUTCDate(lookback.getUTCDate() - 6);
        const { data: bars } = await supabase
          .from("price_cache")
          .select("price_date, close")
          .in("symbol", priceSymbolVariants(h.symbol))
          .gte("price_date", lookback.toISOString().slice(0, 10))
          .order("price_date", { ascending: true });

        const norm = (v: unknown) =>
          normalizeLseDisplayPriceToBase(h.symbol, Number(v), h.asset_class ?? null);

        let prevPrice: number | null = null;
        let currPrice: number | null = null;
        for (const b of bars ?? []) {
          const close = norm(b.close);
          if (!Number.isFinite(close) || close <= 0) continue;
          if (String(b.price_date) <= windowStart) prevPrice = close;
          currPrice = close;
        }

        // A position opened inside the window has no prior close of its own —
        // its day move is measured from the price actually paid.
        const openedToday =
          h.opened_at != null && String(h.opened_at) >= dayStartIso;
        if (openedToday && h.avg_cost != null) {
          const entry = norm(h.avg_cost);
          if (Number.isFinite(entry) && entry > 0) prevPrice = entry;
        }

        const ccy = majorUnitCurrency(String(h.symbol), h.instrument_ccy ?? null, baseCcy);
        inputs.push({
          symbol: String(h.symbol),
          assetClass: h.asset_class ?? null,
          quantity: qty,
          prevPrice,
          currPrice,
          currency: ccy,
          fxRate: null, // filled below, once every needed rate is known
          openedToday,
        });
      }

      const { data: fills } = await supabase
        .from("live_fills")
        .select("fee, currency, filled_at")
        .eq("portfolio_id", p.id)
        .gte("filled_at", dayStartIso);
      for (const f of fills ?? []) {
        const amt = Number(f.fee);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const c = String(f.currency || baseCcy).toUpperCase();
        feeCcy.set(c, (feeCcy.get(c) ?? 0) + amt);
      }

      const { data: flows } = await supabase
        .from("sim_fund_events")
        .select("amount, created_at")
        .eq("portfolio_id", p.id)
        .gt("created_at", `${windowStart}T23:59:59.999Z`);
      for (const f of flows ?? []) netFlow += Number(f.amount) || 0;
    }

    if (inputs.length === 0 && currEquity === 0) return { ...EMPTY, baseCurrency: baseCcy, warnings };

    const rates = await loadFxRates(
      [...inputs.map((i) => i.currency), ...feeCcy.keys()],
      baseCcy,
    );
    const rateFor = (from: string) =>
      from.toUpperCase() === baseCcy ? 1 : (rates.get(`${from.toUpperCase()}>${baseCcy}`) ?? null);

    for (const i of inputs) {
      const r = rateFor(i.currency);
      if (r == null) warnings.push(`No ${i.currency}→${baseCcy} rate — ${i.symbol} shown unconverted.`);
      i.fxRate = r;
    }
    for (const [ccy, amt] of feeCcy) fees += amt * (rateFor(ccy) ?? 1);

    const attribution = buildDayAttribution({
      inputs,
      fees,
      netFlow,
      totalChange: currEquity - prevEquity,
    });

    return {
      ...attribution,
      baseCurrency: baseCcy,
      prevDate,
      currDate,
      prevEquity,
      currEquity,
      portfolioCount: usable.length,
      portfolioIds: usable.map((p) => String(p.id)),
      mixedCurrency: currencies.length > 1,
      warnings,
    };
  });
