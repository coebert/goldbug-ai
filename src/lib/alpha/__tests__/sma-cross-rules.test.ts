import { describe, it, expect } from "vitest";
import {
  computeSmaCrossState,
  smaCrossBuyRule,
  smaCrossSellRule,
  DEFAULT_SMA_CROSS_RULES,
  type SmaCrossRuleConfig,
} from "../sma-cross-rules";

/** Build a series: `n` bars trending at `slope` per bar from `start`. */
function ramp(start: number, slope: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + slope * i);
}

const cfg = (o: Partial<SmaCrossRuleConfig> = {}): SmaCrossRuleConfig => ({
  ...DEFAULT_SMA_CROSS_RULES,
  ...o,
});

describe("computeSmaCrossState", () => {
  it("degrades to an insufficient, signal-free state with short history", () => {
    const s = computeSmaCrossState(ramp(100, 0.1, 40))!;
    expect(s.quality).toBe("insufficient");
    expect(s.fastCross).toBeNull();
    expect(s.regime).toBeNull();
  });

  it("detects a fresh bullish SMA20/50 cross after a downtrend reverses", () => {
    const closes = [...ramp(200, -1, 120), ...ramp(80, 4, 20)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    expect(s.fastCross).toBe("bull");
    expect(s.fastCrossAgeBars).toBeGreaterThan(0);
    expect(s.sma20! > s.sma50!).toBe(true);
  });

  it("detects a bearish SMA20/50 cross after an uptrend rolls over", () => {
    const closes = [...ramp(100, 1, 120), ...ramp(220, -5, 20)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    expect(s.fastCross).toBe("bear");
  });

  it("reports golden vs death regime from SMA50 vs SMA200", () => {
    const up = computeSmaCrossState(ramp(100, 0.5, 260))!;
    expect(up.regime).toBe("golden");
    const down = computeSmaCrossState(ramp(300, -0.5, 260))!;
    expect(down.regime).toBe("death");
  });

  it("suppresses a cross that has not cleared the separation band", () => {
    const closes = [...ramp(200, -1, 120), ...ramp(80, 4, 20)];
    const loose = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    const strict = computeSmaCrossState(
      closes,
      cfg({ maxCrossAgeBars: 20, fastSeparationPct: 0.9 }),
    )!;
    expect(loose.fastCross).toBe("bull");
    expect(strict.fastCross).toBeNull();
  });

  it("suppresses a stale cross beyond maxCrossAgeBars", () => {
    const closes = [...ramp(200, -1, 120), ...ramp(80, 4, 40)];
    const stale = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 2 }))!;
    expect(stale.fastCross).toBeNull();
    const wide = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 60 }))!;
    expect(wide.fastCross).toBe("bull");
    expect(wide.fastCrossAgeBars).toBeGreaterThan(2);
  });

  it("requires the new ordering to persist for confirmBars", () => {
    const closes = [...ramp(200, -1, 120), ...ramp(80, 4, 20)];
    const age = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 30 }))!.fastCrossAgeBars!;
    const unconfirmed = computeSmaCrossState(
      closes,
      cfg({ maxCrossAgeBars: 30, confirmBars: age + 5 }),
    )!;
    expect(unconfirmed.fastCross).toBeNull();
  });
});

