import { describe, expect, it } from "vitest";
import { driverConfidence } from "@/lib/breakout-diagnostics";

const base = { minConfirmed: 3, fullSampleAt: 20, lead: "P&L share" as const };

describe("driverConfidence", () => {
  it("rates a broad, well-sampled name high", () => {
    const c = driverConfidence({
      ...base,
      confirmedTrades: 24,
      tradeSharePct: 30,
      contributionPct: 28,
    });
    expect(c.label).toBe("high");
    expect(c.sampleScore).toBe(1);
    expect(c.breadthScore).toBe(1);
  });

  it("penalises a thin sample", () => {
    const c = driverConfidence({
      ...base,
      confirmedTrades: 4,
      tradeSharePct: 5,
      contributionPct: 5,
    });
    expect(c.label).toBe("low");
    expect(c.reasons[0]).toContain("only 4");
  });

  it("penalises outlier-driven P&L concentration", () => {
    const c = driverConfidence({
      ...base,
      confirmedTrades: 20,
      tradeSharePct: 8,
      contributionPct: -60,
    });
    expect(c.breadthScore).toBeLessThan(0.2);
    expect(c.label).toBe("medium");
    expect(c.reasons.some((r) => r.includes("outlier-driven"))).toBe(true);
  });

  it("discounts expectancy-gap-led rows", () => {
    const shared = { ...base, confirmedTrades: 20, tradeSharePct: 20, contributionPct: 20 };
    const gapLed = driverConfidence({ ...shared, lead: "expectancy gap" });
    const shareLed = driverConfidence(shared);
    expect(gapLed.score).toBeLessThan(shareLed.score);
    expect(gapLed.reasons.some((r) => r.includes("expectancy gap"))).toBe(true);
  });
});
