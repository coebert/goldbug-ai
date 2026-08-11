import { describe, it, expect } from "vitest";
import {
  compareHolding,
  comparePortfolio,
  pickBenchmark,
  returnSincePct,
  windowReturnPct,
  type PricePoint,
} from "@/lib/relative-strength";

function series(start: number, steps: number[], from = "2026-01-01"): PricePoint[] {
  const out: PricePoint[] = [];
  let px = start;
  const d = new Date(from);
  for (let i = 0; i < steps.length; i++) {
    px = px * (1 + steps[i]!);
    const dt = new Date(d.getTime() + i * 86400000);
    out.push({ date: dt.toISOString().slice(0, 10), close: px });
  }
  return out;
}

function flat(n: number, px: number, from = "2026-01-01"): PricePoint[] {
  return series(px, new Array(n).fill(0), from).map((p) => ({ ...p, close: px }));
}

describe("pickBenchmark", () => {
  it("maps each venue to its own market average", () => {
    expect(pickBenchmark("MKS.L").symbol).toBe("ISF.L");
    expect(pickBenchmark("MKS:xlon").symbol).toBe("ISF.L");
    expect(pickBenchmark("AAPL").symbol).toBe("SPY");
    expect(pickBenchmark("V:xnys").symbol).toBe("SPY");
    expect(pickBenchmark("BTCE.DE").symbol).toBe("EFA");
    expect(pickBenchmark("ETH-USD").symbol).toBe("BTC-USD");
    expect(pickBenchmark("GLD", "commodity").symbol).toBe("GLD");
  });
});

describe("window returns", () => {
  it("computes trailing session returns", () => {
    const s: PricePoint[] = [
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 110 },
    ];
    expect(windowReturnPct(s, 1)).toBeCloseTo(10, 6);
    expect(windowReturnPct(s, 5)).toBeNull();
  });

  it("ignores malformed bars and sorts by date", () => {
    const s = [
      { date: "2026-01-03", close: 120 },
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 0 },
    ];
    expect(windowReturnPct(s, 1)).toBeCloseTo(20, 6);
  });

  it("measures return since a date", () => {
    const s: PricePoint[] = [
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-05", close: 200 },
      { date: "2026-01-09", close: 300 },
    ];
    expect(returnSincePct(s, "2026-01-05T10:00:00Z")).toBeCloseTo(50, 6);
    expect(returnSincePct(s, null)).toBeCloseTo(200, 6);
  });
});

describe("compareHolding", () => {
  const bench = { symbol: "SPY", label: "S&P 500" };

  it("flags a holding that gains less than its index as lagging", () => {
    const cmp = compareHolding({
      holding: { symbol: "AAPL", quantity: 10, avgCost: 100, openedAt: "2026-01-01" },
      series: flat(30, 105),
      benchmark: bench,
      benchmarkSeries: series(100, [0, ...new Array(29).fill(0.01)]),
    });
    expect(cmp.sincePurchasePct).toBeCloseTo(5, 6);
    expect(cmp.benchmarkSincePurchasePct!).toBeGreaterThan(5);
    expect(cmp.verdict).toBe("lagging");
    expect(cmp.excessValue!).toBeLessThan(0);
    expect(cmp.note).toContain("behind");
  });

  it("flags outperformance and prices the gap in money", () => {
    const cmp = compareHolding({
      holding: { symbol: "MSFT", quantity: 4, avgCost: 100, openedAt: "2026-01-01" },
      series: flat(30, 120),
      benchmark: bench,
      benchmarkSeries: flat(30, 100),
    });
    expect(cmp.verdict).toBe("leading");
    // 400 invested, +20pp of excess -> +80 of value versus the index.
    expect(cmp.excessValue).toBeCloseTo(80, 6);
    expect(cmp.value).toBeCloseTo(480, 6);
  });

  it("returns unknown rather than guessing when there is no price history", () => {
    const cmp = compareHolding({
      holding: { symbol: "NEW", quantity: 1, avgCost: 10, openedAt: null },
      series: [],
      benchmark: bench,
      benchmarkSeries: flat(30, 100),
    });
    expect(cmp.verdict).toBe("unknown");
    expect(cmp.price).toBeNull();
    expect(cmp.windows.every((w) => w.excessPct === null)).toBe(true);
  });

  it("is unit-agnostic for window returns (GBX vs GBP scaling cancels)", () => {
    const gbp = compareHolding({
      holding: { symbol: "MKS.L", quantity: 1, avgCost: 4, openedAt: "2026-01-01" },
      series: series(4, [0, 0.02, 0.03]),
      benchmark: bench,
      benchmarkSeries: series(80, [0, 0.01, 0.01]),
    });
    const gbx = compareHolding({
      holding: { symbol: "MKS.L", quantity: 1, avgCost: 400, openedAt: "2026-01-01" },
      series: series(400, [0, 0.02, 0.03]),
      benchmark: bench,
      benchmarkSeries: series(8000, [0, 0.01, 0.01]),
    });
    expect(gbx.windows[0]!.excessPct).toBeCloseTo(gbp.windows[0]!.excessPct!, 9);
    expect(gbx.sincePurchaseExcessPct).toBeCloseTo(gbp.sincePurchaseExcessPct!, 9);
  });
});

describe("comparePortfolio", () => {
  const bench = { symbol: "SPY", label: "S&P 500" };
  const leader = compareHolding({
    holding: { symbol: "BIG", quantity: 100, avgCost: 100, openedAt: "2026-01-01" },
    series: flat(30, 110),
    benchmark: bench,
    benchmarkSeries: flat(30, 100),
  });
  const laggard = compareHolding({
    holding: { symbol: "SMALL", quantity: 1, avgCost: 100, openedAt: "2026-01-01" },
    series: flat(30, 50),
    benchmark: bench,
    benchmarkSeries: flat(30, 100),
  });

  it("weights the headline by position value, not by count", () => {
    const agg = comparePortfolio([leader, laggard]);
    expect(agg.leaders).toBe(1);
    expect(agg.laggards).toBe(1);
    // 11,000 of leader at +10pp vs 50 of laggard at -50pp -> still positive.
    expect(agg.weightedSincePurchaseExcess!).toBeGreaterThan(0);
    expect(agg.totalValue).toBeCloseTo(11050, 6);
  });

  it("sorts holdings worst-to-best by excess and sums money left on the table", () => {
    const agg = comparePortfolio([laggard, leader]);
    expect(agg.holdings[0]!.symbol).toBe("BIG");
    expect(agg.totalExcessValue).toBeCloseTo(1000 - 50, 6);
  });

  it("handles an empty book without dividing by zero", () => {
    const agg = comparePortfolio([]);
    expect(agg.weightedSincePurchaseExcess).toBeNull();
    expect(agg.totalExcessValue).toBe(0);
    expect(agg.totalValue).toBe(0);
  });
});
