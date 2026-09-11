import { describe, expect, it } from "vitest";
import { alignSeriesCommonWindow, calculatePerformance, cleanPriceSeries, mergeNormalisedSeries, normalizeReturns, targetAllocationReturn } from "../core-performance";

describe("core performance", () => {
  it("cleans, deduplicates and orders prices", () => {
    expect(cleanPriceSeries([{ date: "2025-01-02", close: 105 }, { date: "bad", close: 2 }, { date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 106 }])).toEqual([
      { date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 106 },
    ]);
  });

  it("calculates return, annualisation, volatility and drawdown", () => {
    const result = calculatePerformance([
      { date: "2024-01-01", close: 100 },
      { date: "2024-07-01", close: 120 },
      { date: "2025-01-01", close: 110 },
    ]);
    expect(result?.totalReturn).toBeCloseTo(0.1);
    expect(result?.annualisedReturn).toBeCloseTo(0.1, 2);
    expect(result?.maxDrawdown).toBeCloseTo(-1 / 12);
    expect(result?.annualisedVolatility).toBeGreaterThan(0);
  });

  it("normalises each fund to a zero-percent start and merges dates", () => {
    expect(normalizeReturns([{ date: "2025-01-01", close: 20 }, { date: "2025-01-02", close: 22 }])[1].returnPct).toBeCloseTo(10);
    const rows = mergeNormalisedSeries([
      { symbol: "A", series: [{ date: "2025-01-01", close: 10 }, { date: "2025-01-02", close: 11 }] },
      { symbol: "B", series: [{ date: "2025-01-01", close: 20 }, { date: "2025-01-03", close: 18 }] },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ A: 0, B: 0 });
  });

  it("scales fund return by the configured allocation", () => {
    expect(targetAllocationReturn(0.2, 0.5)).toBeCloseTo(0.1);
    expect(targetAllocationReturn(-0.2, 0.5)).toBeCloseTo(-0.1);
  });

  it("aligns funds to the latest common start", () => {
    const aligned = alignSeriesCommonWindow([
      { series: [{ date: "2024-01-01", close: 10 }, { date: "2025-01-01", close: 12 }] },
      { series: [{ date: "2025-01-01", close: 20 }, { date: "2025-02-01", close: 21 }] },
    ]);
    expect(aligned[0].series[0].date).toBe("2025-01-01");
    expect(aligned[1].series[0].date).toBe("2025-01-01");
  });

  it("returns null for insufficient history", () => {
    expect(calculatePerformance([{ date: "2025-01-01", close: 100 }])).toBeNull();
  });
});
