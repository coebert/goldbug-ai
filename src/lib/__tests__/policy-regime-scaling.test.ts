import { describe, it, expect } from "vitest";
import {
  classifyPosture,
  classifyVolRegime,
  detectPolicyRegime,
  policyNudgeScaleForSign,
  POLICY_SCALE_MAX,
  POLICY_SCALE_MIN,
} from "@/lib/policy-regime-scaling";
import { POLICY_MAX_NUDGE, policySentimentNudge, type PolicySignal } from "@/lib/policy-makers";

const sig = (score: number, statements = 3): PolicySignal[] => [
  { symbol: "SPY", score, stance: score > 0 ? "dovish" : "hawkish", statements, makers: ["powell"], latest_date: "2026-08-10" } as PolicySignal,
];

describe("classifyVolRegime", () => {
  it("bands on VIX first", () => {
    expect(classifyVolRegime({ vix: 12 })).toBe("calm");
    expect(classifyVolRegime({ vix: 18 })).toBe("normal");
    expect(classifyVolRegime({ vix: 25 })).toBe("elevated");
    expect(classifyVolRegime({ vix: 40 })).toBe("stressed");
  });

  it("falls back to realised vol, then the macro label", () => {
    expect(classifyVolRegime({ realisedVol20d: 0.004 })).toBe("calm"); // ~6% ann
    expect(classifyVolRegime({ realisedVol20d: 0.025 })).toBe("stressed"); // ~40% ann
    expect(classifyVolRegime({ label: "crisis" })).toBe("stressed");
    expect(classifyVolRegime({})).toBe("normal");
  });
});

describe("classifyPosture", () => {
  it("reads a healthy tape as risk-on and a broken one as risk-off", () => {
    expect(
      classifyPosture({ label: "bull_quiet", drawdownPct: -0.01, index30dReturn: 0.05, credit20dReturn: 0.015 })
        .posture,
    ).toBe("risk_on");
    expect(
      classifyPosture({ label: "bear", drawdownPct: -0.22, index30dReturn: -0.08, credit20dReturn: -0.04 })
        .posture,
    ).toBe("risk_off");
  });

  it("is neutral with no inputs and zero confidence", () => {
    expect(classifyPosture({})).toEqual({ posture: "neutral", confidence: 0 });
  });
});

describe("detectPolicyRegime", () => {
  it("amplifies policy in a stressed risk-off tape and discounts it in a calm bull", () => {
    const stressed = detectPolicyRegime({
      label: "crisis",
      vix: 38,
      drawdownPct: -0.25,
      index30dReturn: -0.1,
      credit20dReturn: -0.05,
    });
    const calm = detectPolicyRegime({
      label: "bull_quiet",
      vix: 12,
      drawdownPct: -0.01,
      index30dReturn: 0.05,
      credit20dReturn: 0.02,
    });
    expect(stressed.scale).toBeGreaterThan(1);
    expect(calm.scale).toBeLessThan(1);
    expect(stressed.scale).toBeGreaterThan(calm.scale);
  });

  it("keeps the multiplier inside its bounds for every input mix", () => {
    for (const vix of [8, 14, 20, 27, 45]) {
      for (const label of ["bull_quiet", "bull_volatile", "correction", "bear", "crisis", "recovery", null]) {
        for (const dd of [0, -0.05, -0.3]) {
          const r = detectPolicyRegime({ label, vix, drawdownPct: dd });
          expect(r.scale).toBeGreaterThanOrEqual(POLICY_SCALE_MIN);
          expect(r.scale).toBeLessThanOrEqual(POLICY_SCALE_MAX);
        }
      }
    }
  });
});

describe("policyNudgeScaleForSign", () => {
  it("favours hawkish guidance when risk-off and dovish when risk-on", () => {
    const off = detectPolicyRegime({ label: "bear", vix: 28, drawdownPct: -0.2, index30dReturn: -0.06 });
    expect(policyNudgeScaleForSign(off, -1)).toBeGreaterThan(policyNudgeScaleForSign(off, 1));

    const on = detectPolicyRegime({ label: "bull_quiet", vix: 13, drawdownPct: -0.01, index30dReturn: 0.05 });
    expect(policyNudgeScaleForSign(on, 1)).toBeGreaterThan(policyNudgeScaleForSign(on, -1));
  });

  it("returns the symmetric scale for a zero nudge", () => {
    const r = detectPolicyRegime({ vix: 20 });
    expect(policyNudgeScaleForSign(r, 0)).toBe(r.scale);
  });
});

describe("policySentimentNudge × regime scale", () => {
  it("scales the nudge but never past the hard cap", () => {
    const base = policySentimentNudge("SPY", sig(0.8));
    expect(policySentimentNudge("SPY", sig(0.8), 1.5)).toBeGreaterThan(base);
    expect(policySentimentNudge("SPY", sig(0.8), 0.5)).toBeLessThan(base);
    expect(Math.abs(policySentimentNudge("SPY", sig(1), 1.6))).toBeLessThanOrEqual(POLICY_MAX_NUDGE);
    expect(Math.abs(policySentimentNudge("SPY", sig(-1), 1.6))).toBeLessThanOrEqual(POLICY_MAX_NUDGE);
  });

  it("keeps a zero signal at zero regardless of regime", () => {
    expect(policySentimentNudge("SPY", sig(0.8, 0), 1.6)).toBe(0);
    expect(policySentimentNudge("QQQ", sig(0.8), 1.6)).toBe(0);
  });
});
