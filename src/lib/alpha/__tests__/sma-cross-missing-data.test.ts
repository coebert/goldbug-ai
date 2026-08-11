import { describe, it, expect } from "vitest";
import {
  computeSmaCrossState,
  normalizeCloses,
  smaCrossBuyRule,
  smaCrossSellRule,
  DEFAULT_SMA_CROSS_RULES,
  type SmaCrossRuleConfig,
} from "../sma-cross-rules";

function ramp(start: number, slope: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + slope * i);
}
const cfg = (o: Partial<SmaCrossRuleConfig> = {}): SmaCrossRuleConfig => ({
  ...DEFAULT_SMA_CROSS_RULES,
  ...o,
});

describe("normalizeCloses", () => {
  it("drops nulls, NaN, Infinity and non-positive prices", () => {
    const { closes, dropped } = normalizeCloses([10, null, NaN, Infinity, -5, 0, 12]);
    expect(closes).toEqual([10, 12]);
    expect(dropped).toBe(5);
  });

  it("coerces numeric strings and preserves order", () => {
    const { closes, dropped } = normalizeCloses(["1.5", 2, " 3 ", "abc", ""]);
    expect(closes).toEqual([1.5, 2, 3]);
    expect(dropped).toBe(2);
  });

  it("handles non-array input without throwing", () => {
    expect(normalizeCloses(undefined)).toEqual({ closes: [], dropped: 0 });
    expect(normalizeCloses(null)).toEqual({ closes: [], dropped: 0 });
    expect(normalizeCloses("nope" as unknown)).toEqual({ closes: [], dropped: 0 });
  });
});

describe("computeSmaCrossState — missing data", () => {
  it("returns null only when there is no usable price at all", () => {
    expect(computeSmaCrossState([])).toBeNull();
    expect(computeSmaCrossState([null, NaN, -1])).toBeNull();
    expect(computeSmaCrossState(undefined)).toBeNull();
  });

  it("marks a newly listed symbol as insufficient below minBarsFast", () => {
    const s = computeSmaCrossState(ramp(100, 0.5, 30))!;
    expect(s.quality).toBe("insufficient");
    expect(s.regimeUnknown).toBe(true);
    expect(s.fastCross).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/newly listed|sparse/);
  });

  it("produces partial state with no SMA200 between 50 and 200 bars", () => {
    const s = computeSmaCrossState(ramp(100, 0.5, 120))!;
    expect(s.quality).toBe("partial");
    expect(s.regimeUnknown).toBe(true);
    expect(s.sma200).toBeNull();
    expect(s.regime).toBeNull();
    expect(s.sma50).not.toBeNull();
  });

  it("upgrades to full quality once 200+ clean bars exist", () => {
    const s = computeSmaCrossState(ramp(100, 0.5, 260))!;
    expect(s.quality).toBe("full");
    expect(s.regimeUnknown).toBe(false);
    expect(s.sma200).not.toBeNull();
    expect(s.warnings).toEqual([]);
  });

  it("tolerates a few holes and reports them", () => {
    const raw: Array<number | null> = ramp(100, 0.5, 260);
    raw[10] = null;
    raw[57] = null;
    const s = computeSmaCrossState(raw)!;
    expect(s.droppedBars).toBe(2);
    expect(s.bars).toBe(258);
    expect(s.quality).toBe("full");
    expect(s.warnings.join(" ")).toMatch(/2 invalid bar/);
  });

  it("suppresses all signals when too much of the series is invalid", () => {
    const raw: Array<number | null> = ramp(100, 0.5, 260).map((v, i) => (i % 3 === 0 ? v : null));
    const s = computeSmaCrossState(raw)!;
    expect(s.quality).toBe("insufficient");
    expect(s.sma20).toBeNull();
    expect(s.fastCross).toBeNull();
    expect(s.regime).toBeNull();
  });

  it("suppresses cross detection on a stale (flat) feed", () => {
    const closes = [...ramp(100, 1, 200), ...Array(60).fill(300)];
    const s = computeSmaCrossState(closes)!;
    expect(s.quality).toBe("partial");
    expect(s.fastCross).toBeNull();
    expect(s.regimeCross).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/flat closes/);
  });

  it("keeps SMA values finite and positive for extreme but valid prices", () => {
    const s = computeSmaCrossState(ramp(1e-4, 1e-6, 260))!;
    expect(Number.isFinite(s.sma20!)).toBe(true);
    expect(s.sma20!).toBeGreaterThan(0);
    expect(Number.isFinite(s.sma200!)).toBe(true);
  });
});

describe("rules under degraded data", () => {
  it("never blocks a buy when history is insufficient", () => {
    const s = computeSmaCrossState(ramp(300, -2, 30))!;
    const r = smaCrossBuyRule(s);
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(1);
  });

  it("sizes down instead of guessing when SMA200 is unavailable", () => {
    const s = computeSmaCrossState(ramp(100, 0.5, 120))!;
    const r = smaCrossBuyRule(s, cfg({ unknownRegimeSizeMult: 0.6, fastBullSizeMult: 1 }));
    expect(r.allow).toBe(true);
    // 120/200 bars of history → the haircut has already partly recovered.
    expect(r.sizeMultiplier).toBeCloseTo(0.6 + 0.4 * (120 / 200), 10);
    expect(r.reason).toMatch(/no SMA200/);
  });

  it("still applies the fast bull cross inside an unknown regime", () => {
    const closes = [...ramp(200, -1, 100), ...ramp(100, 4, 20)];
    const s = computeSmaCrossState(closes, cfg({ maxCrossAgeBars: 20 }))!;
    expect(s.regimeUnknown).toBe(true);
    const r = smaCrossBuyRule(
      s,
      cfg({ maxCrossAgeBars: 20, unknownRegimeSizeMult: 0.8, fastBullSizeMult: 1.25 }),
    );
    // 0.8 base × a fast-bull boost that scales with conviction, so it lands
    // above the unknown-regime haircut but no higher than the full 0.8×1.25.
    const base = 0.8 + 0.2 * (s.bars / 200);
    expect(r.sizeMultiplier).toBeGreaterThan(base);
    expect(r.sizeMultiplier).toBeLessThanOrEqual(base * 1.25 + 1e-9);
  });

  it("never sells off insufficient or unusable history", () => {
    const short = computeSmaCrossState(ramp(300, -3, 30))!;
    expect(smaCrossSellRule(short).sell).toBe(false);
    const junk = computeSmaCrossState(
      ramp(300, -1, 260).map((v, i) => (i % 3 === 0 ? v : null)),
    )!;
    expect(smaCrossSellRule(junk).sell).toBe(false);
  });

  it("keeps multipliers finite for every degraded shape", () => {
    for (const n of [1, 5, 19, 20, 49, 50, 199, 200, 260]) {
      const s = computeSmaCrossState(ramp(100, 0.3, n));
      const r = smaCrossBuyRule(s);
      expect(Number.isFinite(r.sizeMultiplier)).toBe(true);
      expect(r.sizeMultiplier).toBeGreaterThanOrEqual(0);
      const sell = smaCrossSellRule(s);
      expect(sell.sellFraction).toBeGreaterThanOrEqual(0);
      expect(sell.sellFraction).toBeLessThanOrEqual(1);
    }
  });
});
