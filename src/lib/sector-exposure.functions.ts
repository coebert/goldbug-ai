import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SectorExposureSeries } from "@/lib/sector-exposure";

export type SectorExposureResult = SectorExposureSeries & {
  baseCcy: string;
  windowDays: number;
  /** True when sector phases came from a single (latest) classification. */
  staticPhases: boolean;
};

export const getSectorExposureSeries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        windowDays: z.number().int().min(14).max(365).default(90),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<SectorExposureResult> => {
    const { buildSectorExposureSeries, dayRange } = await import("@/lib/sector-exposure");
    const { classifySectorCycle } = await import("@/lib/sector-cycle");
    const { symbolSector } = await import("@/lib/sector-rotation.server");
    const { resolveYahoo } = await import("@/lib/backfill-holdings-history.helpers");
    const { normalizeLseDisplayPriceToBase } = await import("@/lib/market-price-units");
    const { getFxMatrix } = await import("@/lib/fx.server");

    const { data: portfolio, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id, currency")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!portfolio) throw new Error("Portfolio not found");
    const baseCcy = String(portfolio.currency ?? "GBP").toUpperCase();

    const today = new Date();
    const endIso = today.toISOString().slice(0, 10);
    const startIso = new Date(today.getTime() - (data.windowDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: tradeRows } = await context.supabase
      .from("trades")
      .select("symbol, side, quantity, trade_date, instrument_ccy, asset_class")
      .eq("portfolio_id", data.portfolioId)
      .order("trade_date", { ascending: true });
    const trades = tradeRows ?? [];

    if (trades.length === 0) {
      return {
        points: [],
        latestBySector: [],
        averageTilt: 0,
        tiltChange: 0,
        baseCcy,
        windowDays: data.windowDays,
        staticPhases: true,
      };
    }

    const symbols = Array.from(new Set(trades.map((t) => String(t.symbol))));
    const ccyOf = new Map<string, string>();
    const assetClassOf = new Map<string, string | null>();
    for (const t of trades) {
      ccyOf.set(String(t.symbol), String(t.instrument_ccy ?? baseCcy).toUpperCase());
      assetClassOf.set(String(t.symbol), (t.asset_class as string | null) ?? null);
    }

    const yahooOf = new Map<string, string>();
    for (const s of symbols) yahooOf.set(s, resolveYahoo(s));

    const { data: priceRows } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", Array.from(new Set(yahooOf.values())))
      .gte("price_date", startIso)
      .order("price_date", { ascending: true });

    const closesByYahoo = new Map<string, Array<{ date: string; close: number }>>();
    for (const r of priceRows ?? []) {
      const arr = closesByYahoo.get(String(r.symbol)) ?? [];
      arr.push({ date: String(r.price_date), close: Number(r.close) });
      closesByYahoo.set(String(r.symbol), arr);
    }

    // One FX rate per unique instrument currency, applied across the window.
    const fx = await getFxMatrix(
      Array.from(new Set(ccyOf.values())).map((from) => ({ from, to: baseCcy })),
    );
    const rateFor = (ccy: string) => {
      if (ccy === baseCcy) return 1;
      const r = fx.get(`${ccy}${baseCcy}`)?.rate;
      return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1;
    };

    const prices: Record<string, Array<{ date: string; close: number }>> = {};
    const sectorOf: Record<string, string | null> = {};
    for (const s of symbols) {
      const raw = closesByYahoo.get(yahooOf.get(s) as string) ?? [];
      const ccy = ccyOf.get(s) ?? baseCcy;
      const rate = rateFor(ccy === "GBX" ? "GBP" : ccy);
      prices[s] = raw.map((p) => ({
        date: p.date,
        close: normalizeLseDisplayPriceToBase(s, p.close, assetClassOf.get(s) ?? null) * rate,
      }));
      sectorOf[s] = symbolSector(s);
    }

    // Sector phases per day, from the persisted momentum history.
    const { data: scoreRows } = await context.supabase
      .from("sector_scores")
      .select("as_of, sector, etf_symbol, momentum_30d, momentum_90d, score, rank")
      .gte("as_of", startIso)
      .order("as_of", { ascending: true });

    const byAsOf = new Map<string, Array<(typeof scoreRows extends null ? never : NonNullable<typeof scoreRows>)[number]>>();
    for (const r of scoreRows ?? []) {
      const arr = byAsOf.get(String(r.as_of)) ?? [];
      arr.push(r);
      byAsOf.set(String(r.as_of), arr);
    }

    const phasesByDay: Record<string, Record<string, "growing" | "stagnating" | "shrinking">> = {};
    for (const [asOf, rows] of byAsOf) {
      const cycle = classifySectorCycle(
        rows.map((r) => ({
          sector: String(r.sector),
          etf: String(r.etf_symbol),
          momentum_30d: r.momentum_30d == null ? null : Number(r.momentum_30d),
          momentum_90d: r.momentum_90d == null ? null : Number(r.momentum_90d),
          score: r.score == null ? null : Number(r.score),
          rank: r.rank == null ? null : Number(r.rank),
        })),
      );
      phasesByDay[asOf] = Object.fromEntries(cycle.rows.map((row) => [row.sector, row.phase]));
    }

    const series = buildSectorExposureSeries({
      days: dayRange(startIso, endIso),
      trades: trades.map((t) => ({
        symbol: String(t.symbol),
        side: String(t.side) === "sell" ? "sell" : "buy",
        quantity: Number(t.quantity),
        trade_date: String(t.trade_date),
      })),
      prices,
      sectorOf,
      phasesByDay,
    });

    return {
      ...series,
      baseCcy,
      windowDays: data.windowDays,
      staticPhases: Object.keys(phasesByDay).length <= 1,
    };
  });
