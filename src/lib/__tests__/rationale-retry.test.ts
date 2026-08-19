import { describe, it, expect } from "vitest";
import {
  rationaleRetryDelayMs,
  isRetryableRationaleError,
  shouldAutoRetryRationale,
  describeRationaleFailure,
  errorMessage,
  RATIONALE_MAX_AUTO_RETRIES,
} from "../rationale-retry";

describe("rationale retry policy", () => {
  it("backs off exponentially within bounds", () => {
    const d1 = rationaleRetryDelayMs(1);
    const d2 = rationaleRetryDelayMs(2);
    expect(d2).toBeGreaterThan(d1);
    expect(rationaleRetryDelayMs(9)).toBeLessThanOrEqual(15_000 * 1.25);
  });

  it("does not auto-retry terminal failures", () => {
    expect(isRetryableRationaleError(new Error("HTTP 403 forbidden"))).toBe(false);
    expect(isRetryableRationaleError(new Error("Unauthorized"))).toBe(false);
    expect(isRetryableRationaleError(new Error("Failed to fetch"))).toBe(true);
    expect(isRetryableRationaleError(new Error("HTTP 503"))).toBe(true);
  });

  it("stops auto-retrying at the attempt ceiling", () => {
    const e = new Error("network timeout");
    expect(shouldAutoRetryRationale(e, 0)).toBe(true);
    expect(shouldAutoRetryRationale(e, RATIONALE_MAX_AUTO_RETRIES)).toBe(false);
    expect(shouldAutoRetryRationale(new Error("401"), 0)).toBe(false);
  });

  it("extracts messages from unknown throwables", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage({ message: "nope" })).toBe("nope");
    expect(errorMessage(null)).toBe("");
  });

  it("describes failures readably", () => {
    expect(describeRationaleFailure(new Error("timeout"), 1)).toMatch(/retrying automatically/);
    expect(describeRationaleFailure(new Error("timeout"), 3)).toMatch(/after 3 attempts/);
    expect(describeRationaleFailure(new Error("403 forbidden"), 0)).toMatch(/won't resolve on its own/);
  });
});
