// Focused tests for the extracted candidate-feature builder.
// Indicator maths lives in market-data/signals-extended and is tested there;
// what matters here is the *assembly* contract: bulk priming, the <5-candle
// skip, null-safe indicator plumbing, and the placeholder fields that later
// stages (news, cooldowns, ranking) fill in.
import { describe, it, expect, vi, beforeEach } from "vitest";

const primeDailyCandles = vi.fn(async (_s: string[], _n: number, _asOf: string) => {});
const candlesBySymbol = new Map<string, Array<{ close: number }>>();

vi.mock("../../market-data.server", () => ({
  primeDailyCandles: (s: string[], n: number, a: string) => primeDailyCandles(s, n, a),
  getDailyCandles: async (s: string) => candlesBySymbol.get(s) ?? [],
  sma: (c: number[], n: number) => (c.length >= n ? n : null),
  rsi: () => 55,
  pctChange: (_c: number[], n: number) => n / 100,
  dailyVolatility: () => 0.012,
}));

vi.mock("../../signals-extended.server", () => ({
  macd: (c: number[]) => (c.length >= 30 ? { histogram: 0.5, bullish_cross: true, bearish_cross: false } : null),
  bollingerWidth: () => 0.04,
  atrPct: () => 0.02,
  averageDailyVolume: () => 1_000_000,
  volumeWeightedMomentum: () => 0.03,
  weeklySnapshot: (c: Array<unknown>) => (c.length >= 30 ? { weekly_trend_up: true, weekly_rsi14: 61 } : null),
  stochastic: (c: Array<unknown>) =>
    c.length >= 30
      ? {
          k: 24,
          d: 20,
          oversold: false,
          overbought: false,
          bull_cross: true,
          bear_cross: false,
          bull_cross_from_oversold: true,
          rising: true,
        }
      : null,
}));

import { classesFromUniverse, buildCandidateFeatures } from "../candidate-features.server";

const ALL = ["stock", "etf", "crypto", "commodity", "fx"];

function candles(n: number) {
  return Array.from({ length: n }, (_, i) => ({ close: 100 + i }));
}

beforeEach(() => {
  primeDailyCandles.mockClear();
  candlesBySymbol.clear();
});

describe("classesFromUniverse", () => {
  it("returns the full default set for non-array input", () => {
    for (const bad of [null, undefined, {}, "stock", 42]) {
      expect(classesFromUniverse(bad)).toEqual(ALL);
    }
  });

  it("keeps only recognised asset classes", () => {
    expect(classesFromUniverse(["stock", "bond", "crypto", 7, null])).toEqual(["stock", "crypto"]);
  });

  it("returns an empty list for an array with no valid classes (not the default set)", () => {
    // An explicit but unusable config must not silently re-open every class.
    expect(classesFromUniverse(["bond", "reit"])).toEqual([]);
    expect(classesFromUniverse([])).toEqual([]);
  });

  it("preserves duplicates and order as given", () => {
    expect(classesFromUniverse(["fx", "stock", "fx"])).toEqual(["fx", "stock", "fx"]);
  });
});

describe("buildCandidateFeatures", () => {
  const cand = (symbol: string, asset_class = "stock" as const) => ({
    symbol,
    name: `${symbol} Inc`,
    asset_class,
  });

  it("primes the candle cache once for the whole universe before fetching", async () => {
    candlesBySymbol.set("AAPL", candles(60));
    candlesBySymbol.set("MSFT", candles(60));
    await buildCandidateFeatures([cand("AAPL"), cand("MSFT")] as never, "2026-08-03");
    expect(primeDailyCandles).toHaveBeenCalledTimes(1);
    expect(primeDailyCandles).toHaveBeenCalledWith(["AAPL", "MSFT"], 260, "2026-08-03");
  });

  it("skips symbols with fewer than 5 candles", async () => {
    candlesBySymbol.set("THIN", candles(4));
    candlesBySymbol.set("OK", candles(60));
    const rows = await buildCandidateFeatures([cand("THIN"), cand("OK")] as never, "2026-08-03");
    expect(rows.map((r) => r.symbol)).toEqual(["OK"]);
  });

  it("includes a symbol sitting exactly on the 5-candle boundary", async () => {
    candlesBySymbol.set("EDGE", candles(5));
    const rows = await buildCandidateFeatures([cand("EDGE")] as never, "2026-08-03");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(104); // last close
  });

  it("returns an empty array when no symbol has data", async () => {
    const rows = await buildCandidateFeatures([cand("A"), cand("B")] as never, "2026-08-03");
    expect(rows).toEqual([]);
    expect(primeDailyCandles).toHaveBeenCalledTimes(1);
  });

  it("handles an empty candidate list", async () => {
    const rows = await buildCandidateFeatures([] as never, "2026-08-03");
    expect(rows).toEqual([]);
    expect(primeDailyCandles).toHaveBeenCalledWith([], 260, "2026-08-03");
  });

  it("carries indicator values through unchanged", async () => {
    candlesBySymbol.set("AAPL", candles(60));
    const [row] = await buildCandidateFeatures([cand("AAPL")] as never, "2026-08-03");
    expect(row).toMatchObject({
      symbol: "AAPL",
      name: "AAPL Inc",
      asset_class: "stock",
      price: 159,
      sma20: 20,
      sma50: 50,
      rsi14: 55,
      change5d: 0.05,
      change30d: 0.3,
      vol20d: 0.012,
      macd_hist: 0.5,
      macd_bull_cross: true,
      macd_bear_cross: false,
      bb_width: 0.04,
      atr_pct: 0.02,
      adv_20d: 1_000_000,
      vw_momentum_10d: 0.03,
      weekly_trend_up: true,
      weekly_rsi14: 61,
    });
  });

  it("degrades to nulls/false when MACD and the weekly snapshot are unavailable", async () => {
    candlesBySymbol.set("SHORT", candles(10));
    const [row] = await buildCandidateFeatures([cand("SHORT")] as never, "2026-08-03");
    expect(row.macd_hist).toBeNull();
    expect(row.macd_bull_cross).toBe(false);
    expect(row.macd_bear_cross).toBe(false);
    expect(row.weekly_trend_up).toBe(false);
    expect(row.weekly_rsi14).toBeNull();
    // sma50 is null on a short history but the row is still emitted.
    expect(row.sma50).toBeNull();
  });

  it("initialises the later-stage placeholder fields consistently", async () => {
    candlesBySymbol.set("AAPL", candles(60));
    const [row] = await buildCandidateFeatures([cand("AAPL")] as never, "2026-08-03");
    expect(row.news_score).toBeNull();
    expect(row.news_contributors).toBe(0);
    expect(row.news_momentum).toBeNull();
    expect(row.event_features).toBeNull();
    expect(row.cooling).toBe(false);
    expect(row.rank_info).toBeNull();
  });

  it("preserves the candidate's own asset_class rather than inferring one", async () => {
    candlesBySymbol.set("BTC-USD", candles(60));
    const [row] = await buildCandidateFeatures(
      [cand("BTC-USD", "crypto" as never)] as never,
      "2026-08-03",
    );
    expect(row.asset_class).toBe("crypto");
  });
});
