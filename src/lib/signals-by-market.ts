import type { MarketVenue } from "./market-hours";

export type SignalCoverage = "covered" | "no_signal" | "unmeasured" | "stale_price" | "blocked";
export type SignalDirection = "bullish" | "neutral" | "bearish" | "none";

export type MarketSignalRow = {
  symbol: string;
  symbolKey: string;
  name: string;
  market: string;
  marketLabel: string;
  venue: MarketVenue;
  marketOpen: boolean;
  marketStatus: string;
  direction: SignalDirection;
  signalScore: number | null;
  confidence: number | null;
  expectedEdgeBps: number | null;
  price: number | null;
  priceDate: string | null;
  decisionAt: string | null;
  coverage: SignalCoverage;
  gapLabel: string | null;
};

export type MarketSignalGroup = {
  market: string;
  label: string;
  venue: MarketVenue;
  marketOpen: boolean;
  marketStatus: string;
  covered: number;
  total: number;
  averageConfidence: number | null;
  averageExpectedEdgeBps: number | null;
  strongest: MarketSignalRow | null;
  rows: MarketSignalRow[];
};

export type SignalsByMarket = {
  portfolioId: string;
  portfolioName: string;
  decisionAt: string | null;
  asOf: string;
  covered: number;
  total: number;
  gaps: number;
  groups: MarketSignalGroup[];
};

const VENUE_LABELS: Record<MarketVenue, string> = {
  LSE: "United Kingdom",
  NYSE: "United States",
  NASDAQ: "United States",
  XETR: "Germany",
  EURONEXT: "Continental Europe",
  SIX: "Switzerland",
  NORDIC: "Nordic markets",
  TSE_JP: "Japan",
  ASX: "Australia",
  CRYPTO: "Crypto",
  FX: "Currency markets",
  OTHER: "Other markets",
};

export function marketIdentity(venue: MarketVenue): { key: string; label: string } {
  if (venue === "NYSE" || venue === "NASDAQ") return { key: "US", label: VENUE_LABELS[venue] };
  if (venue === "XETR" || venue === "EURONEXT") return { key: "EU", label: "Continental Europe" };
  return { key: venue, label: VENUE_LABELS[venue] };
}

export function signalDirection(score: number | null): SignalDirection {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 0.15) return "bullish";
  if (score <= -0.15) return "bearish";
  return "neutral";
}

const coverageRank: Record<SignalCoverage, number> = {
  covered: 0,
  stale_price: 1,
  unmeasured: 2,
  no_signal: 3,
  blocked: 4,
};

export function sortMarketSignalRows(rows: MarketSignalRow[]): MarketSignalRow[] {
  return [...rows].sort((a, b) => {
    const actionableA = a.coverage === "covered" && a.marketOpen && a.direction === "bullish" ? 1 : 0;
    const actionableB = b.coverage === "covered" && b.marketOpen && b.direction === "bullish" ? 1 : 0;
    if (actionableA !== actionableB) return actionableB - actionableA;
    if (coverageRank[a.coverage] !== coverageRank[b.coverage]) {
      return coverageRank[a.coverage] - coverageRank[b.coverage];
    }
    const edgeA = a.expectedEdgeBps ?? Number.NEGATIVE_INFINITY;
    const edgeB = b.expectedEdgeBps ?? Number.NEGATIVE_INFINITY;
    if (edgeA !== edgeB) return edgeB - edgeA;
    return a.symbol.localeCompare(b.symbol);
  });
}

function average(values: Array<number | null>): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function groupMarketSignals(rows: MarketSignalRow[]): MarketSignalGroup[] {
  const grouped = new Map<string, MarketSignalRow[]>();
  for (const row of rows) grouped.set(row.market, [...(grouped.get(row.market) ?? []), row]);
  return [...grouped.entries()]
    .map(([market, marketRows]) => {
      const ordered = sortMarketSignalRows(marketRows);
      const first = ordered[0];
      const coveredRows = ordered.filter((row) => row.coverage === "covered");
      return {
        market,
        label: first?.marketLabel ?? market,
        venue: first?.venue ?? "OTHER",
        marketOpen: ordered.some((row) => row.marketOpen),
        marketStatus: first?.marketStatus ?? "Status unavailable",
        covered: coveredRows.length,
        total: ordered.length,
        averageConfidence: average(coveredRows.map((row) => row.confidence)),
        averageExpectedEdgeBps: average(coveredRows.map((row) => row.expectedEdgeBps)),
        strongest: coveredRows
          .filter((row) => row.signalScore != null)
          .sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0))[0] ?? null,
        rows: ordered,
      } satisfies MarketSignalGroup;
    })
    .sort((a, b) => Number(b.marketOpen) - Number(a.marketOpen) || a.label.localeCompare(b.label));
}