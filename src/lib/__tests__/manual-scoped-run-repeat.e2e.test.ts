// End-to-end simulation of running the SAME scoped manual run twice.
//
// Mirrors the production path in `hourly-run.server.ts`:
//   selection filter -> paused filter -> orderPortfoliosForRun ->
//   createBudgetGate({ overrides: 0 }) -> recent-decision guard
//   (manual runs look back 10 minutes; `force: true` bypasses it) ->
//   tick -> record decision
//
// Regressions this guards:
//   1. Re-triggering a scoped manual run must NOT double-tick a portfolio that
//      just ticked — it is skipped as "already ticked at ...", which costs no
//      AI credits and places no duplicate orders.
//   2. The second run must still leave every UNSELECTED portfolio untouched.
//   3. `force: true` is the documented override and DOES re-tick.

import { describe, expect, it } from "vitest";
import {
  orderPortfoliosForRun,
  createBudgetGate,
  type SchedulablePortfolio,
} from "@/lib/run-scheduling";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 7, 3, 13, 0, 0);
const BUDGET_MS = 55_000;
/** `recentWindowIso` in the server: manual runs look back 10 minutes. */
const MANUAL_RECENT_WINDOW_MS = 10 * MINUTE;

type Portfolio = SchedulablePortfolio & { live_paused?: boolean };

const ALL: Portfolio[] = [
  { id: "real", mode: "live_prod" },
  { id: "high-sim", mode: "live_sim" },
  { id: "balanced-sim", mode: "live_sim" },
  { id: "crypto", mode: "paper" },
  { id: "paused-sim", mode: "live_sim", live_paused: true },
];

/** Stand-in for `public.decisions`: last decision time per portfolio. */
class DecisionLog {
  private last = new Map<string, number>();
  /** Ticks recorded by the harness, in order, across all runs. */
  readonly ticks: Array<{ id: string; at: number }> = [];

  constructor(seed: Record<string, number>) {
    for (const [id, at] of Object.entries(seed)) this.last.set(id, at);
  }
  lastDecisionAt(): ReadonlyMap<string, number> {
    return new Map(this.last);
  }
  hasRecent(id: string, nowMs: number, windowMs: number): number | null {
    const at = this.last.get(id);
    return at !== undefined && at >= nowMs - windowMs ? at : null;
  }
  record(id: string, at: number) {
    this.last.set(id, at);
    this.ticks.push({ id, at });
  }
  tickCount(id: string): number {
    return this.ticks.filter((t) => t.id === id).length;
  }
}

type RunOutcome = {
  ticked: string[];
  skippedAlreadyTicked: string[];
  skippedBudget: string[];
  untouched: string[];
  skippedPaused: number;
  endedAt: number;
};

/** Runs the server's selection + ordering + budget + recent-decision rules. */
function runScopedManualCycle(
  log: DecisionLog,
  opts: {
    portfolioIds?: string[];
    startedAt: number;
    force?: boolean;
    preflightMs?: number;
    tickMs?: number;
  },
): RunOutcome {
  const runStartedAt = opts.startedAt;
  let now = runStartedAt + (opts.preflightMs ?? 4_000);

  const selection = (opts.portfolioIds ?? []).filter((id) => typeof id === "string" && id);
  const selected = selection.length ? ALL.filter((p) => selection.includes(p.id)) : ALL;
  const eligible = selected.filter((p) => !(p.mode !== "paper" && p.live_paused));
  const skippedPaused = selected.length - eligible.length;

  const lastDecisionAt = log.lastDecisionAt();
  const ordered = orderPortfoliosForRun(eligible, lastDecisionAt);
  // Manual runs are request-bound: no starvation overrides.
  const gate = createBudgetGate(BUDGET_MS, lastDecisionAt, { overrides: 0 });

  const ticked: string[] = [];
  const skippedAlreadyTicked: string[] = [];
  const skippedBudget: string[] = [];

  for (const p of ordered) {
    if (gate.shouldSkip(p.id, now - runStartedAt, now)) {
      skippedBudget.push(p.id);
      continue;
    }
    // `if (!(manualTrigger && forceClear))` in the server.
    if (!opts.force && log.hasRecent(p.id, now, MANUAL_RECENT_WINDOW_MS) !== null) {
      skippedAlreadyTicked.push(p.id);
      continue;
    }
    now += opts.tickMs ?? 9_000;
    log.record(p.id, now);
    ticked.push(p.id);
  }

  const touched = new Set([...ticked, ...skippedAlreadyTicked, ...skippedBudget]);
  return {
    ticked,
    skippedAlreadyTicked,
    skippedBudget,
    untouched: ALL.map((p) => p.id).filter((id) => !touched.has(id)),
    skippedPaused,
    endedAt: now,
  };
}

