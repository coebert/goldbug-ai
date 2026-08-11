import { describe, expect, it } from "vitest";
import {
  EVENT_SHOCKS_OFF,
  REBALANCE_RULES_OFF,
  TAIL_DRIVERS,
  VOL_SCALING_OFF,
  dominantDriver,
  formatTailDecomposition,
  tailDecompositionReport,
  tailDriverArms,
  type TailDriverArmResult,
  type TailMetrics,
} from "../execution-tail-decomposition";

const LIVE = { minTicket: 250, abandonPartialFraction: 0.2 };

/** Metrics that are a pure additive function of the enabled drivers. */
const additive = (key: string): TailMetrics => {
  const on = new Set(key.split("+").filter(Boolean));
  const v = (d: string, x: number) => (on.has(d) ? x : 0);
  return {
    jointBreachProb: v("volScaling", 4) + v("eventShocks", 10) + v("rebalanceRules", 1),
    worstDrawdownPct: -10 - v("volScaling", 3) - v("eventShocks", 8) - v("rebalanceRules", 1),
    cvar5ReturnPct: -1 - v("volScaling", 2) - v("eventShocks", 5) - v("rebalanceRules", 3),
    meanCost: 100 + v("volScaling", 20) + v("eventShocks", 40) + v("rebalanceRules", 60),
  };
};

const run = (metricsFor: (key: string) => TailMetrics): TailDriverArmResult[] =>
  tailDriverArms(LIVE).map((arm) => ({ arm, metrics: metricsFor(arm.key) }));

describe("tailDriverArms", () => {
  it("enumerates the full 2^3 lattice, baseline first and full model last", () => {
    const arms = tailDriverArms(LIVE);
    expect(arms).toHaveLength(8);
    expect(arms[0]!.key).toBe("");
    expect(arms[0]!.label).toBe("baseline (all drivers off)");
    expect(arms[7]!.drivers).toEqual([...TAIL_DRIVERS]);
    expect(new Set(arms.map((a) => a.key)).size).toBe(8);
  });

  it("only neutralises the drivers an arm leaves out", () => {
    const byKey = new Map(tailDriverArms(LIVE).map((a) => [a.key, a]));

    const full = byKey.get("volScaling+eventShocks+rebalanceRules")!;
    expect(full.shock).toEqual({});
    expect(full.policy).toEqual(LIVE);

    const noVol = byKey.get("eventShocks+rebalanceRules")!;
    expect(noVol.shock).toEqual(VOL_SCALING_OFF);
    expect(noVol.shock.volStressZ).toBe(Number.POSITIVE_INFINITY);
    expect(noVol.policy).toEqual(LIVE);

    const noEvents = byKey.get("volScaling+rebalanceRules")!;
    expect(noEvents.shock).toEqual(EVENT_SHOCKS_OFF);
    expect(noEvents.shock.tailProb).toBe(0);

    const noRules = byKey.get("volScaling+eventShocks")!;
    expect(noRules.shock).toEqual({});
    expect(noRules.policy).toEqual(REBALANCE_RULES_OFF);
  });

  it("never touches correlation fields", () => {
    for (const arm of tailDriverArms(LIVE)) {
      expect(arm.shock).not.toHaveProperty("rho");
      expect(arm.shock).not.toHaveProperty("structure");
    }
  });

  it("keeps the live policy immutable across arms", () => {
    const live = { ...LIVE };
    const arms = tailDriverArms(live);
    arms[7]!.policy.minTicket = 9999;
    expect(live.minTicket).toBe(250);
  });
});

describe("tailDecompositionReport", () => {
  it("recovers exact contributions when drivers are additive", () => {
    const report = tailDecompositionReport(run(additive));
    const cost = report.metrics.find((m) => m.metric === "meanCost")!;

    expect(cost.attribution.baseline).toBe(100);
    expect(cost.attribution.full).toBe(220);
    expect(cost.attribution.total).toBe(120);
    const byDriver = Object.fromEntries(
      cost.attribution.contributions.map((c) => [c.channel, c.shapley]),
    );
    expect(byDriver["volScaling"]).toBeCloseTo(20, 9);
    expect(byDriver["eventShocks"]).toBeCloseTo(40, 9);
    expect(byDriver["rebalanceRules"]).toBeCloseTo(60, 9);
    // No interaction when the model is additive.
    expect(cost.attribution.interaction).toBeCloseTo(0, 9);
  });

  it("adds contributions back to the measured total for every metric", () => {
    const report = tailDecompositionReport(
      run((key) => {
        const base = additive(key);
        const on = key.split("+").filter(Boolean);
        // Introduce interaction: rules cost more when events are live.
        const combo = on.includes("eventShocks") && on.includes("rebalanceRules") ? 1 : 0;
        return {
          ...base,
          meanCost: base.meanCost + combo * 75,
          worstDrawdownPct: base.worstDrawdownPct - combo * 6,
          cvar5ReturnPct: base.cvar5ReturnPct - combo * 4,
          jointBreachProb: base.jointBreachProb + combo * 5,
        };
      }),
    );

    for (const m of report.metrics) {
      const sum = m.attribution.contributions.reduce((a, c) => a + c.shapley, 0);
      expect(sum).toBeCloseTo(m.attribution.total, 9);
    }
  });

  it("flags amplification through the interaction term and shares the overlap", () => {
    const report = tailDecompositionReport(
      run((key) => {
        const on = key.split("+").filter(Boolean);
        const combo = on.includes("eventShocks") && on.includes("rebalanceRules") ? 100 : 0;
        return { ...additive(key), meanCost: 100 + combo };
      }),
    );
    const cost = report.metrics.find((m) => m.metric === "meanCost")!;

    // Neither driver does anything alone, so all of it is interaction...
    expect(cost.attribution.interaction).toBeCloseTo(100, 9);
    const byDriver = Object.fromEntries(
      cost.attribution.contributions.map((c) => [c.channel, c]),
    );
    expect(byDriver["eventShocks"]!.solo).toBe(0);
    expect(byDriver["rebalanceRules"]!.solo).toBe(0);
    // ...and Shapley splits it evenly between the two that caused it.
    expect(byDriver["eventShocks"]!.shapley).toBeCloseTo(50, 9);
    expect(byDriver["rebalanceRules"]!.shapley).toBeCloseTo(50, 9);
    expect(byDriver["volScaling"]!.shapley).toBeCloseTo(0, 9);
  });

  it("names the dominant driver by absolute Shapley value", () => {
    const report = tailDecompositionReport(run(additive));
    expect(dominantDriver(report.metrics.find((m) => m.metric === "meanCost")!)).toBe(
      "rebalanceRules",
    );
    expect(dominantDriver(report.metrics.find((m) => m.metric === "worstDrawdownPct")!)).toBe(
      "eventShocks",
    );
  });

  it("throws when the lattice has a hole", () => {
    const partial = run(additive).slice(0, 7);
    expect(() => tailDecompositionReport(partial)).toThrow(/missing arm/);
  });

  it("renders one row per arm and a block per metric", () => {
    const text = formatTailDecomposition(tailDecompositionReport(run(additive)));
    expect(text).toContain("baseline (all drivers off)");
    expect(text).toContain("full model");
    expect(text).toContain("execution cost");
    expect(text).toContain("CVaR5 return");
    for (const d of TAIL_DRIVERS) expect(text).toContain(d);
  });
});
