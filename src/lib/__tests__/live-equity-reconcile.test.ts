import { describe, it, expect } from "vitest";
import {
  classifyEquityDrift,
  EQUITY_DRIFT_ABS_FLOOR,
} from "../live-equity-reconcile";

describe("classifyEquityDrift", () => {
  it("passes matching equity", () => {
    const d = classifyEquityDrift({ appTotal: 10_300, brokerTotal: 10_300, currency: "GBP" });
    expect(d.severity).toBe("ok");
    expect(d.diff).toBe(0);
  });

  it("ignores tiny absolute gaps even when the percentage is large", () => {
    const d = classifyEquityDrift({ appTotal: 100, brokerTotal: 97 });
    expect(Math.abs(d.diff)).toBeLessThan(EQUITY_DRIFT_ABS_FLOOR);
    expect(d.severity).toBe("ok");
  });

  it("warns between 0.5% and 2%", () => {
    const d = classifyEquityDrift({ appTotal: 10_400, brokerTotal: 10_300, currency: "GBP" });
    expect(d.severity).toBe("warn");
    expect(d.diffPct).toBeGreaterThanOrEqual(0.005);
  });

  it("alerts at or above 2%", () => {
    const d = classifyEquityDrift({ appTotal: 10_000, brokerTotal: 12_000 });
    expect(d.severity).toBe("alert");
    expect(d.diff).toBeLessThan(0);
  });

  it("returns unknown when either side is missing or the broker total is zero", () => {
    expect(classifyEquityDrift({ appTotal: null, brokerTotal: 10_000 }).severity).toBe("unknown");
    expect(classifyEquityDrift({ appTotal: 10_000, brokerTotal: 0 }).severity).toBe("unknown");
    expect(
      classifyEquityDrift({ appTotal: Number.NaN, brokerTotal: 10_000 }).severity,
    ).toBe("unknown");
  });

  it("signs the difference from the app's point of view", () => {
    expect(classifyEquityDrift({ appTotal: 11_000, brokerTotal: 10_000 }).diff).toBe(1_000);
    expect(classifyEquityDrift({ appTotal: 9_000, brokerTotal: 10_000 }).diff).toBe(-1_000);
  });
});
