import { describe, expect, it } from "vitest";
import {
  computeStrategyPerformance,
  drawdownEpisodes,
  MIN_DAYS_TO_ANNUALISE,
} from "@/lib/strategy-performance";

const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return d.toISOString().slice(0, 10);
};

describe("computeStrategyPerformance", () => {
  it("withholds an annualised return until the window is long enough", () => {
    const p = computeStrategyPerformance(
      Array.from({ length: 5 }, (_, i) => ({ date: day(i), value: 10_000 * (1 + i * 0.01) })),
    );
    expect(p.annualisedReturnPct).toBeNull();
    expect(p.totalReturnPct).toBeCloseTo(4, 6);
  });

  it("annualises a year of steady growth to roughly the yearly rate", () => {
    const n = 366;
    const daily = Math.pow(1.1, 1 / 365) - 1;
    const p = computeStrategyPerformance(
      Array.from({ length: n }, (_, i) => ({ date: day(i), value: 10_000 * Math.pow(1 + daily, i) })),
    );
    expect(p.days).toBe(n);
    expect(p.annualisedReturnPct).not.toBeNull();
    expect(p.annualisedReturnPct!).toBeGreaterThan(9);
    expect(p.annualisedReturnPct!).toBeLessThan(11);
    expect(p.maxDrawdownPct).toBe(0);
    expect(p.sharpe).toBeGreaterThan(0);
  });

  it("reports drawdown episodes with recovery, deepest first", () => {
    const values = [100, 110, 99, 105, 111, 90, 95, 112];
    const eps = drawdownEpisodes(values.map((v, i) => ({ date: day(i), value: v })));
    expect(eps.length).toBe(2);
    expect(eps[0]!.depthPct).toBeCloseTo(((90 - 111) / 111) * 100, 6);
    expect(eps[0]!.recoveryDate).toBe(day(7));
    expect(eps[1]!.depthPct).toBeCloseTo(((99 - 110) / 110) * 100, 6);
  });

  it("marks an unrecovered final drawdown as open and shows the gap to the high", () => {
    const p = computeStrategyPerformance(
      [100, 120, 90].map((v, i) => ({ date: day(i), value: v })),
    );
    expect(p.drawdowns[0]!.recoveryDate).toBeNull();
    expect(p.currentDrawdownPct).toBeCloseTo(-25, 6);
    expect(MIN_DAYS_TO_ANNUALISE).toBe(30);
  });
});
