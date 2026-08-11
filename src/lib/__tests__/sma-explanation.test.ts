import { describe, expect, it } from "vitest";
import { buildSmaExplanation, smaSignalStrength } from "@/lib/sma-explanation";
import type { SmaCrossState } from "@/lib/alpha/sma-cross-rules";

const base: SmaCrossState = {
  price: 100,
  sma20: 98,
  sma50: 95,
  sma200: 88,
  fastCross: null,
  fastCrossAgeBars: null,
  regimeCross: null,
  regimeCrossAgeBars: null,
  regime: "golden",
  fastSeparationPct: (98 - 95) / 95,
  regimeSeparationPct: (95 - 88) / 88,
  bars: 400,
  droppedBars: 0,
  quality: "full",
  regimeUnknown: false,
  warnings: [],
};

describe("buildSmaExplanation", () => {
  it("reports missing telemetry without blaming the trade", () => {
    const x = buildSmaExplanation({ state: null, side: "buy", riskLevel: "balanced" });
    expect(x.available).toBe(false);
    expect(x.influence.kind).toBe("unavailable");
    expect(x.strength).toBe(0);
  });

  it("explains an upsized buy on a fresh bull cross in a golden regime", () => {
    const x = buildSmaExplanation({
      state: { ...base, fastCross: "bull", fastCrossAgeBars: 2 },
      side: "buy",
      riskLevel: "balanced",
    });
    expect(x.fast.direction).toBe("bull");
    expect(x.regime.state).toBe("golden");
    expect(x.influence.kind).toBe("upsized");
    expect(x.influence.sizeMultiplier).toBeGreaterThan(1);
    expect(x.values.fastSpreadPct).toBeCloseTo(3.16, 1);
  });

  it("blocks buys in a death regime under conservative risk but only sizes down when aggressive", () => {
    const death: SmaCrossState = {
      ...base,
      sma20: 88,
      sma50: 90,
      sma200: 100,
      regime: "death",
      fastSeparationPct: (88 - 90) / 90,
      regimeSeparationPct: (90 - 100) / 100,
    };
    const conservative = buildSmaExplanation({ state: death, side: "buy", riskLevel: "conservative" });
    const aggressive = buildSmaExplanation({ state: death, side: "buy", riskLevel: "aggressive" });
    expect(conservative.influence.kind).toBe("blocked");
    expect(conservative.influence.sizeMultiplier).toBe(0);
    expect(aggressive.influence.kind).toBe("downsized");
    expect(aggressive.influence.sizeMultiplier).toBeGreaterThan(0);
  });

  it("describes a trim vs a full exit on the sell side", () => {
    const bear: SmaCrossState = {
      ...base,
      price: 90,
      sma20: 92,
      sma50: 95,
      fastCross: "bear",
      fastCrossAgeBars: 1,
      fastSeparationPct: (92 - 95) / 95,
    };
    const balanced = buildSmaExplanation({ state: bear, side: "sell", riskLevel: "balanced" });
    expect(balanced.influence.kind).toBe("trim");
    expect(balanced.influence.sellFraction).toBeCloseTo(0.5, 5);

    const deathCross: SmaCrossState = {
      ...bear,
      regime: "death",
      regimeCross: "death",
      regimeCrossAgeBars: 1,
      regimeSeparationPct: -0.02,
    };
    const exit = buildSmaExplanation({ state: deathCross, side: "sell", riskLevel: "balanced" });
    expect(exit.influence.kind).toBe("exit");
  });

  it("flags an unknown regime for newly listed symbols instead of guessing", () => {
    const x = buildSmaExplanation({
      state: { ...base, sma200: null, regime: null, regimeUnknown: true, bars: 90, quality: "partial", regimeSeparationPct: null },
      side: "buy",
      riskLevel: "balanced",
    });
    expect(x.regime.state).toBe("unknown");
    expect(x.influence.kind).toBe("downsized");
    expect(x.bullets.some((b) => b.includes("SMA200 unavailable"))).toBe(true);
  });

  it("scores strength deterministically and higher for wide, fresh, aligned crosses", () => {
    const weak = smaSignalStrength({ ...base, fastSeparationPct: 0.0005, regimeSeparationPct: 0.001 }, 10);
    const strong = smaSignalStrength(
      { ...base, fastCross: "bull", fastCrossAgeBars: 0, fastSeparationPct: 0.05, regimeSeparationPct: 0.12 },
      10,
    );
    expect(strong).toBeGreaterThan(weak);
    expect(smaSignalStrength(base, 10)).toBe(smaSignalStrength(base, 10));
  });
});
