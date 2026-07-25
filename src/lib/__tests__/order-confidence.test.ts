import { describe, it, expect } from "vitest";
import {
  computeOrderConfidence,
  confidenceTone,
  type ConfidenceRegime,
} from "@/lib/order-confidence";

const stableRegime: ConfidenceRegime = {
  regime: "risk_on",
  confidence: 0.8,
  transitioned: false,
  previous_regime: "risk_on",
};

const shiftedRegime: ConfidenceRegime = {
  regime: "risk_off",
  confidence: 0.9,
  transitioned: true,
  previous_regime: "risk_on",
};

describe("computeOrderConfidence", () => {
  it("defaults conviction to 0.5 when the model omitted one", () => {
    const r = computeOrderConfidence({ side: "buy" });
    expect(r.base).toBe(0.5);
    // No regime + no news → factors are 1 → score = 50.
    expect(r.score).toBe(50);
  });

  it("boosts a buy when news is aligned and the regime is stable", () => {
    const r = computeOrderConfidence({
      side: "buy",
      conviction: 0.7,
      regime: stableRegime,
      relatedNews: [
        { headline: "Beats earnings", sentiment: 0.8, source_weight: 1 },
        { headline: "Analyst upgrade", sentiment: 0.6, source_weight: 1 },
      ],
    });
    expect(r.regimeFactor).toBeGreaterThan(1);
    expect(r.newsFactor).toBeGreaterThan(1);
    expect(r.score).toBeGreaterThan(70);
  });

  it("trims confidence sharply when the regime just transitioned", () => {
    const stable = computeOrderConfidence({
      side: "buy",
      conviction: 0.8,
      regime: stableRegime,
    });
    const shifted = computeOrderConfidence({
      side: "buy",
      conviction: 0.8,
      regime: shiftedRegime,
    });
    expect(shifted.score).toBeLessThan(stable.score);
    expect(shifted.regimeFactor).toBe(0.75);
    const item = shifted.breakdown.find((b) => b.label.includes("Regime shift"));
    expect(item?.delta).toBeLessThan(0);
  });

  it("inverts news polarity for sell orders", () => {
    const news = [{ headline: "Guidance cut", sentiment: -0.8, source_weight: 1 }];
    const buy = computeOrderConfidence({ side: "buy", conviction: 0.6, relatedNews: news });
    const sell = computeOrderConfidence({ side: "sell", conviction: 0.6, relatedNews: news });
    // Bearish news should hurt a buy and help a sell.
    expect(buy.newsFactor).toBeLessThan(1);
    expect(sell.newsFactor).toBeGreaterThan(1);
    expect(sell.score).toBeGreaterThan(buy.score);
  });

  it("weights headlines by source credibility", () => {
    const balanced = computeOrderConfidence({
      side: "buy",
      conviction: 0.5,
      relatedNews: [
        { headline: "Reputable outlet: bullish", sentiment: 0.8, source_weight: 3 },
        { headline: "Blog: bearish", sentiment: -0.8, source_weight: 0.5 },
      ],
    });
    expect(balanced.newsFactor).toBeGreaterThan(1);
  });

  it("returns neutral factors for empty news / no regime", () => {
    const r = computeOrderConfidence({ side: "buy", conviction: 0.6 });
    expect(r.regimeFactor).toBe(1);
    expect(r.newsFactor).toBe(1);
    expect(r.score).toBe(60);
    expect(r.breakdown).toHaveLength(3);
  });

  it("clamps score to [0,100]", () => {
    const r = computeOrderConfidence({
      side: "buy",
      conviction: 2 as number, // out-of-range guard
      regime: stableRegime,
    });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.base).toBe(1);
  });

  it("ignores zero-weight news gracefully", () => {
    const r = computeOrderConfidence({
      side: "buy",
      conviction: 0.5,
      relatedNews: [{ headline: "x", sentiment: 0.9, source_weight: 0 }],
    });
    expect(r.newsFactor).toBe(1);
  });

  it("confidenceTone maps to bands correctly", () => {
    expect(confidenceTone(80)).toBe("high");
    expect(confidenceTone(50)).toBe("medium");
    expect(confidenceTone(20)).toBe("low");
    expect(confidenceTone(65)).toBe("high");
    expect(confidenceTone(64)).toBe("medium");
    expect(confidenceTone(40)).toBe("medium");
    expect(confidenceTone(39)).toBe("low");
  });
});
