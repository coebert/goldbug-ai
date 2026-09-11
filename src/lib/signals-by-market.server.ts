import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildDailyComparison } from "./daily-comparison.server";
import { getMarketStatusForSymbol, inferVenue } from "./market-hours";
import { engineSymbolKey } from "./price-symbol";
import { buildSymbolDesk } from "./symbol-desk.server";
import { groupMarketSignals, marketIdentity, signalDirection, type MarketSignalRow, type SignalsByMarket } from "./signals-by-market";
import { findSymbol } from "./universe.server";

export async function buildSignalsByMarket(args: {
  userId: string;
  portfolioId?: string;
  now?: Date;
}): Promise<SignalsByMarket | null> {
  const desk = await buildSymbolDesk({ userId: args.userId, ...(args.portfolioId ? { portfolioId: args.portfolioId } : {}) });
  if (!desk) return null;

  const now = args.now ?? new Date();
  const [comparison, blocksRes] = await Promise.all([
    buildDailyComparison({ userId: args.userId, portfolioId: desk.portfolioId }).catch(() => null),
    supabaseAdmin
      .from("broker_instrument_blocks")
      .select("symbol_key, reason, reject_reason")
      .eq("user_id", args.userId)
      .is("cleared_at", null),
  ]);
  const current = new Map((comparison?.rows ?? []).map((row) => [engineSymbolKey(row.symbol), row]));
  const blocked = new Map(
    (blocksRes.data ?? []).map((row) => [String(row.symbol_key), String(row.reject_reason ?? row.reason)]),
  );
  const staleBefore = new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);

  const rows: MarketSignalRow[] = desk.rows.map((deskRow) => {
    const latest = current.get(deskRow.key) ?? null;
    const venue = inferVenue(deskRow.symbol);
    const identity = marketIdentity(venue);
    const status = getMarketStatusForSymbol(deskRow.symbol, now);
    const blockReason = blocked.get(deskRow.key) ?? null;
    let coverage: MarketSignalRow["coverage"] = "covered";
    let gapLabel: string | null = null;
    if (blockReason) {
      coverage = "blocked";
      gapLabel = `Broker blocked: ${blockReason}`;
    } else if (!latest) {
      coverage = "no_signal";
      gapLabel = "Not present in the latest AI snapshot";
    } else if (!deskRow.priceDate || deskRow.priceDate < staleBefore) {
      coverage = "stale_price";
      gapLabel = "Price is more than five days old";
    } else if (deskRow.strength == null) {
      coverage = "unmeasured";
      gapLabel = "No learned confidence history yet";
    }
    const meta = findSymbol(deskRow.symbol) ?? findSymbol(deskRow.key);
    return {
      symbol: deskRow.symbol,
      symbolKey: deskRow.key,
      name: meta?.name ?? deskRow.symbol,
      market: identity.key,
      marketLabel: identity.label,
      venue,
      marketOpen: status.isOpen,
      marketStatus: status.explanation,
      direction: signalDirection(latest?.modelScore ?? null),
      signalScore: latest?.modelScore ?? null,
      confidence: deskRow.strength,
      expectedEdgeBps: deskRow.meanNetBps,
      price: deskRow.lastPrice,
      priceDate: deskRow.priceDate,
      decisionAt: comparison?.decisionAt ?? null,
      coverage,
      gapLabel,
    };
  });

  const groups = groupMarketSignals(rows);
  const covered = rows.filter((row) => row.coverage === "covered").length;
  return {
    portfolioId: desk.portfolioId,
    portfolioName: desk.portfolioName,
    decisionAt: comparison?.decisionAt ?? null,
    asOf: now.toISOString(),
    covered,
    total: rows.length,
    gaps: rows.length - covered,
    groups,
  };
}