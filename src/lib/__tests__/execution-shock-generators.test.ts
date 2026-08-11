import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORRELATED_EXECUTION,
  makeCorrelatedExecutionSampler,
} from "../execution-correlated-shocks";
import {
  SHOCK_INGREDIENTS,
  formatShockAblation,
  shockAblationArms,
  shockAblationReport,
  shockFreeOverrides,
  type ShockArmResult,
  type ShockMetrics,
} from "../execution-shock-generators";

const metrics = (over: Partial<ShockMetrics> = {}): ShockMetrics => ({
  medianReturnPct: 5,
  p5ReturnPct: -2,
  cvar5ReturnPct: -4,
  medianDrawdownPct: -6,
  worstDrawdownPct: -10,
  breachProb: 0.1,
  jointBreachProb: 0.05,
  meanCost: 100,
  ...over,
});

const armsByKey = () => new Map(shockAblationArms().map((a) => [a.key, a]));

describe("shock ablation grid", () => {
  it("never touches the correlation assumption", () => {
    const corrKeys = ["rho", "structure", "regimeBlend", "regimeRampLoZ", "regimeRampHiZ", "stressBlendFloor"];
    for (const arm of shockAblationArms()) {
      for (const k of Object.keys(arm.overrides)) {
        expect(corrKeys).not.toContain(k);
      }
    }
  });

  it("builds a shock-free baseline, a cumulative ladder and one LOO arm each", () => {
    const arms = shockAblationArms();
    expect(arms[0]!.key).toBe("none");
    expect(arms[0]!.active).toEqual([]);
    const ladder = arms.filter((a) => a.kind === "ladder");
    expect(ladder.map((a) => a.active.length)).toEqual([1, 2, 3, 4]);
    const full = arms.find((a) => a.key === "full")!;
    expect(full.active).toHaveLength(SHOCK_INGREDIENTS.length);
    expect(full.overrides).toEqual({});
    const loo = arms.filter((a) => a.kind === "leave-one-out");
    expect(loo).toHaveLength(SHOCK_INGREDIENTS.length);
    for (const a of loo) expect(a.active).toHaveLength(SHOCK_INGREDIENTS.length - 1);
  });

  it("the shock-free arm neutralises every ingredient", () => {
    const none = armsByKey().get("none")!;
    expect(none.overrides).toEqual(shockFreeOverrides());
    expect(none.overrides.slippageSigma).toBe(0);
    expect(none.overrides.tailProb).toBe(0);
    expect(none.overrides.noFillProb).toBe(0);
    expect(none.overrides.fullFillProb).toBe(1);
    expect(none.overrides.volStressZ).toBe(Number.POSITIVE_INFINITY);
  });

  it("respects a custom ingredient order", () => {
    const arms = shockAblationArms(["fatTail", "dispersion", "fillRisk", "stressRegime", "volForcing"]);
    expect(arms[1]!.ingredient).toBe("fatTail");
    expect(arms[1]!.overrides.tailProb).toBeUndefined();
    expect(arms[1]!.overrides.slippageSigma).toBe(0);
  });

  it("ignores unknown ingredient keys in the order", () => {
    const arms = shockAblationArms(["fatTail", "nonsense" as never]);
    expect(arms.filter((a) => a.kind !== "reference").map((a) => a.ingredient))
      .not.toContain("nonsense");
  });
});

describe("shock ablation arms produce genuinely different draws", () => {
  const drawSet = (over: Record<string, unknown>) => {
    const s = makeCorrelatedExecutionSampler({ ...DEFAULT_CORRELATED_EXECUTION, ...over }, 42);
    const out: number[] = [];
    for (let bar = 0; bar < 60; bar++) {
      s.beginBar(bar % 11 === 0 ? 3 : 0.2);
      for (const sym of ["AAPL", "SPY", "GLD"]) {
        const d = s.draw(sym);
        out.push(d.slippageMult, d.fillRatio);
      }
    }
    return out;
  };

  it("the shock-free arm is deterministic and complete", () => {
    const arms = armsByKey();
    const vals = drawSet(arms.get("none")!.overrides);
    for (let i = 0; i < vals.length; i += 2) {
      expect(vals[i]).toBeCloseTo(1, 10);
      expect(vals[i + 1]).toBe(1);
    }
  });

  it("switching fill risk off removes partial and missed fills only", () => {
    const arms = armsByKey();
    const vals = drawSet(arms.get("-fillRisk")!.overrides);
    const ratios = vals.filter((_, i) => i % 2 === 1);
    expect(new Set(ratios)).toEqual(new Set([1]));
    const mults = vals.filter((_, i) => i % 2 === 0);
    expect(new Set(mults).size).toBeGreaterThan(5);
  });

  it("switching the stress regime off flattens the regime multiplier", () => {
    const arms = armsByKey();
    const s = makeCorrelatedExecutionSampler(
      { ...DEFAULT_CORRELATED_EXECUTION, ...arms.get("-stressRegime")!.overrides }, 7);
    for (let bar = 0; bar < 40; bar++) {
      const r = s.beginBar(0.1);
      expect(r.regimeMult).toBeCloseTo(1, 10);
    }
  });

  it("vol forcing off stops a violent bar from forcing stress", () => {
    const arms = armsByKey();
    const off = makeCorrelatedExecutionSampler(
      { ...DEFAULT_CORRELATED_EXECUTION, ...arms.get("-volForcing")!.overrides, stressEnterProb: 0 }, 11);
    const on = makeCorrelatedExecutionSampler(
      { ...DEFAULT_CORRELATED_EXECUTION, stressEnterProb: 0 }, 11);
    expect(off.beginBar(5).stressed).toBe(false);
    expect(on.beginBar(5).stressed).toBe(true);
  });
});

