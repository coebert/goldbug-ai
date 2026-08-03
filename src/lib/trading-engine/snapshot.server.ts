// Non-AI portfolio valuation snapshot (backtest fill-in) — extracted verbatim.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordIntradayEquity } from "@/lib/equity-intraday.server";
import { valuePortfolioHoldings } from "../valuation/value-holdings.server";
import { writeEquitySnapshot } from "../valuation/write-snapshot.server";
import { currentPrices } from "./prices.server";

// Snapshot the portfolio value on a date without calling the AI (for backtest fill-in).
export async function snapshotPortfolio(portfolioId: string, asOf: string) {
  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("current_cash, currency, broker_account_id")
    .eq("id", portfolioId)
    .single();
  if (!portfolio) return;
  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("symbol, quantity, avg_cost")
    .eq("portfolio_id", portfolioId);

  const priceMap = await currentPrices(
    (holdings ?? []).map((h) => h.symbol),
    asOf,
  );
  const cash = Number(portfolio.current_cash);
  const baseCcy = ((portfolio as { currency?: string | null }).currency || "GBP").toUpperCase();
  const valuation = await valuePortfolioHoldings({
    holdings: (holdings ?? []).map((h) => ({
      symbol: h.symbol,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
    })),
    normalizedPrices: priceMap,
    wallet: { [baseCcy]: cash },
    baseCcy,
    asOf,
  });
  const hv = valuation.holdingsValue;
  await writeEquitySnapshot(supabaseAdmin as never, {
    portfolioId,
    snapshotDate: asOf,
    cash: valuation.cash,
    holdingsValue: hv,
    totalValue: valuation.totalValue,
    currency: baseCcy,
    source: "trading_engine",
    provenance: valuation.provenance,
    brokerLinked: Boolean(
      (portfolio as unknown as { broker_account_id?: string | null }).broker_account_id,
    ),
    positionCount: (holdings ?? []).length,
  });


  await recordIntradayEquity(supabaseAdmin as never, portfolioId, {
    cash: valuation.cash,
    holdingsValue: hv,
    totalValue: valuation.totalValue,
  });
}

