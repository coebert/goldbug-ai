import { describe, expect, it } from "vitest";
import type { TopDriver } from "@/lib/breakout-diagnostics";
import {
  RISK_PROFILES,
  recommendDriverAction,
  recommendDriverActions,
  summariseActions,
} from "@/lib/breakout-driver-actions";

const driver = (over: Partial<TopDriver> = {}): TopDriver => ({
  symbol: "AAPL",
  contributionPct: 30,
  expectancyGapPct: 2,
  winRateGapPp: 5,
  confirmedTrades: 20,
  confirmedAvgReturnPct: 1.5,
  tradeSharePct: 25,
  score: 34,
  lead: "P&L share",
  gateDriver: "none",
  confidence: {
    score: 0.8,
    label: "high",
    sampleScore: 1,
    breadthScore: 0.9,
    reasons: [],
  },
  ...over,
});

describe("recommendDriverAction", () => {
  it("prioritises a high-score, high-confidence driver at every risk level", () => {
    for (const level of ["conservative", "balanced", "aggressive"] as const) {
      const rec = recommendDriverAction(driver(), level);
      expect(rec.action).toBe("prioritise");
      expect(rec.sizeMultiplier).toBe(RISK_PROFILES[level].prioritySize);
    }
  });

  it("scales size up with risk appetite for the same driver", () => {
    const c = recommendDriverAction(driver(), "conservative").sizeMultiplier;
    const b = recommendDriverAction(driver(), "balanced").sizeMultiplier;
    const a = recommendDriverAction(driver(), "aggressive").sizeMultiplier;
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
  });

  it("downsizes a thin-confidence row instead of prioritising it", () => {
    const d = driver({ confidence: { ...driver().confidence, score: 0.3, label: "low" } });
    const rec = recommendDriverAction(d, "balanced");
    expect(rec.action).toBe("downsize");
    expect(rec.reason).toContain("confidence");
  });

  it("avoids rows at or below the risk floor, and the floor loosens with appetite", () => {
    const d = driver({ score: -10, contributionPct: -10 });
    expect(recommendDriverAction(d, "conservative").action).toBe("avoid");
    expect(recommendDriverAction(d, "balanced").action).toBe("avoid");
    const agg = recommendDriverAction(d, "aggressive");
    expect(agg.action).toBe("downsize");
    expect(agg.sizeMultiplier).toBeGreaterThan(0);
  });

  it("trades at baseline when the score is positive but under the priority bar", () => {
    const rec = recommendDriverAction(driver({ score: 5 }), "balanced");
    expect(rec.action).toBe("trade");
    expect(rec.sizeMultiplier).toBe(RISK_PROFILES.balanced.fullSize);
  });
});

describe("summariseActions", () => {
  it("counts the action mix", () => {
    const recs = recommendDriverActions(
      [driver(), driver({ symbol: "B", score: 5 }), driver({ symbol: "C", score: -50 })],
      "balanced",
    );
    expect(summariseActions(recs, "balanced")).toBe(
      "Balanced: 1 prioritise · 1 trade · 0 downsize · 1 avoid",
    );
  });

  it("handles an empty set", () => {
    expect(summariseActions([], "balanced")).toContain("No ranked drivers");
  });
});
