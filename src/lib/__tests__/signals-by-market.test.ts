import { describe, expect, it } from "vitest";
import { groupMarketSignals, marketIdentity, signalDirection, sortMarketSignalRows, type MarketSignalRow } from "../signals-by-market";

const row = (overrides: Partial<MarketSignalRow> = {}): MarketSignalRow => ({
  symbol: "AAPL",
  symbolKey: "AAPL",
  name: "Apple",
  market: "US",
  marketLabel: "United States",
  venue: "NYSE",
  marketOpen: true,
  marketStatus: "NYSE open",
  direction: "bullish",
  signalScore: 0.5,
  confidence: 0.7,
  expectedEdgeBps: 80,
  price: 200,
  priceDate: "2026-09-11",
  decisionAt: "2026-09-11T16:00:00Z",
  coverage: "covered",
  gapLabel: null,
  ...overrides,
});

describe("signals by market", () => {
  it("combines US and continental-European venues into useful market groups", () => {
    expect(marketIdentity("NASDAQ").key).toBe("US");
    expect(marketIdentity("XETR").key).toBe("EU");
    expect(marketIdentity("EURONEXT").key).toBe("EU");
    expect(marketIdentity("TSE_JP").label).toBe("Japan");
  });

  it("turns scores into bullish, neutral, bearish and missing states", () => {
    expect(signalDirection(0.15)).toBe("bullish");
    expect(signalDirection(0.14)).toBe("neutral");
    expect(signalDirection(-0.15)).toBe("bearish");
    expect(signalDirection(null)).toBe("none");
  });

  it("puts open actionable signals before explicit gaps", () => {
    const ordered = sortMarketSignalRows([
      row({ symbol: "MSFT", symbolKey: "MSFT", coverage: "no_signal", signalScore: null }),
      row({ symbol: "NVDA", symbolKey: "NVDA", expectedEdgeBps: 120 }),
      row({ symbol: "AAPL", symbolKey: "AAPL", expectedEdgeBps: 40 }),
    ]);
    expect(ordered.map((item) => item.symbol)).toEqual(["NVDA", "AAPL", "MSFT"]);
  });

  it("summarises coverage, confidence and expected edge per market", () => {
    const groups = groupMarketSignals([
      row({ confidence: 0.6, expectedEdgeBps: 40 }),
      row({ symbol: "MSFT", symbolKey: "MSFT", confidence: 0.8, expectedEdgeBps: 80 }),
      row({ symbol: "7203.T", symbolKey: "7203.T", market: "TSE_JP", marketLabel: "Japan", venue: "TSE_JP", marketOpen: false, coverage: "no_signal", signalScore: null }),
    ]);
    expect(groups.find((group) => group.market === "US")).toMatchObject({ covered: 2, total: 2, averageConfidence: 0.7, averageExpectedEdgeBps: 60 });
    expect(groups.find((group) => group.market === "TSE_JP")).toMatchObject({ covered: 0, total: 1 });
  });
});