// Property-based fuzz tests for persisted `raw.policy_regime` decoding.
//
// Production blobs are dirty: missing fields, strings where numbers belong,
// NaN/Infinity, wildly out-of-range multipliers, nested junk. The invariants
// that must hold no matter what:
//   1. every numeric field out of the decoder is finite (never NaN/Infinity)
//   2. `scale` and `appliedScale` always sit inside [MIN, MAX]
//   3. the decoder never throws
//   4. it is deterministic and consistent with the engine's own arithmetic

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  POLICY_SCALE_MAX,
  POLICY_SCALE_MIN,
  detectPolicyRegime,
  policyNudgeScaleForSign,
} from "@/lib/policy-regime-scaling";
import { resolveRegimeScalePath } from "@/lib/policy-regime-path";

const inRange = (x: number) =>
  Number.isFinite(x) && x >= POLICY_SCALE_MIN - 1e-9 && x <= POLICY_SCALE_MAX + 1e-9;

/** Anything a JSONB column could hand back, including hostile values. */
const anyJson = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.string(),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string(), fc.string(), { maxKeys: 3 }),
);

const postureArb = fc.oneof(
  fc.constantFrom("risk_on", "neutral", "risk_off"),
  fc.string(),
  fc.constant(null),
  fc.integer(),
);

const volArb = fc.oneof(
  fc.constantFrom("calm", "normal", "elevated", "stressed"),
  fc.string(),
  fc.constant(null),
  fc.integer(),
);

const scaleArb = fc.oneof(
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.integer({ min: -5, max: 5 }).map(String),
);

/** Blobs that look like the real thing, but with each field independently hostile. */
const shapedBlob = fc.record(
  {
    posture: postureArb,
    vol: volArb,
    scale: scaleArb,
    confidence: anyJson,
    reason: anyJson,
  },
  { requiredKeys: [] },
);

const signArb = fc.constantFrom(-1, 0, 1, -0.5, 2, -3);

describe("regime blob decoding — property fuzz", () => {
  it("never throws and never emits non-finite numbers for arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.oneof(anyJson, shapedBlob), signArb, (blob, sign) => {
        const d = resolveRegimeScalePath(blob, sign);
        expect(Number.isFinite(d.scale)).toBe(true);
        expect(Number.isFinite(d.appliedScale)).toBe(true);
        expect(d.storedScale === null || Number.isFinite(d.storedScale)).toBe(true);
        expect(Number.isFinite(d.sign)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("always clamps scale and appliedScale into the allowed band", () => {
    fc.assert(
      fc.property(fc.oneof(anyJson, shapedBlob), signArb, (blob, sign) => {
        const d = resolveRegimeScalePath(blob, sign);
        expect(inRange(d.scale)).toBe(true);
        expect(inRange(d.appliedScale)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("returns a known path with a coherent posture/vol pair", () => {
    fc.assert(
      fc.property(fc.oneof(anyJson, shapedBlob), signArb, (blob, sign) => {
        const d = resolveRegimeScalePath(blob, sign);
        expect(["exact", "recomputed", "clamped", "fallback"]).toContain(d.path);
        expect(["risk_on", "neutral", "risk_off"]).toContain(d.posture);
        expect(["calm", "normal", "elevated", "stressed"]).toContain(d.vol);
        expect(d.notes.every((n) => typeof n === "string" && !n.includes("NaN"))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("is deterministic — same blob, same diagnostic", () => {
    fc.assert(
      fc.property(fc.oneof(anyJson, shapedBlob), signArb, (blob, sign) => {
        expect(resolveRegimeScalePath(blob, sign)).toEqual(resolveRegimeScalePath(blob, sign));
      }),
      { numRuns: 400 },
    );
  });

  it("takes the fallback path (×1) for anything that is not an object", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.double(), fc.boolean()),
        (blob) => {
          const d = resolveRegimeScalePath(blob, 0);
          expect(d.path).toBe("fallback");
          expect(d.appliedScale).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("uses in-band stored multipliers verbatim", () => {
    fc.assert(
      fc.property(
        fc.double({ min: POLICY_SCALE_MIN, max: POLICY_SCALE_MAX, noNaN: true }),
        (scale) => {
          const d = resolveRegimeScalePath({ posture: "neutral", vol: "normal", scale }, 0);
          expect(d.path).toBe("exact");
          expect(d.scale).toBe(scale);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("clamps any out-of-band finite stored multiplier to the nearest bound", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (scale) => {
        fc.pre(scale < POLICY_SCALE_MIN || scale > POLICY_SCALE_MAX);
        const d = resolveRegimeScalePath({ posture: "neutral", vol: "normal", scale }, 0);
        expect(d.path).toBe("clamped");
        expect(d.scale).toBe(scale < POLICY_SCALE_MIN ? POLICY_SCALE_MIN : POLICY_SCALE_MAX);
      }),
      { numRuns: 500 },
    );
  });

  it("matches the engine's directional arithmetic for clean blobs", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("risk_on", "neutral", "risk_off"),
        fc.constantFrom("calm", "normal", "elevated", "stressed"),
        fc.constantFrom(-1, 1),
        (posture, vol, sign) => {
          const engine = detectPolicyRegime({
            label: null,
            vix: vol === "stressed" ? 35 : vol === "elevated" ? 25 : vol === "normal" ? 18 : 10,
          });
          const read = { ...engine, posture: posture as never, vol: vol as never };
          const expected = policyNudgeScaleForSign(
            { ...read, scale: resolveRegimeScalePath({ posture, vol }, 0).scale },
            sign,
          );
          const d = resolveRegimeScalePath({ posture, vol }, sign);
          expect(d.appliedScale).toBeCloseTo(expected, 9);
          expect(inRange(d.appliedScale)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