/** All portfolios last decided hours ago — nothing is inside the manual window. */
function freshLog() {
  return new DecisionLog({
    real: T0 - 2 * HOUR,
    "high-sim": T0 - 30 * HOUR,
    "balanced-sim": T0 - 20 * HOUR,
    crypto: T0 - 10 * HOUR,
    "paused-sim": T0 - 40 * HOUR,
  });
}

describe("scoped manual run, triggered twice — e2e", () => {
  it("second run skips the just-ticked selection instead of double-ticking", () => {
    const log = freshLog();
    const selection = ["high-sim", "crypto"];

    const first = runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    expect(first.ticked.sort()).toEqual(["crypto", "high-sim"]);

    // Re-trigger ~1 minute later, same selection.
    const second = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + MINUTE,
    });

    expect(second.ticked).toEqual([]);
    expect(second.skippedAlreadyTicked.sort()).toEqual(["crypto", "high-sim"]);
    expect(log.tickCount("high-sim")).toBe(1);
    expect(log.tickCount("crypto")).toBe(1);
  });

  it("the second run still touches nothing outside the selection", () => {
    const log = freshLog();
    const selection = ["balanced-sim", "crypto"];

    runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    const second = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + 2 * MINUTE,
    });

    expect(second.untouched.sort()).toEqual(["high-sim", "paused-sim", "real"]);
    expect(log.tickCount("real")).toBe(0);
    expect(log.tickCount("high-sim")).toBe(0);
    expect(log.tickCount("paused-sim")).toBe(0);
  });

  it("real money is never re-ticked by an immediate repeat run", () => {
    const log = freshLog();

    runScopedManualCycle(log, { portfolioIds: ["real"], startedAt: T0 });
    const second = runScopedManualCycle(log, { portfolioIds: ["real"], startedAt: T0 + 30_000 });

    expect(second.ticked).toEqual([]);
    expect(second.skippedAlreadyTicked).toEqual(["real"]);
    expect(log.tickCount("real")).toBe(1);
  });

  it("a newly added portfolio in the second selection still ticks", () => {
    const log = freshLog();

    runScopedManualCycle(log, { portfolioIds: ["high-sim"], startedAt: T0 });
    const second = runScopedManualCycle(log, {
      portfolioIds: ["high-sim", "balanced-sim"],
      startedAt: T0 + MINUTE,
    });

    expect(second.ticked).toEqual(["balanced-sim"]);
    expect(second.skippedAlreadyTicked).toEqual(["high-sim"]);
    expect(second.untouched.sort()).toEqual(["crypto", "paused-sim", "real"]);
  });

  it("force: true is the documented override and does re-tick", () => {
    const log = freshLog();
    const selection = ["high-sim", "crypto"];

    runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    const second = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + MINUTE,
      force: true,
    });

    expect(second.ticked.sort()).toEqual(["crypto", "high-sim"]);
    expect(log.tickCount("high-sim")).toBe(2);
    // Forcing a repeat still must not reach unselected profiles.
    expect(second.untouched.sort()).toEqual(["balanced-sim", "paused-sim", "real"]);
  });

  it("once the 10-minute window lapses, the same selection ticks again", () => {
    const log = freshLog();
    const selection = ["crypto"];

    runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    const later = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + 11 * MINUTE,
    });

    expect(later.ticked).toEqual(["crypto"]);
    expect(log.tickCount("crypto")).toBe(2);
  });

  it("repeat runs are cheap: no tick work, so nothing is skipped for budget", () => {
    const log = freshLog();
    const selection = ["real", "high-sim", "balanced-sim", "crypto"];

    runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    const second = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + MINUTE,
    });

    expect(second.skippedBudget).toEqual([]);
    expect(second.skippedAlreadyTicked.sort()).toEqual([
      "balanced-sim",
      "crypto",
      "high-sim",
      "real",
    ]);
    expect(second.endedAt - (T0 + MINUTE)).toBeLessThan(BUDGET_MS);
  });

  it("a paused live portfolio stays reported-but-untouched across both runs", () => {
    const log = freshLog();
    const selection = ["paused-sim", "crypto"];

    const first = runScopedManualCycle(log, { portfolioIds: selection, startedAt: T0 });
    const second = runScopedManualCycle(log, {
      portfolioIds: selection,
      startedAt: T0 + MINUTE,
    });

    expect(first.skippedPaused).toBe(1);
    expect(second.skippedPaused).toBe(1);
    expect(log.tickCount("paused-sim")).toBe(0);
    expect(log.tickCount("crypto")).toBe(1);
  });
});
