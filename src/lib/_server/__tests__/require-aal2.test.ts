import { describe, expect, it } from "vitest";
import { aal2Satisfied, MfaRequiredError } from "../require-aal2";

describe("aal2 policy", () => {
  it("blocks a single-factor session once a factor is enrolled", () => {
    expect(aal2Satisfied("aal1", true)).toBe(false);
    expect(aal2Satisfied(null, true)).toBe(false);
  });

  it("allows a fully verified two-factor session", () => {
    expect(aal2Satisfied("aal2", true)).toBe(true);
  });

  it("does not lock out an account with no enrolled factor", () => {
    expect(aal2Satisfied("aal1", false)).toBe(true);
    expect(aal2Satisfied(null, false)).toBe(true);
  });

  it("surfaces a recognisable error code", () => {
    expect(new MfaRequiredError().code).toBe("mfa_required");
  });
});
