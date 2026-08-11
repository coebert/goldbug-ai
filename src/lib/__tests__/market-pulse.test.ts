import { describe, expect, it } from "vitest";
import {
  buildComparison,
  bySymbol,
  computeBreadth,
  computeMarketPulse,
  computeTone,
  type PriceRow,
} from "@/lib/market-pulse";

function ramp(symbol: string, n: number, start: number, step: number): PriceRow[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    price_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    close: start + step * i,
  }));
}

describe("market pulse", () => {
  it("drops invalid closes and sorts each symbol oldest-first", () => {
    const map = bySymbol([
      { symbol: "SPY", price_date: "2026-01-03", close: 3 },
      { symbol: "SPY", price_date: "2026-01-01", close: 1 },
      { symbol: "SPY", price_date: "2026-01-02", close: 0 },
      { symbol: "SPY", price_date: "2026-01-04", close: Number.NaN },
    ]);
    expect(map.get("SPY")!.map((r) => r.price_date)).toEqual(["2026-01-01", "2026-01-03"]);
  });

  it("computes 1d/1m moves and trend versus the 50-day average", () => {
    const pulse = computeMarketPulse(ramp("SPY", 80, 100, 1));
    const spy = pulse.quotes.find((q) => q.symbol === "SPY")!;
    expect(spy.changePct1d).toBeCloseTo((179 - 178) / 178 * 100, 6);
    expect(spy.aboveSma50).toBe(true);
    expect(spy.vsSma50Pct).toBeGreaterThan(0);
  });

  it("counts advancers and uptrends for breadth", () => {
    const breadth = computeBreadth([
      { changePct1d: 1, aboveSma50: true },
      { changePct1d: -1, aboveSma50: false },
      { changePct1d: 2, aboveSma50: true },
      { changePct1d: null, aboveSma50: null },
    ] as never);
    expect(breadth.advancers).toBe(2);
    expect(breadth.decliners).toBe(1);
    expect(breadth.aboveSma50Pct).toBeCloseTo(66.6667, 3);
  });

  it("scores a calm, broadly rising tape as risk-on and a broken one as risk-off", () => {
    const up = computeMarketPulse([
      ...ramp("SPY", 80, 100, 1),
      ...ramp("QQQ", 80, 100, 1),
      ...ramp("XLK", 80, 100, 1),
      ...ramp("XLY", 80, 100, 1),
      ...ramp("XLP", 80, 100, 0.05),
      ...ramp("XLU", 80, 100, 0.05),
      ...ramp("^VIX", 80, 13, 0),
    ]);
    expect(up.tone).toBe("risk_on");
    expect(up.toneScore).toBeGreaterThan(60);

    const down = computeMarketPulse([
      ...ramp("SPY", 80, 180, -1),
      ...ramp("QQQ", 80, 180, -1),
      ...ramp("XLK", 80, 180, -1),
      ...ramp("XLY", 80, 180, -1),
      ...ramp("XLP", 80, 100, 0.2),
      ...ramp("XLU", 80, 100, 0.2),
      ...ramp("^VIX", 80, 35, 0),
    ]);
    expect(down.tone).toBe("risk_off");
    expect(down.toneScore).toBeLessThan(40);
  });

  it("excludes the VIX from breadth so a fear spike is not an advancer", () => {
    const pulse = computeMarketPulse([...ramp("SPY", 60, 100, 1), ...ramp("^VIX", 60, 10, 0.5)]);
    expect(pulse.breadth.advancers).toBe(1);
    expect(pulse.breadth.total).toBe(1);
  });

  it("normalises comparison lines to 100 and carries values across missing days", () => {
    const cmp = buildComparison(
      bySymbol([
        ...ramp("SPY", 4, 100, 10),
        { symbol: "GLD", price_date: "2026-01-01", close: 50 },
        { symbol: "GLD", price_date: "2026-01-04", close: 55 },
      ]),
      90,
    );
    expect(cmp.series[0]["SPY"]).toBe(100);
    expect(cmp.series[3]["SPY"]).toBe(130);
    // GLD has no 2nd Jan print — the 1st Jan value carries forward.
    expect(cmp.series[1]["GLD"]).toBe(100);
    expect(cmp.series[3]["GLD"]).toBe(110);
  });

  it("returns a neutral score when there is no data at all", () => {
    const pulse = computeMarketPulse([]);
    expect(pulse.tone).toBe("neutral");
    expect(pulse.toneScore).toBe(50);
    expect(pulse.asOf).toBeNull();
    expect(computeTone([], [], pulse.breadth).score).toBe(50);
  });
});
