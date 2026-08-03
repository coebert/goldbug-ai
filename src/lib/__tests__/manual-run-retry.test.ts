import { describe, it, expect } from "vitest";
import {
  planManualRunRetry,
  pendingPortfolioIds,
  backoffDelayMs,
  isRetryableRunError,
  DEFAULT_MANUAL_RUN_RETRY,
} from "@/lib/manual-run-retry";
import type { RunPortfolioStatus } from "@/lib/run-portfolio-status";

function status(
  id: string,
  s: RunPortfolioStatus["status"],
  selected = true,
): RunPortfolioStatus {
  return {
    id,
    name: id,
    mode: "live_sim",
    selected,
    status: s,
    label: s,
    detail: null,
    ticked: s === "ticked",
    lastRunAt: null,
    previousRunAt: null,
    durationMs: null,
  } as RunPortfolioStatus;
}

describe("backoff", () => {
  it("doubles and caps", () => {
    const cfg = DEFAULT_MANUAL_RUN_RETRY;
    expect(backoffDelayMs(1, cfg)).toBe(4_000);
    expect(backoffDelayMs(2, cfg)).toBe(8_000);
    expect(backoffDelayMs(3, cfg)).toBe(16_000);
    expect(backoffDelayMs(9, cfg)).toBe(cfg.maxDelayMs);
  });
});

describe("error classification", () => {
  it("retries lock, timeouts and transport failures", () => {
    expect(isRetryableRunError({ code: "run_in_progress", message: "busy" })).toBe(true);
    expect(isRetryableRunError({ message: "The request timed out" })).toBe(true);
    expect(isRetryableRunError({ message: "Failed to fetch" })).toBe(true);
    expect(isRetryableRunError({ message: "Worker exceeded the time limit" })).toBe(true);
  });
  it("does not retry logic errors", () => {
    expect(isRetryableRunError({ message: "Unauthorized" })).toBe(false);
    expect(isRetryableRunError({ message: "invalid portfolio id" })).toBe(false);
  });
});

describe("pendingPortfolioIds", () => {
  it("only returns un-ticked in-scope portfolios", () => {
    const rows = [
      status("a", "ticked"),
      status("b", "skipped_budget"),
      status("c", "skipped_recent"),
      status("d", "skipped_budget", false),
    ];
    expect(pendingPortfolioIds(rows, ["a", "b", "c"])).toEqual(["b"]);
  });
  it("falls back to selected flag for unscoped runs", () => {
    const rows = [status("a", "skipped_budget"), status("z", "skipped_budget", false)];
    expect(pendingPortfolioIds(rows, [])).toEqual(["a"]);
  });
});

describe("planManualRunRetry", () => {
  const req = ["a", "b", "c"];

  it("does not retry when everything was reached", () => {
    const p = planManualRunRetry({
      attempt: 1,
      elapsedMs: 30_000,
      requestedIds: req,
      outcome: { kind: "success", portfolioStatus: req.map((i) => status(i, "ticked")) },
    });
    expect(p.shouldRetry).toBe(false);
    expect(p.outcome).toBe("complete");
  });

  it("retries only the budget-starved portfolios", () => {
    const p = planManualRunRetry({
      attempt: 1,
      elapsedMs: 55_000,
      requestedIds: req,
      outcome: {
        kind: "success",
        portfolioStatus: [status("a", "ticked"), status("b", "skipped_budget"), status("c", "skipped_budget")],
      },
    });
    expect(p.shouldRetry).toBe(true);
    expect(p.portfolioIds).toEqual(["b", "c"]);
    expect(p.delayMs).toBe(4_000);
  });

  it("retries the whole scope after a timeout", () => {
    const p = planManualRunRetry({
      attempt: 1,
      elapsedMs: 56_000,
      requestedIds: req,
      outcome: { kind: "error", message: "Request timed out" },
    });
    expect(p.shouldRetry).toBe(true);
    expect(p.outcome).toBe("timeout");
    expect(p.portfolioIds).toEqual(req);
  });

  it("retries when the lock was held", () => {
    const p = planManualRunRetry({
      attempt: 1,
      elapsedMs: 1_000,
      requestedIds: req,
      outcome: { kind: "error", code: "run_in_progress", message: "busy" },
    });
    expect(p.shouldRetry).toBe(true);
    expect(p.outcome).toBe("lock_held");
  });

  it("never retries a fatal error", () => {
    const p = planManualRunRetry({
      attempt: 1,
      elapsedMs: 1_000,
      requestedIds: req,
      outcome: { kind: "error", message: "Unauthorized" },
    });
    expect(p.shouldRetry).toBe(false);
    expect(p.outcome).toBe("fatal");
  });

  it("stops after maxRetries attempts", () => {
    const p = planManualRunRetry({
      attempt: 4,
      elapsedMs: 60_000,
      requestedIds: req,
      outcome: { kind: "success", portfolioStatus: [status("a", "skipped_budget")] },
    });
    expect(p.shouldRetry).toBe(false);
    expect(p.outcome).toBe("exhausted");
  });

  it("enforces the hard total window instead of extending the per-run deadline", () => {
    const p = planManualRunRetry({
      attempt: 2,
      elapsedMs: 200_000,
      requestedIds: req,
      outcome: { kind: "success", portfolioStatus: [status("a", "skipped_budget")] },
    });
    expect(p.shouldRetry).toBe(false);
    expect(p.outcome).toBe("window_closed");
  });

  it("a full retry sequence stays inside the window and converges", () => {
    const cfg = DEFAULT_MANUAL_RUN_RETRY;
    let elapsed = 0;
    let attempt = 1;
    let remaining = ["a", "b", "c", "d"];
    const attempts: string[][] = [remaining];
    while (remaining.length > 0) {
      elapsed += cfg.attemptBudgetMs; // each attempt consumes a full server deadline
      const ticked = remaining.slice(0, 2); // deadline reaches two per attempt
      const left = remaining.filter((i) => !ticked.includes(i));
      const rows = [
        ...ticked.map((i) => status(i, "ticked")),
        ...left.map((i) => status(i, "skipped_budget")),
      ];
      const p = planManualRunRetry({
        attempt,
        elapsedMs: elapsed,
        requestedIds: remaining,
        outcome: { kind: "success", portfolioStatus: rows },
      });
      if (!p.shouldRetry) {
        remaining = left;
        expect(p.outcome).toBe("complete");
        break;
      }
      elapsed += p.delayMs;
      attempt += 1;
      remaining = p.portfolioIds;
      attempts.push(remaining);
    }
    expect(remaining).toEqual([]);
    expect(elapsed).toBeLessThanOrEqual(DEFAULT_MANUAL_RUN_RETRY.totalWindowMs);
    // no portfolio is ever re-requested once it ticked
    expect(attempts[1]).toEqual(["c", "d"]);
  });
});
