import { describe, expect, it } from "vitest";
import {
  crossFreshness,
  separationConviction,
  smaDynamicSizeMultiplier,
} from "../sma-position-sizing";
import {
  DEFAULT_SMA_CROSS_RULES,
  smaCrossBuyRule,
  type SmaCrossRuleConfig,
  type SmaCrossState,
} from "../sma-cross-rules";
import { smaRulesForRisk } from "../sma-risk-profiles";

const cfg = (o: Partial<SmaCrossRuleConfig> = {}): SmaCrossRuleConfig => ({
  ...DEFAULT_SMA_CROSS_RULES,
  ...o,
});

const state = (o: Partial<SmaCrossState> = {}): SmaCrossState => ({
  price: 110,
  sma20: 105,
  sma50: 100,
  sma200: 95,
  fastCross: null,
  fastCrossAgeBars: null,
  regimeCross: null,
  regimeCrossAgeBars: null,
  regime: "golden",
  fastSeparationPct: 0.05,
  regimeSeparationPct: 0.052,
  bars: 300,
  droppedBars: 0,
  quality: "full",
  regimeUnknown: false,
  warnings: [],
  ...o,
});

describe("separationConviction", () => {
  it("is 0 at or below the threshold and 1 at saturation", () => {
    expect(separationConviction(0.004, 0.005, 0.06)).toBe(0);
    expect(separationConviction(0.005, 0.005, 0.06)).toBe(0);
    expect(separationConviction(0.06, 0.005, 0.06)).toBe(1);
    expect(separationConviction(0.2, 0.005, 0.06)).toBe(1);
  });

  it("ramps linearly in between and ignores sign", () => {
    const mid = separationConviction(0.0325, 0.005, 0.06);
    expect(mid).toBeCloseTo(0.5, 6);
    expect(separationConviction(-0.0325, 0.005, 0.06)).toBeCloseTo(mid, 12);
  });

  it("degrades to a step for a degenerate band and never returns NaN", () => {
    expect(separationConviction(0.02, 0.05, 0.01)).toBe(0);
    expect(separationConviction(0.06, 0.05, 0.05)).toBe(1);
    expect(separationConviction(NaN, 0.005, 0.06)).toBe(0);
    expect(separationConviction(null, 0.005, 0.06)).toBe(0);
  });
});

