import { describe, expect, it } from "vitest";
import { applyLiveQuotes, repriceQuote, type LiveQuoteResult } from "./live-quotes";
import type { MarketPulse, PulseQuote } from "./market-pulse";

const quote = (over: Partial<PulseQuote> = {}): PulseQuote => ({
  symbol: "SPY",
  label: "S&P 500",
  group: "equities",
  close: 100,
  asOf: "2026-09-04",
  changePct1d: 1,
  changePct5d: 2,
  changePct1m: 5,
  changePct3m: 10,
  vsSma50Pct: 25,
  aboveSma50: true,
  spark: [
    { date: "2026-09-03", value: 99 },
    { date: "2026-09-04", value: 100 },
  ],
  ...over,
});

const live = (over: Partial<LiveQuoteResult["quotes"][string]> = {}): LiveQuoteResult => ({
  quotes: {
    SPY: {
      symbol: "SPY",
      price: 110,
      previousClose: 100,
      changePct: 10,
      currency: "USD",
      at: "2026-09-05T14:00:00.000Z",
      source: "public",
      ...over,
    },
  },
  asOf: "2026-09-05T14:00:00.000Z",
  requested: 1,
  covered: 1,
  fromBroker: 0,
  stale: false,
});

describe("repriceQuote", () => {
  it("takes the day move straight from the feed", () => {
    const out = repriceQuote(quote(), live().quotes["SPY"]!);
    expect(out.close).toBe(110);
    expect(out.changePct1d).toBeCloseTo(10);
    expect(out.asOf).toBe("2026-09-05");
  });

  it("derives the day move from the previous close when the feed omits a percentage", () => {
    const out = repriceQuote(quote(), live({ changePct: null, previousClose: 100 }).quotes["SPY"]!);
    expect(out.changePct1d).toBeCloseTo(10);
  });

  it("rescales multi-day moves onto the new price", () => {
    const out = repriceQuote(quote(), live().quotes["SPY"]!);
    // 5d was +2% into 100; a further 10% lifts the window to ~12.2%.
    expect(out.changePct5d).toBeCloseTo(12.2, 5);
  });

  it("keeps multi-day windows unchanged when the tape already covers today", () => {
    const l = live({ at: "2026-09-04T14:00:00.000Z" }).quotes["SPY"]!;
    const out = repriceQuote(quote(), l);
    expect(out.changePct5d).toBeCloseTo(2);
    expect(out.spark).toHaveLength(2);
  });

  it("recomputes the trend flag against the 50-day average", () => {
    const out = repriceQuote(quote({ close: 100, vsSma50Pct: 25 }), live({ price: 70 }).quotes["SPY"]!);
    expect(out.aboveSma50).toBe(false);
  });

  it("ignores nonsense ticks", () => {
    const out = repriceQuote(quote(), live({ price: 0 }).quotes["SPY"]!);
    expect(out.close).toBe(100);
  });
});

describe("applyLiveQuotes", () => {
  const pulse: MarketPulse = {
    asOf: "2026-09-04",
    tone: "neutral",
    toneScore: 50,
    toneReasons: [],
    quotes: [quote(), quote({ symbol: "TLT", label: "Treasuries", changePct1d: -1 })],
    sectors: [],
    breadth: {
      total: 2,
      advancers: 1,
      decliners: 1,
      aboveSma50: 2,
      aboveSma50Pct: 100,
      advancersPct: 50,
    },
    comparison: [],
  };

  it("returns the pulse untouched when there are no ticks", () => {
    expect(applyLiveQuotes(pulse, null)).toBe(pulse);
    expect(applyLiveQuotes(pulse, { ...live(), covered: 0, quotes: {} })).toBe(pulse);
  });

  it("re-prices covered rows and recomputes breadth", () => {
    const out = applyLiveQuotes(pulse, live());
    expect(out.quotes[0]!.close).toBe(110);
    expect(out.quotes[1]!.close).toBe(100);
    expect(out.breadth.advancers).toBe(1);
    expect(out.asOf).toBe("2026-09-05");
  });

  it("preserves extra fields carried on the pulse payload", () => {
    const extended = { ...pulse, alerts: [{ id: "x" }] };
    const out = applyLiveQuotes(extended, live());
    expect(out.alerts).toEqual([{ id: "x" }]);
  });
});