describe("smaCrossBuyRule", () => {
  it("blocks new buys in a death-cross regime by default", () => {
    const s = computeSmaCrossState(ramp(300, -0.5, 260))!;
    const r = smaCrossBuyRule(s);
    expect(r.allow).toBe(false);
    expect(r.sizeMultiplier).toBe(0);
    expect(r.reason).toMatch(/death cross/);
  });

  it("allows a haircut buy in death regime when deathSizeMult > 0", () => {
    const s = computeSmaCrossState(ramp(300, -0.5, 260))!;
    const r = smaCrossBuyRule(s, cfg({ deathSizeMult: 0.4 }));
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBeCloseTo(0.4, 10);
  });

  it("upsizes buys in a golden regime", () => {
    const s = computeSmaCrossState(ramp(100, 0.5, 260))!;
    const r = smaCrossBuyRule(s, cfg({ goldenSizeMult: 1.2, fastBullSizeMult: 1 }));
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBeCloseTo(1.2, 10);
  });

  it("stacks the fast bull-cross multiplier on top of the golden regime", () => {
    const state = {
      price: 110,
      sma20: 105,
      sma50: 100,
      sma200: 90,
      fastCross: "bull" as const,
      fastCrossAgeBars: 0,
      regimeCross: null,
      regimeCrossAgeBars: 30,
      regime: "golden" as const,
      fastSeparationPct: 0.05,
      regimeSeparationPct: 0.11,
      bars: 260,
      droppedBars: 0,
      quality: "full" as const,
      regimeUnknown: false,
      warnings: [],
    };
    const r = smaCrossBuyRule(state, cfg({ goldenSizeMult: 1.1, fastBullSizeMult: 1.2, maxSizeMult: 2 }));
    expect(r.sizeMultiplier).toBeCloseTo(1.32, 6);
    expect(r.reason).toMatch(/SMA20/);

    // With the risk profile's ceiling in force, the stack is clamped to it.
    const bounded = smaCrossBuyRule(state, cfg({ goldenSizeMult: 1.1, fastBullSizeMult: 1.2, maxSizeMult: 1.25 }));
    expect(bounded.sizeMultiplier).toBeCloseTo(1.25, 10);
    expect(bounded.sizing?.clamped).toBe(true);
  });

  it("cuts size proportionally when the fast trend rolls over inside a golden regime", () => {
    const closes = [...ramp(100, 1, 220), ...ramp(320, -6, 15)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    expect(s.regime).toBe("golden");
    expect(s.fastCross).toBe("bear");
    const r = smaCrossBuyRule(s, cfg({ maxCrossAgeBars: 20, goldenSizeMult: 1 }));
    // Between the bear-cross floor (0.5) and no cut at all — the exact point
    // depends on how deep and how fresh the rollover is.
    expect(r.sizeMultiplier).toBeGreaterThanOrEqual(0.5);
    expect(r.sizeMultiplier).toBeLessThan(1);

    // A deeper, fresher rollover must cut harder than a shallow one.
    const shallow = smaCrossBuyRule(
      { ...s, fastSeparationPct: -0.0025, fastCrossAgeBars: 9 },
      cfg({ maxCrossAgeBars: 20, goldenSizeMult: 1 }),
    );
    const deep = smaCrossBuyRule(
      { ...s, fastSeparationPct: -0.09, fastCrossAgeBars: 0 },
      cfg({ maxCrossAgeBars: 20, goldenSizeMult: 1 }),
    );
    expect(deep.sizeMultiplier).toBeLessThan(shallow.sizeMultiplier);
    expect(deep.sizeMultiplier).toBeCloseTo(0.5, 6);
  });

  it("is a no-op when disabled or when state is missing", () => {
    expect(smaCrossBuyRule(null)).toMatchObject({ allow: true, sizeMultiplier: 1 });
    const s = computeSmaCrossState(ramp(300, -0.5, 260))!;
    expect(smaCrossBuyRule(s, cfg({ enabled: false }))).toMatchObject({ allow: true, sizeMultiplier: 1 });
  });
});

describe("smaCrossSellRule", () => {
  it("fully exits on a fresh death cross", () => {
    const closes = [...ramp(100, 1, 220), ...ramp(320, -8, 40)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 40 }))!;
    expect(s.regimeCross).toBe("death");
    const r = smaCrossSellRule(s, cfg({ maxCrossAgeBars: 40 }));
    expect(r.sell).toBe(true);
    expect(r.sellFraction).toBe(1);
    expect(r.reason).toMatch(/death cross/);
  });

  it("respects a configurable partial death-cross exit", () => {
    const closes = [...ramp(100, 1, 220), ...ramp(320, -8, 40)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 40 }))!;
    const r = smaCrossSellRule(s, cfg({ maxCrossAgeBars: 40, deathSellFraction: 0.35 }));
    expect(r.sellFraction).toBeCloseTo(0.35, 10);
  });

  it("trims on a confirmed SMA20↓SMA50 cross with price below SMA50", () => {
    const closes = [...ramp(100, 1, 120), ...ramp(220, -5, 20)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    const r = smaCrossSellRule(s, cfg({ maxCrossAgeBars: 20, fastBearSellFraction: 0.5 }));
    expect(r.sell).toBe(true);
    expect(r.sellFraction).toBeCloseTo(0.5, 10);
  });

  it("does not sell on a bull cross or with no cross", () => {
    const up = computeSmaCrossState(ramp(100, 0.5, 260))!;
    expect(smaCrossSellRule(up).sell).toBe(false);
    expect(smaCrossSellRule(null).sell).toBe(false);
  });

  it("never returns a sell fraction outside [0, 1]", () => {
    const closes = [...ramp(100, 1, 220), ...ramp(320, -8, 40)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 40 }))!;
    expect(smaCrossSellRule(s, cfg({ maxCrossAgeBars: 40, deathSellFraction: 5 })).sellFraction).toBe(1);
    const neg = smaCrossSellRule(s, cfg({ maxCrossAgeBars: 40, deathSellFraction: -1 }));
    expect(neg.sellFraction).toBeGreaterThanOrEqual(0);
    expect(neg.sellFraction).toBeLessThanOrEqual(1);
  });
});