describe("crossFreshness", () => {
  it("is 1 on the cross bar and decays to 1-weight at the age limit", () => {
    expect(crossFreshness(0, 10, 0.5)).toBe(1);
    expect(crossFreshness(5, 10, 0.5)).toBeCloseTo(0.75, 12);
    expect(crossFreshness(10, 10, 0.5)).toBeCloseTo(0.5, 12);
    expect(crossFreshness(99, 10, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("treats unknown age as stale and honours a zero weight", () => {
    expect(crossFreshness(null, 10, 0.5)).toBeCloseTo(0.5, 12);
    expect(crossFreshness(7, 10, 0)).toBe(1);
  });
});

describe("smaDynamicSizeMultiplier", () => {
  it("scales the golden-regime boost with spread depth", () => {
    const c = cfg({ goldenSizeMult: 1.2, regimeSeparationPct: 0.005, regimeSaturationPct: 0.06 });
    const shallow = smaDynamicSizeMultiplier(state({ regimeSeparationPct: 0.006 }), c);
    const mid = smaDynamicSizeMultiplier(state({ regimeSeparationPct: 0.0325 }), c);
    const deep = smaDynamicSizeMultiplier(state({ regimeSeparationPct: 0.09 }), c);

    expect(shallow.mult).toBeCloseTo(1, 2);
    expect(mid.mult).toBeGreaterThan(shallow.mult);
    expect(deep.mult).toBeGreaterThan(mid.mult);
    // At saturation the boost equals the legacy constant exactly.
    expect(deep.mult).toBeCloseTo(1.2, 10);
  });

  it("scales the death-regime cut with spread depth when trading is allowed", () => {
    const c = cfg({ deathSizeMult: 0.25, regimeSaturationPct: 0.06, minSizeMult: 0.2 });
    const shallow = smaDynamicSizeMultiplier(
      state({ regime: "death", regimeSeparationPct: -0.006 }),
      c,
    );
    const deep = smaDynamicSizeMultiplier(
      state({ regime: "death", regimeSeparationPct: -0.08 }),
      c,
    );
    expect(shallow.mult).toBeGreaterThan(deep.mult);
    expect(deep.mult).toBeCloseTo(0.25, 10);
  });

  it("decays the fast-cross boost as the cross ages", () => {
    const c = cfg({
      goldenSizeMult: 1,
      fastBullSizeMult: 1.4,
      fastSaturationPct: 0.025,
      maxCrossAgeBars: 10,
      freshnessWeight: 0.5,
      maxSizeMult: 2,
    });
    const fresh = smaDynamicSizeMultiplier(
      state({ fastCross: "bull", fastCrossAgeBars: 0, fastSeparationPct: 0.05 }),
      c,
    );
    const stale = smaDynamicSizeMultiplier(
      state({ fastCross: "bull", fastCrossAgeBars: 9, fastSeparationPct: 0.05 }),
      c,
    );
    expect(fresh.mult).toBeCloseTo(1.4, 10);
    expect(stale.mult).toBeLessThan(fresh.mult);
    expect(stale.mult).toBeGreaterThan(1);
  });

  it("gives no boost to an unconfirmed bull cross when price sits below SMA20", () => {
    const c = cfg({ goldenSizeMult: 1, fastBullSizeMult: 1.4, requirePriceConfirmation: true });
    const r = smaDynamicSizeMultiplier(
      state({ fastCross: "bull", fastCrossAgeBars: 0, price: 100, sma20: 105 }),
      c,
    );
    expect(r.mult).toBeCloseTo(1, 10);
    expect(r.notes.join(" ")).toMatch(/unconfirmed/);
  });

  it("applies the unknown-regime haircut as the base and still scales the fast leg", () => {
    const c = cfg({ unknownRegimeSizeMult: 0.6, fastBullSizeMult: 1.5, maxSizeMult: 2 });
    const flat = smaDynamicSizeMultiplier(state({ regimeUnknown: true, regime: null, bars: 120 }), c);
    const bull = smaDynamicSizeMultiplier(
      state({
        regimeUnknown: true,
        regime: null,
        bars: 120,
        fastCross: "bull",
        fastCrossAgeBars: 0,
        fastSeparationPct: 0.08,
      }),
      c,
    );
    expect(flat.mult).toBeCloseTo(0.6, 10);
    expect(bull.mult).toBeCloseTo(0.9, 10);
  });

  it("clamps to the configured bounds and reports it", () => {
    const hi = smaDynamicSizeMultiplier(
      state({ fastCross: "bull", fastCrossAgeBars: 0, fastSeparationPct: 0.2 }),
      cfg({ goldenSizeMult: 2, fastBullSizeMult: 2, maxSizeMult: 1.3 }),
    );
    expect(hi.mult).toBeCloseTo(1.3, 10);
    expect(hi.rawMult).toBeGreaterThan(1.3);
    expect(hi.clamped).toBe(true);

    const lo = smaDynamicSizeMultiplier(
      state({ regime: "death", regimeSeparationPct: -0.2, fastCross: "bear", fastSeparationPct: -0.2 }),
      cfg({ deathSizeMult: 0.2, fastBearBuyMult: 0.2, minSizeMult: 0.35 }),
    );
    expect(lo.mult).toBeCloseTo(0.35, 10);
    expect(lo.clamped).toBe(true);
  });

  it("never returns a negative or non-finite multiplier for hostile config", () => {
    const r = smaDynamicSizeMultiplier(
      state({ fastCross: "bear", fastSeparationPct: -1 }),
      cfg({ deathSizeMult: -5, fastBearBuyMult: -5, minSizeMult: -1, maxSizeMult: 0.5 }),
    );
    expect(Number.isFinite(r.mult)).toBe(true);
    expect(r.mult).toBeGreaterThanOrEqual(0);
    expect(r.mult).toBeLessThanOrEqual(0.5);
  });
});

describe("risk-level consistency", () => {
  const saturated = state({
    fastCross: "bull",
    fastCrossAgeBars: 0,
    fastSeparationPct: 0.12,
    regimeSeparationPct: 0.12,
  });

  it("keeps every profile inside its own declared bounds", () => {
    for (const risk of ["conservative", "balanced", "aggressive"] as const) {
      const c = smaRulesForRisk(risk);
      const r = smaCrossBuyRule(saturated, c);
      expect(r.sizeMultiplier).toBeGreaterThanOrEqual(c.minSizeMult - 1e-9);
      expect(r.sizeMultiplier).toBeLessThanOrEqual(c.maxSizeMult + 1e-9);
    }
  });

  it("sizes a maximal signal aggressive > balanced > conservative", () => {
    const cons = smaCrossBuyRule(saturated, smaRulesForRisk("conservative")).sizeMultiplier;
    const bal = smaCrossBuyRule(saturated, smaRulesForRisk("balanced")).sizeMultiplier;
    const agg = smaCrossBuyRule(saturated, smaRulesForRisk("aggressive")).sizeMultiplier;
    expect(agg).toBeGreaterThan(bal);
    expect(bal).toBeGreaterThan(cons);
  });

  it("still vetoes death-regime buys for conservative and balanced, sizes down for aggressive", () => {
    const death = state({ regime: "death", regimeSeparationPct: -0.05 });
    expect(smaCrossBuyRule(death, smaRulesForRisk("conservative")).allow).toBe(false);
    expect(smaCrossBuyRule(death, smaRulesForRisk("balanced")).allow).toBe(false);
    const agg = smaCrossBuyRule(death, smaRulesForRisk("aggressive"));
    expect(agg.allow).toBe(true);
    expect(agg.sizeMultiplier).toBeLessThan(1);
    expect(agg.sizeMultiplier).toBeGreaterThanOrEqual(smaRulesForRisk("aggressive").minSizeMult);
  });

  it("is monotonic in conviction for every profile", () => {
    for (const risk of ["conservative", "balanced", "aggressive"] as const) {
      const c = smaRulesForRisk(risk);
      let prev = -Infinity;
      for (const sep of [0.006, 0.012, 0.02, 0.04, 0.08, 0.15]) {
        const m = smaCrossBuyRule(state({ regimeSeparationPct: sep }), c).sizeMultiplier;
        expect(m).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = m;
      }
    }
  });
});
