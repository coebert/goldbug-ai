import { describe, expect, it } from "vitest";
import {
  classifyLlmFailure,
  formatRunTelemetry,
  summarizeRelevanceRun,
  type RelevanceBatchTelemetry,
} from "../news-relevance-telemetry";

const batch = (o: Partial<RelevanceBatchTelemetry>): RelevanceBatchTelemetry => ({
  index: 0,
  items: 25,
  scored: 25,
  latencyMs: 100,
  failure: null,
  ...o,
});

describe("classifyLlmFailure", () => {
  it("buckets rate limits, quota, timeouts and unknown errors", () => {
    expect(classifyLlmFailure(Object.assign(new Error("boom"), { status: 429 }))).toBe("rate_limited");
    expect(classifyLlmFailure(new Error("Rate limit exceeded"))).toBe("rate_limited");
    expect(classifyLlmFailure(new Error("Payment required: credits exhausted"))).toBe("quota_exhausted");
    expect(classifyLlmFailure(new Error("The operation timed out"))).toBe("timeout");
    expect(classifyLlmFailure(new Error("socket hang up"))).toBe("upstream_error");
  });
});

describe("summarizeRelevanceRun", () => {
  it("reports full coverage with no fallback", () => {
    const t = summarizeRelevanceRun({
      date: "2026-07-30",
      trigger: "cron-hook",
      items: 50,
      batches: [batch({ index: 0, latencyMs: 120 }), batch({ index: 1, latencyMs: 300 })],
    });
    expect(t.llmScored).toBe(50);
    expect(t.fallbackItems).toBe(0);
    expect(t.fallbackRate).toBe(0);
    expect(t.batchFailures).toBe(0);
    expect(t.latencyMsTotal).toBe(420);
    expect(t.latencyMsMax).toBe(300);
    expect(t.fallbackReason).toBeNull();
    expect(formatRunTelemetry(t)).toContain("full Gemini coverage");
  });

  it("explains why the deterministic scorer kicked in", () => {
    const t = summarizeRelevanceRun({
      date: "2026-07-30",
      trigger: "news-refresh",
      items: 50,
      batches: [
        batch({ index: 0, latencyMs: 150 }),
        batch({ index: 1, scored: 0, latencyMs: 900, failure: "rate_limited" }),
      ],
    });
    expect(t.llmScored).toBe(25);
    expect(t.fallbackItems).toBe(25);
    expect(t.fallbackRate).toBeCloseTo(0.5);
    expect(t.batchFailures).toBe(1);
    expect(t.failureReasons.rate_limited).toBe(1);
    expect(t.fallbackReason).toContain("rate limited");
    expect(formatRunTelemetry(t)).toContain("fallback 50%");
  });

  it("flags a missing API key as a total fallback", () => {
    const t = summarizeRelevanceRun({
      date: "2026-07-30",
      trigger: "reel-repair",
      items: 10,
      batches: [batch({ items: 10, scored: 0, latencyMs: 0, failure: "missing_api_key" })],
    });
    expect(t.fallbackRate).toBe(1);
    expect(t.fallbackReason).toContain("AI gateway key missing");
  });

  it("attributes partial replies to skipped headlines, not a batch failure", () => {
    const t = summarizeRelevanceRun({
      date: "2026-07-30",
      trigger: "cron-hook",
      items: 25,
      batches: [batch({ scored: 20 })],
    });
    expect(t.batchFailures).toBe(0);
    expect(t.fallbackItems).toBe(5);
    expect(t.fallbackReason).toContain("skipped them");
  });
});
