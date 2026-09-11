import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { alignSeriesCommonWindow, calculatePerformance, cleanPriceSeries, targetAllocationReturn, type FundPerformance, type PricePoint } from "./core-performance";
import { engineSymbolKey } from "./price-symbol";
import { normalizeMarketPriceForTrading } from "./market-price-units";

const FUNDS = [
  { symbol: "VWRL.L", name: "Vanguard FTSE All-World", currency: "GBP", role: "core" },
  { symbol: "VWCE.DE", name: "Vanguard FTSE All-World Acc", currency: "EUR", role: "peer" },
  { symbol: "IWDA.AS", name: "iShares Core MSCI World", currency: "EUR", role: "peer" },
  { symbol: "VT", name: "Vanguard Total World Stock", currency: "USD", role: "peer" },
] as const;

export type CorePerformancePanel = {
  portfolioId: string;
  portfolioName: string;
  currency: "GBP";
  years: 1 | 3 | 5;
  asOf: string;
  targetPct: number;
  bandPct: number;
  currentPct: number;
  coreValueBase: number;
  navBase: number;
  funds: FundPerformance[];
  comparisonFunds: FundPerformance[];
};

function dateYearsAgo(asOf: string, years: number): string {
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function rateOnOrBefore(points: readonly PricePoint[], date: string): number | null {
  let result: number | null = null;
  for (const point of points) {
    if (point.date > date) break;
    result = point.close;
  }
  return result;
}

function toGbpSeries(
  symbol: string,
  currency: string,
  prices: readonly PricePoint[],
  eurGbp: readonly PricePoint[],
  gbpUsd: readonly PricePoint[],
): PricePoint[] {
  return cleanPriceSeries(prices.flatMap((point) => {
    const localPrice = normalizeMarketPriceForTrading(symbol, point.close);
    if (currency === "GBP") return [{ date: point.date, close: localPrice }];
    const fx = currency === "EUR" ? rateOnOrBefore(eurGbp, point.date) : rateOnOrBefore(gbpUsd, point.date);
    if (!fx || fx <= 0) return [];
    return [{ date: point.date, close: currency === "EUR" ? localPrice * fx : localPrice / fx }];
  }));
}

export const getCorePerformance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ years: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(3) }).parse(input ?? {}))
  .handler(async ({ data, context }): Promise<CorePerformancePanel> => {
    const db = context.supabase;
    const { data: portfolios, error: portfolioError } = await db
      .from("portfolios")
      .select("id, name, mode, status, created_at")
      .in("mode", ["live_prod", "live_sim"])
      .order("created_at", { ascending: false });
    if (portfolioError) throw new Error(portfolioError.message);
    const rows = portfolios ?? [];
    const active = rows.filter((row) => String(row.status ?? "active") === "active");
    const pool = active.length > 0 ? active : rows;
    const portfolio = pool.find((row) => row.mode === "live_prod") ?? pool[0];
    if (!portfolio) throw new Error("No live portfolio found");

    const portfolioId = String(portfolio.id);
    const asOf = new Date().toISOString().slice(0, 10);
    const from = dateYearsAgo(asOf, data.years);
    const { loadCoreAllocationSettings } = await import("./trading-controls.server");
    const { getDailyCandlesRange } = await import("./market-data.server");
    const core = await loadCoreAllocationSettings();

    const [holdingsRes, snapshotRes, ...history] = await Promise.all([
      db.from("holdings").select("symbol, quantity").eq("portfolio_id", portfolioId),
      db.from("equity_snapshots").select("total_value").eq("portfolio_id", portfolioId).order("snapshot_date", { ascending: false }).limit(1).maybeSingle(),
      ...FUNDS.map((fund) => getDailyCandlesRange(fund.symbol, from, asOf).catch(() => [])),
      getDailyCandlesRange("EURGBP=X", from, asOf).catch(() => []),
      getDailyCandlesRange("GBPUSD=X", from, asOf).catch(() => []),
    ]);
    if (holdingsRes.error) throw new Error(holdingsRes.error.message);
    if (snapshotRes.error) throw new Error(snapshotRes.error.message);

    const eurGbp = (history[FUNDS.length] ?? []).map((point) => ({ date: point.date, close: point.close }));
    const gbpUsd = (history[FUNDS.length + 1] ?? []).map((point) => ({ date: point.date, close: point.close }));
    const converted = FUNDS.map((fund, index) => {
      const raw = (history[index] ?? []).map((point) => ({ date: point.date, close: point.close }));
      const series = toGbpSeries(fund.symbol, fund.currency, raw, eurGbp, gbpUsd);
      return { ...fund, series };
    });
    const funds = converted.map((fund): FundPerformance => {
      const metrics = calculatePerformance(fund.series);
      return {
        symbol: fund.symbol,
        name: fund.name,
        currency: "GBP",
        series: fund.series,
        metrics,
        targetAllocationReturn: metrics ? targetAllocationReturn(metrics.totalReturn, core.targetPct) : null,
      };
    });
    const comparisonFunds = alignSeriesCommonWindow(converted).map((fund): FundPerformance => {
      const metrics = calculatePerformance(fund.series);
      return {
        symbol: fund.symbol,
        name: fund.name,
        currency: "GBP",
        series: fund.series,
        metrics,
        targetAllocationReturn: metrics ? targetAllocationReturn(metrics.totalReturn, core.targetPct) : null,
      };
    });

    const coreKey = engineSymbolKey(core.symbol);
    const quantity = (holdingsRes.data ?? [])
      .filter((holding) => engineSymbolKey(String(holding.symbol ?? "")) === coreKey)
      .reduce((sum, holding) => sum + (Number(holding.quantity ?? 0) || 0), 0);
    const coreFund = funds.find((fund) => engineSymbolKey(fund.symbol) === coreKey) ?? funds[0];
    const latestPrice = coreFund.metrics?.latestPrice ?? 0;
    const coreValueBase = quantity * latestPrice;
    const navBase = Number(snapshotRes.data?.total_value ?? 0) || coreValueBase;

    return {
      portfolioId,
      portfolioName: String(portfolio.name ?? "Portfolio"),
      currency: "GBP",
      years: data.years,
      asOf,
      targetPct: core.targetPct,
      bandPct: core.bandPct,
      currentPct: navBase > 0 ? coreValueBase / navBase : 0,
      coreValueBase,
      navBase,
      funds,
      comparisonFunds,
    };
  });
