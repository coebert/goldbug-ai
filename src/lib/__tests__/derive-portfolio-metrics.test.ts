import { describe, it, expect } from "vitest";
import { derivePortfolioMetrics } from "../derive-portfolio-metrics";

describe("derivePortfolioMetrics", () => {
  it("uses the snapshot's total_value and cash when present (FX-normalised)", () => {
    const m = derivePortfolioMetrics({
      latestSnapshot: { total_value: 301.89, cash: 100 },
      currentCash: 150, // stale — snapshot wins
      holdings: [{ quantity: 10, avg_cost: 999 }], // native units — ignored
    });
    expect(m.source).toBe("snapshot");
    expect(m.totalValue).toBe(301.89);
    expect(m.cash).toBe(100);
    expect(m.invested).toBeCloseTo(201.89, 5);
    expect(m.cash + m.invested).toBeCloseTo(m.totalValue, 5);
  });

  it("falls back to current_cash + Σ(qty × avg_cost) when no snapshot exists", () => {
    const m = derivePortfolioMetrics({
      latestSnapshot: null,
      currentCash: 500,
      holdings: [
        { quantity: 2, avg_cost: 100 },
        { quantity: 3, avg_cost: 50 },
      ],
    });
    expect(m.source).toBe("fallback_native");
    expect(m.cash).toBe(500);
    expect(m.invested).toBe(350);
    expect(m.totalValue).toBe(850);
  });

  it("falls back to portfolio.current_cash when the snapshot lacks a cash column", () => {
    const m = derivePortfolioMetrics({
      latestSnapshot: { total_value: 1000, cash: null },
      currentCash: 400,
      holdings: [],
    });
    expect(m.source).toBe("snapshot");
    expect(m.totalValue).toBe(1000);
    expect(m.cash).toBe(400);
    expect(m.invested).toBe(600);
  });

  it("clamps stale cash > total_value so invested cannot go negative", () => {
    const m = derivePortfolioMetrics({
      latestSnapshot: { total_value: 500, cash: 800 },
      currentCash: 0,
      holdings: [],
    });
    expect(m.cash).toBe(500);
    expect(m.invested).toBe(0);
    expect(m.totalValue).toBe(500);
  });

  it("coerces bad numbers (NaN/strings/negative) safely without breaking invariants", () => {
    const m = derivePortfolioMetrics({
      latestSnapshot: { total_value: "not-a-number", cash: -50 } as unknown as {
        total_value: number;
        cash: number;
      },
      currentCash: -10,
      holdings: [{ quantity: "abc" as unknown as number, avg_cost: NaN }],
    });
    // No snapshot (NaN total), fallback path, clamped to zero.
    expect(m.source).toBe("fallback_native");
    expect(m.cash).toBe(0);
    expect(m.invested).toBe(0);
    expect(m.totalValue).toBe(0);
  });

  it("keeps identity: cash + invested == totalValue on the snapshot path", () => {
    for (let i = 0; i < 200; i++) {
      const total = Math.random() * 1_000_000;
      const cash = Math.random() * total * 1.2; // sometimes exceeds
      const m = derivePortfolioMetrics({
        latestSnapshot: { total_value: total, cash },
        currentCash: 0,
        holdings: [],
      });
      expect(m.cash + m.invested).toBeCloseTo(m.totalValue, 6);
      expect(m.invested).toBeGreaterThanOrEqual(0);
      expect(m.cash).toBeGreaterThanOrEqual(0);
      expect(m.cash).toBeLessThanOrEqual(m.totalValue + 1e-9);
    }
  });
});
