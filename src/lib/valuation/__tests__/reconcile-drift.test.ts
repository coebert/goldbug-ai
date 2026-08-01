import { describe, expect, it } from "vitest";
import { classifyDrift, DRIFT_ALERT_PCT, DRIFT_WARN_PCT } from "../reconcile-drift.server";

describe("classifyDrift", () => {
  it("treats an exact match as clean", () => {
    const r = classifyDrift(10_300, 10_300);
    expect(r.diff).toBe(0);
    expect(r.diffPct).toBe(0);
    expect(r.severity).toBe("ok");
  });

  it("ignores sub-threshold rounding noise", () => {
    expect(classifyDrift(10_300, 10_300.5).severity).toBe("ok");
  });

  it("warns between the warn and alert thresholds", () => {
    const r = classifyDrift(10_000, 10_000 * (1 + (DRIFT_WARN_PCT + DRIFT_ALERT_PCT) / 2));
    expect(r.severity).toBe("warn");
  });

  it("alerts on a material gap, in either direction", () => {
    expect(classifyDrift(10_000, 10_500).severity).toBe("alert");
    expect(classifyDrift(10_000, 9_500).severity).toBe("alert");
  });

  it("catches the 100x pence inflation as an alert", () => {
    const r = classifyDrift(817_118.77, 10_215.95);
    expect(r.severity).toBe("alert");
    expect(r.diff).toBeLessThan(0);
  });

  it("reports the signed difference relative to the stored value", () => {
    expect(classifyDrift(100, 130).diff).toBe(30);
    expect(classifyDrift(100, 130).diffPct).toBeCloseTo(0.3, 6);
  });

  it("falls back to the recomputed value when the stored total is zero", () => {
    expect(classifyDrift(0, 500).severity).toBe("alert");
    expect(classifyDrift(0, 0).severity).toBe("ok");
  });
});