describe("shockAblationReport", () => {
  const build = (worst: Record<string, number>): ShockArmResult[] =>
    shockAblationArms().map((arm) => ({
      arm,
      metrics: metrics({ worstDrawdownPct: worst[arm.key] ?? -10 }),
    }));

  it("ladder deltas are marginal contributions in order", () => {
    const rep = shockAblationReport(build({
      none: -2, "+dispersion": -4, "+fillRisk": -9, "+fatTail": -10, "+stressRegime": -14, full: -20,
    }));
    expect(rep.ladder.map((d) => d.ingredient))
      .toEqual(["dispersion", "fillRisk", "fatTail", "stressRegime", "volForcing"]);
    expect(rep.ladder[0]!.delta.worstDrawdownPct).toBeCloseTo(-2);
    expect(rep.ladder[1]!.delta.worstDrawdownPct).toBeCloseTo(-5);
    expect(rep.ladder[4]!.delta.worstDrawdownPct).toBeCloseTo(-6);
  });

  it("marks a deeper drawdown and a higher breach probability as worse", () => {
    const rep = shockAblationReport(build({ none: -2, "+dispersion": -6 }));
    expect(rep.ladder[0]!.worse.worstDrawdownPct).toBe(true);
    const flat = shockAblationReport(build({}));
    expect(flat.ladder[0]!.worse.worstDrawdownPct).toBe(false);
  });

  it("leave-one-out deltas measure full minus the arm without the ingredient", () => {
    const rep = shockAblationReport(build({ full: -20, "-fillRisk": -12, "-fatTail": -19 }));
    const loo = new Map(rep.leaveOneOut.map((d) => [d.ingredient, d.delta.worstDrawdownPct]));
    expect(loo.get("fillRisk")).toBeCloseTo(-8);
    expect(loo.get("fatTail")).toBeCloseTo(-1);
  });

  it("ranks drivers by mean |Δ| and reports interaction", () => {
    const rep = shockAblationReport(build({
      none: -2, "+dispersion": -3, "+fillRisk": -12, "+fatTail": -13, "+stressRegime": -19, full: -20,
      "-dispersion": -14, "-fillRisk": -11, "-fatTail": -19, "-stressRegime": -13, "-volForcing": -19,
    }));
    expect(rep.ranking[0]!.ingredient).toBe("fillRisk");
    const fill = rep.ranking.find((r) => r.ingredient === "fillRisk")!;
    expect(fill.ladderDelta).toBeCloseTo(-9);
    expect(fill.looDelta).toBeCloseTo(-9);
    expect(fill.interaction).toBeCloseTo(0);
    const disp = rep.ranking.find((r) => r.ingredient === "dispersion")!;
    expect(disp.interaction).toBeGreaterThan(0);
  });

  it("honours an alternative focus metric", () => {
    const results = shockAblationArms().map((arm) => ({
      arm,
      metrics: metrics({
        worstDrawdownPct: -10,
        p5ReturnPct: arm.ingredient === "fatTail" && arm.kind === "ladder" ? -30 : -2,
      }),
    }));
    const rep = shockAblationReport(results, "p5ReturnPct");
    expect(rep.focus).toBe("p5ReturnPct");
    expect(rep.ranking[0]!.ingredient).toBe("fatTail");
  });

  it("survives a missing full arm", () => {
    const partial = shockAblationArms().filter((a) => a.key !== "full")
      .map((arm) => ({ arm, metrics: metrics() }));
    const rep = shockAblationReport(partial);
    expect(rep.leaveOneOut).toEqual([]);
    expect(() => formatShockAblation(rep)).not.toThrow();
  });
});

describe("formatShockAblation", () => {
  it("renders the arms, both delta views and the driver ranking", () => {
    const rep = shockAblationReport(shockAblationArms().map((arm) => ({
      arm,
      metrics: metrics({ worstDrawdownPct: arm.key === "full" ? -22 : -8 }),
    })));
    const out = formatShockAblation(rep);
    expect(out).toContain("shock-free");
    expect(out).toContain("full generator");
    expect(out).toContain("Leave-one-out");
    expect(out).toContain("Marginal effect of switching each ingredient ON");
    expect(out).toContain("Drivers of worstDrawdownPct");
    expect(out).toMatch(/[+-]\d+\.\d\d/);
  });
});
