import { describe, it, expect } from "vitest";
import {
  assessDecisionMateriality,
  fingerprintDecisionInputs,
  type MaterialityInputs,
} from "../ai-materiality";

const base: MaterialityInputs = {
  regime: "risk_on",
  prices: { AAPL: 200, "MKS.L": 4.04 },
  heldSymbols: ["AAPL"],
  freshNewsCount: 0,
  cash: 1000,
  totalValue: 10_000,
};

const now = new Date("2026-08-06T12:00:00Z");
const oneHourAgo = new Date("2026-08-06T11:00:00Z").toISOString();

describe("AI decision materiality gate", () => {
  it("always calls when there is no prior fingerprint", () => {
    const d = assessDecisionMateriality({
      inputs: base,
      previousFingerprint: null,
      previousCallAt: null,
      now,
    });
    expect(d.callAi).toBe(true);
  });

  it("skips a quiet tick with identical inputs", () => {
    const fp = fingerprintDecisionInputs(base);
    const d = assessDecisionMateriality({
      inputs: base,
      previousFingerprint: fp,
      previousCallAt: oneHourAgo,
      now,
    });
    expect(d.callAi).toBe(false);
  });

  it("ignores sub-noise price wiggles", () => {
    const jittered = { ...base, prices: { AAPL: 200.2, "MKS.L": 4.041 } };
    expect(fingerprintDecisionInputs(jittered)).toBe(fingerprintDecisionInputs(base));
  });

  it("calls again on a material price move", () => {
    const moved = { ...base, prices: { ...base.prices, AAPL: 210 } };
    const d = assessDecisionMateriality({
      inputs: moved,
      previousFingerprint: fingerprintDecisionInputs(base),
      previousCallAt: oneHourAgo,
      now,
    });
    expect(d.callAi).toBe(true);
  });

  it("calls again when holdings or regime change", () => {
    for (const inputs of [
      { ...base, heldSymbols: ["AAPL", "MKS.L"] },
      { ...base, regime: "risk_off" },
    ]) {
      const d = assessDecisionMateriality({
        inputs,
        previousFingerprint: fingerprintDecisionInputs(base),
        previousCallAt: oneHourAgo,
        now,
      });
      expect(d.callAi).toBe(true);
    }
  });

  it("calls again when fresh news arrived", () => {
    const d = assessDecisionMateriality({
      inputs: { ...base, freshNewsCount: 3 },
      previousFingerprint: fingerprintDecisionInputs(base),
      previousCallAt: oneHourAgo,
      now,
    });
    expect(d.callAi).toBe(true);
  });

  it("forces a refresh after the max skip window", () => {
    const d = assessDecisionMateriality({
      inputs: base,
      previousFingerprint: fingerprintDecisionInputs(base),
      previousCallAt: new Date("2026-08-06T04:00:00Z").toISOString(),
      now,
    });
    expect(d.callAi).toBe(true);
    expect(d.reason).toMatch(/max/);
  });

  it("fingerprint is order-independent and stable", () => {
    const shuffled: MaterialityInputs = {
      ...base,
      prices: { "MKS.L": 4.04, AAPL: 200 },
      heldSymbols: ["AAPL"],
    };
    expect(fingerprintDecisionInputs(shuffled)).toBe(fingerprintDecisionInputs(base));
  });
});
