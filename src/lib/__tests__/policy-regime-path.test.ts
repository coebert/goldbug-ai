import { describe, expect, it } from "vitest";
import {
  resolveRegimeScalePath,
  summariseRegimePaths,
} from "@/lib/policy-regime-path";
import {
  POLICY_SCALE_MAX,
  POLICY_SCALE_MIN,
  policyNudgeScaleForSign,
  policyScaleForRegime,
} from "@/lib/policy-regime-scaling";

describe("resolveRegimeScalePath", () => {
  it("uses a valid stored multiplier verbatim", () => {
    const d = resolveRegimeScalePath({ posture: "neutral", vol: "normal", scale: 1.2 }, 0);
    expect(d.path).toBe("exact");
    expect(d.scale).toBe(1.2);
    expect(d.appliedScale).toBe(1.2);
    expect(d.notes).toHaveLength(0);
  });

  it("recomputes from posture and vol when the scale is missing", () => {
    const d = resolveRegimeScalePath({ posture: "risk_off", vol: "elevated" }, 0);
    expect(d.path).toBe("recomputed");
    expect(d.scale).toBe(policyScaleForRegime("risk_off", "elevated"));
  });

  it("clamps an out-of-bound stored multiplier", () => {
    const hi = resolveRegimeScalePath({ posture: "neutral", vol: "normal", scale: 9 }, 0);
    expect(hi.path).toBe("clamped");
    expect(hi.scale).toBe(POLICY_SCALE_MAX);
    const lo = resolveRegimeScalePath({ posture: "neutral", vol: "normal", scale: -3 }, 0);
    expect(lo.path).toBe("clamped");
    expect(lo.scale).toBe(POLICY_SCALE_MIN);
  });

  it("flags a clamp caused by the directional tilt", () => {
    const d = resolveRegimeScalePath({ posture: "risk_off", vol: "stressed", scale: 1.6 }, -1);
    expect(d.signClamped).toBe(true);
    expect(d.path).toBe("clamped");
    expect(d.appliedScale).toBe(POLICY_SCALE_MAX);
  });

  it("falls back to x1 with no usable blob", () => {
    for (const blob of [null, undefined, "junk", 7, { scale: "abc" }]) {
      const d = resolveRegimeScalePath(blob, 1);
      expect(d.path).toBe("fallback");
      expect(d.appliedScale).toBe(1);
      expect(Number.isFinite(d.appliedScale)).toBe(true);
    }
  });

  it("matches the engine's signed multiplier exactly", () => {
    for (const posture of ["risk_on", "neutral", "risk_off"] as const) {
      for (const vol of ["calm", "normal", "elevated", "stressed"] as const) {
        for (const sign of [-1, 1]) {
          const scale = policyScaleForRegime(posture, vol);
          const d = resolveRegimeScalePath({ posture, vol, scale }, sign);
          expect(d.appliedScale).toBe(
            policyNudgeScaleForSign({ posture, vol, scale, confidence: 0, reason: "" }, sign),
          );
        }
      }
    }
  });

  it("summarises path counts in a stable order", () => {
    expect(summariseRegimePaths(["fallback", "exact", "clamped", "exact"])).toEqual([
      { path: "exact", count: 2 },
      { path: "clamped", count: 1 },
      { path: "fallback", count: 1 },
    ]);
  });
});
