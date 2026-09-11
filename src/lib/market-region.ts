// Which region a listing belongs to, and the currency conventions that go
// with it. Pure module — derived from the venue inference in `market-hours`,
// so the engine, the scoring layer and the event gates can never disagree
// about whether a name is American, European or Japanese.

import { inferVenue, type MarketVenue } from "./market-hours";

export type MarketRegion = "us" | "uk" | "europe" | "japan" | "apac" | "other";

const BY_VENUE: Record<MarketVenue, MarketRegion> = {
  NYSE: "us",
  NASDAQ: "us",
  LSE: "uk",
  XETR: "europe",
  EURONEXT: "europe",
  SIX: "europe",
  NORDIC: "europe",
  TSE_JP: "japan",
  ASX: "apac",
  CRYPTO: "other",
  FX: "other",
  OTHER: "other",
};

export function marketRegion(symbol: string | null | undefined): MarketRegion {
  if (!symbol) return "other";
  return BY_VENUE[inferVenue(symbol)] ?? "other";
}

/** Regions where the US "quarterly print, dense sell-side" assumptions do not hold. */
export function isNonUsDeveloped(region: MarketRegion): boolean {
  return region === "uk" || region === "europe" || region === "japan";
}
