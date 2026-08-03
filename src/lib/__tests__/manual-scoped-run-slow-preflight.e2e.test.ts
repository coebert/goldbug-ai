// End-to-end simulation of a MANUAL, scoped hourly run under a slow
// pre-flight.
//
// Mirrors the production path in `hourly-run.server.ts`:
//   selection filter -> paused filter -> orderPortfoliosForRun ->
//   createBudgetGate({ overrides: 0 })  (manual runs never bypass the deadline)
//
// The regression this guards: a targeted manual run must spend its whole
// budget on the SELECTED portfolios and must never tick an unselected one.

import { describe, expect, it } from "vitest";
import {
  orderPortfoliosForRun,
  createBudgetGate,
  type SchedulablePortfolio,
} from "@/lib/run-scheduling";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 3, 13, 0, 0);

type Portfolio = SchedulablePortfolio & { live_paused?: boolean };

const ALL: Portfolio[] = [
  { id: "real", mode: "live_prod" },
  { id: "high-sim", mode: "live_sim" },
  { id: "balanced-sim", mode: "live_sim" },
  { id: "crypto", mode: "paper" },
  { id: "paused-sim", mode: "live_sim", live_paused: true },
];

const LAST_DECISION = new Map<string, number>([
  ["real", NOW - 2 * HOUR],
  ["high-sim", NOW - 30 * HOUR],
  ["balanced-sim", NOW - 20 * HOUR],
  ["crypto", NOW - 10 * HOUR],
  ["paused-sim", NOW - 40 * HOUR],
]);

type RunResult = {
  ticked: string[];
  skipped: string[];
  untouched: string[];
  skippedPaused: number;
  durationMs: number;
};

/** Runs the same selection + ordering + budget rules the server uses. */
function runManualCycle(opts: {
  portfolioIds?: string[];
  preflightMs: number;
  tickMs: number;
  budgetMs: number;
}): RunResult {
  const runStartedAt = NOW;
  // Manual runs skip broad pre-flight refreshes, but news/prices can still be
  // slow — model that cost before any portfolio is touched.
  let now = runStartedAt + opts.preflightMs;

  const selection = (opts.portfolioIds ?? []).filter((id) => typeof id === "string" && id);
  const selected = selection.length ? ALL.filter((p) => selection.includes(p.id)) : ALL;
  const eligible = selected.filter((p) => !(p.mode !== "paper" && p.live_paused));
  const skippedPaused = selected.length - eligible.length;

  const ordered = orderPortfoliosForRun(eligible, LAST_DECISION);
  // Manual runs are request-bound: no starvation overrides.
  const gate = createBudgetGate(opts.budgetMs, LAST_DECISION, { overrides: 0 });

  const ticked: string[] = [];
  const skipped: string[] = [];
  for (const p of ordered) {
    if (gate.shouldSkip(p.id, now - runStartedAt, now)) {
      skipped.push(p.id);
      continue;
    }
    now += opts.tickMs;
    ticked.push(p.id);
  }

  const touched = new Set([...ticked, ...skipped]);
  return {
    ticked,
    skipped,
    untouched: ALL.map((p) => p.id).filter((id) => !touched.has(id)),
    skippedPaused,
    durationMs: now - runStartedAt,
  };
}

// Production-shaped manual timings: pre-flight ~20s, ~9s per tick, 55s budget.
const SLOW = { preflightMs: 20_000, tickMs: 9_000, budgetMs: 55_000 };

describe("manual scoped run — slow pre-flight", () => {
  it("ticks every selected portfolio and touches nothing else", () => {
    const r = runManualCycle({ portfolioIds: ["high-sim", "crypto"], ...SLOW });

    expect(r.ticked.sort()).toEqual(["crypto", "high-sim"]);
    expect(r.skipped).toEqual([]);
    expect(r.untouched.sort()).toEqual(["balanced-sim", "paused-sim", "real"]);
  });

  it("does not run the real-money portfolio when it is not selected", () => {
    const r = runManualCycle({ portfolioIds: ["balanced-sim"], ...SLOW });
    expect(r.ticked).toEqual(["balanced-sim"]);
    expect(r.untouched).toContain("real");
  });

  it("selecting real money puts it first even against staler sims", () => {
    const r = runManualCycle({ portfolioIds: ["real", "high-sim"], ...SLOW });
    expect(r.ticked).toEqual(["real", "high-sim"]);
  });

  it("orders the selected sims stalest-first", () => {
    const r = runManualCycle({
      portfolioIds: ["crypto", "balanced-sim", "high-sim"],
      ...SLOW,
    });
    expect(r.ticked).toEqual(["high-sim", "balanced-sim", "crypto"]);
  });

  it("a paused live portfolio in the selection is reported, never ticked", () => {
    const r = runManualCycle({ portfolioIds: ["paused-sim", "crypto"], ...SLOW });
    expect(r.ticked).toEqual(["crypto"]);
    expect(r.skippedPaused).toBe(1);
    expect(r.untouched).toContain("paused-sim");
  });

  it("scoping keeps the whole run inside the request deadline", () => {
    const r = runManualCycle({ portfolioIds: ["high-sim", "crypto"], ...SLOW });
    expect(r.durationMs).toBeLessThanOrEqual(55_000);
  });

  it("no starvation override: a very slow pre-flight skips rather than overruns", () => {
    // Pre-flight alone blows the budget; every selected portfolio is stale by
    // days, yet the manual gate must still refuse to run past the deadline.
    const r = runManualCycle({
      portfolioIds: ["high-sim", "balanced-sim"],
      preflightMs: 60_000,
      tickMs: 9_000,
      budgetMs: 55_000,
    });
    expect(r.ticked).toEqual([]);
    expect(r.skipped.sort()).toEqual(["balanced-sim", "high-sim"]);
    expect(r.untouched).toContain("real");
  });

  it("an empty selection falls back to every eligible portfolio", () => {
    const r = runManualCycle({ portfolioIds: [], ...SLOW });
    expect(r.ticked.sort()).toEqual(["balanced-sim", "crypto", "high-sim", "real"]);
    expect(r.skippedPaused).toBe(1);
  });

  it("unknown ids in the selection are ignored, not treated as 'run all'", () => {
    const r = runManualCycle({ portfolioIds: ["does-not-exist", "crypto"], ...SLOW });
    expect(r.ticked).toEqual(["crypto"]);
    expect(r.untouched.sort()).toEqual([
      "balanced-sim",
      "high-sim",
      "paused-sim",
      "real",
    ]);
  });
});
