import { describe, expect, it } from "vitest";
import { evaluateCostSyncHealth } from "@/lib/cost-sync-health";

const base = { supported: true, fillsConsidered: 10, fillsUpdated: 10, unmatchedFills: 0 };

describe("evaluateCostSyncHealth", () => {
  it("grades a full sync as ok and does not alert", () => {
    const h = evaluateCostSyncHealth(base);
    expect(h.status).toBe("ok");
    expect(h.shouldAlert).toBe(false);
    expect(h.coveragePct).toBe(100);
  });

  it("treats an empty tape as healthy", () => {
    const h = evaluateCostSyncHealth({ ...base, fillsConsidered: 0, fillsUpdated: 0 });
    expect(h.status).toBe("ok");
    expect(h.shouldAlert).toBe(false);
  });

  it("flags a failed fetch as critical", () => {
    const h = evaluateCostSyncHealth({ ...base, supported: false, reason: "no cost report" });
    expect(h.status).toBe("failed");
    expect(h.severity).toBe("critical");
    expect(h.shouldAlert).toBe(true);
    expect(h.coveragePct).toBe(0);
  });

  it("treats a thrown error as failed even when supported", () => {
    const h = evaluateCostSyncHealth({ ...base, error: "429 Too Many Requests" });
    expect(h.status).toBe("failed");
    expect(h.body).toContain("429");
  });

  it("flags partial coverage below the 80% target", () => {
    const h = evaluateCostSyncHealth({
      ...base,
      fillsConsidered: 10,
      fillsUpdated: 5,
      unmatchedFills: 5,
    });
    expect(h.status).toBe("partial");
    expect(h.severity).toBe("warning");
    expect(h.coveragePct).toBe(50);
    expect(h.shouldAlert).toBe(true);
  });

  it("stays quiet at or above the coverage target", () => {
    const h = evaluateCostSyncHealth({
      ...base,
      fillsConsidered: 10,
      fillsUpdated: 8,
      unmatchedFills: 2,
    });
    expect(h.status).toBe("ok");
    expect(h.shouldAlert).toBe(false);
  });

  it("stays quiet when the gap is only fills inside the publication grace", () => {
    const h = evaluateCostSyncHealth({
      ...base,
      fillsConsidered: 10,
      fillsUpdated: 2,
      unmatchedFills: 0,
    });
    expect(h.status).toBe("ok");
  });
});
