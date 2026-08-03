// Slow pre-flight simulation for the hourly run scheduler.
//
// Reproduces the production failure: pre-flight (news + prices + broker
// refresh) burns most of the run budget, so only the first portfolio in a
// fixed mode ordering ever ticked and the sims went days without a decision.
//
// The simulator below runs the SAME rules the engine uses
// (`orderPortfoliosForRun` + `createBudgetGate`) over successive hourly
// cycles, and asserts that every portfolio — including the real-cash one —
// gets ticked.

import { describe, expect, it } from "vitest";
import {
  orderPortfoliosForRun,
  createBudgetGate,
  STARVED_MS,
  type SchedulablePortfolio,
} from "@/lib/run-scheduling";

const HOUR = 60 * 60 * 1000;

type Sim = {
  portfolios: SchedulablePortfolio[];
  budgetMs: number;
  preflightMs: number;
  tickMs: number;
  /** cycles to run */
  cycles: number;
  startMs?: number;
  /** ms since epoch of the last decision per portfolio at t0 */
  initialLastDecision?: Record<string, number>;
};

type CycleLog = { at: number; ticked: string[]; skipped: string[]; order: string[] };

/** Drives the real scheduling helpers over N hourly cycles. */
function simulate(sim: Sim): { cycles: CycleLog[]; lastDecisionAt: Map<string, number> } {
  const lastDecisionAt = new Map<string, number>(
    Object.entries(sim.initialLastDecision ?? {}),
  );
  const cycles: CycleLog[] = [];
  let now = sim.startMs ?? Date.UTC(2026, 7, 3, 6, 0, 0);

  for (let c = 0; c < sim.cycles; c++) {
    const runStartedAt = now;
    // Pre-flight happens before any portfolio is touched.
    now += sim.preflightMs;

    const ordered = orderPortfoliosForRun(sim.portfolios, lastDecisionAt);
    const gate = createBudgetGate(sim.budgetMs, lastDecisionAt);
    const log: CycleLog = {
      at: runStartedAt,
      ticked: [],
      skipped: [],
      order: ordered.map((p) => p.id),
    };

    for (const p of ordered) {
      const elapsed = now - runStartedAt;
      if (gate.shouldSkip(p.id, elapsed, now)) {
        log.skipped.push(p.id);
        continue;
      }
      now += sim.tickMs;
      lastDecisionAt.set(p.id, now);
      log.ticked.push(p.id);
    }

    cycles.push(log);
    // Next cron fires on the hour regardless of how long this run took.
    now = runStartedAt + HOUR;
  }

  return { cycles, lastDecisionAt };
}

const PORTFOLIOS: SchedulablePortfolio[] = [
  { id: "real", mode: "live_prod" },
  { id: "high-sim", mode: "live_sim" },
  { id: "balanced-sim", mode: "live_sim" },
  { id: "crypto", mode: "paper" },
];

// Production-shaped timings: pre-flight ~20s, each tick ~9s, 55s budget.
const SLOW_PREFLIGHT = { preflightMs: 20_000, tickMs: 9_000, budgetMs: 55_000 };

describe("hourly run scheduling — slow pre-flight", () => {
  it("regression: old fixed-mode ordering + no override starves every sim", () => {
    // Old behaviour reproduced: 22s budget, fixed ordering (real always
    // first), no starvation override. Only the real portfolio ever ticks.
    const lastDecisionAt = new Map<string, number>();
    let now = Date.UTC(2026, 7, 3, 6, 0, 0);
    const tickedIds = new Set<string>();
    for (let c = 0; c < 8; c++) {
      const runStartedAt = now;
      now += 20_000; // slow pre-flight
      for (const p of PORTFOLIOS) {
        // fixed order, no staleness sort
        if (now - runStartedAt > 22_000) continue; // no override
        now += 9_000;
        lastDecisionAt.set(p.id, now);
        tickedIds.add(p.id);
      }
      now = runStartedAt + HOUR;
    }
    expect([...tickedIds]).toEqual(["real"]);
    expect(lastDecisionAt.has("high-sim")).toBe(false);
    expect(lastDecisionAt.has("balanced-sim")).toBe(false);
  });

  it("every portfolio — including real cash — is ticked within a few cycles", () => {
    const { cycles, lastDecisionAt } = simulate({
      portfolios: PORTFOLIOS,
      ...SLOW_PREFLIGHT,
      cycles: 4,
      // Sims have been starved for days; real ticked an hour ago.
      initialLastDecision: {
        real: Date.UTC(2026, 7, 3, 5, 0, 0),
        "high-sim": Date.UTC(2026, 6, 31, 10, 0, 0),
        "balanced-sim": Date.UTC(2026, 6, 31, 10, 0, 0),
        crypto: Date.UTC(2026, 7, 3, 0, 0, 0),
      },
    });

    for (const p of PORTFOLIOS) {
      expect(lastDecisionAt.has(p.id), `${p.id} never ticked`).toBe(true);
    }
    // Real money is first in the very first cycle — it is never displaced by
    // a starved sim.
    expect(cycles[0].order[0]).toBe("real");
    expect(cycles[0].ticked).toContain("real");
  });

  it("real cash ticks on EVERY cycle even while sims are catching up", () => {
    const { cycles } = simulate({
      portfolios: PORTFOLIOS,
      ...SLOW_PREFLIGHT,
      cycles: 6,
      initialLastDecision: {
        "high-sim": 0,
        "balanced-sim": 0,
        crypto: 0,
      },
    });
    for (const [i, c] of cycles.entries()) {
      expect(c.ticked, `cycle ${i} missed real money`).toContain("real");
    }
  });

  it("starvation guard admits one over-budget portfolio per cycle, not all", () => {
    // Budget so tight only the first portfolio fits; three starved sims.
    const { cycles } = simulate({
      portfolios: PORTFOLIOS,
      preflightMs: 20_000,
      tickMs: 9_000,
      budgetMs: 22_000,
      cycles: 1,
      initialLastDecision: { real: Date.UTC(2026, 7, 3, 5, 0, 0) },
    });
    // real (in budget) + exactly one starved sim via the override.
    expect(cycles[0].ticked).toHaveLength(2);
    expect(cycles[0].ticked[0]).toBe("real");
    expect(cycles[0].skipped).toHaveLength(2);
  });

  it("stalest-first rotation gives each sim a turn across cycles", () => {
    const { cycles } = simulate({
      portfolios: PORTFOLIOS,
      preflightMs: 20_000,
      tickMs: 9_000,
      budgetMs: 22_000,
      cycles: 4,
      initialLastDecision: {
        real: Date.UTC(2026, 7, 3, 5, 0, 0),
        "high-sim": Date.UTC(2026, 6, 31, 10, 0, 0),
        "balanced-sim": Date.UTC(2026, 6, 31, 11, 0, 0),
        crypto: Date.UTC(2026, 6, 31, 12, 0, 0),
      },
    });
    const nonRealTicks = cycles.flatMap((c) => c.ticked.filter((id) => id !== "real"));
    // Stalest sim goes first, then the next stalest — no repeats before all
    // three have had a turn.
    expect(nonRealTicks.slice(0, 3)).toEqual(["high-sim", "balanced-sim", "crypto"]);
  });

  it("does not burn the override on a portfolio that ticked recently", () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const gate = createBudgetGate(
      22_000,
      new Map([["fresh", now - HOUR]]), // 1h old, not starved
    );
    expect(gate.shouldSkip("fresh", 30_000, now)).toBe(true);
    // Override still available for a genuinely starved portfolio.
    const gate2 = createBudgetGate(22_000, new Map([["stale", now - STARVED_MS - 1]]));
    expect(gate2.shouldSkip("stale", 30_000, now)).toBe(false);
    expect(gate2.shouldSkip("stale", 30_000, now)).toBe(true); // consumed
  });

  it("under-budget portfolios are never skipped regardless of staleness", () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const gate = createBudgetGate(55_000, new Map([["a", now]]));
    expect(gate.shouldSkip("a", 10_000, now)).toBe(false);
    expect(gate.shouldSkip("a", 55_000, now)).toBe(false);
  });

  it("with a 55s budget and slow pre-flight all four tick in a single cycle", () => {
    const { cycles } = simulate({
      portfolios: PORTFOLIOS,
      ...SLOW_PREFLIGHT,
      cycles: 1,
    });
    expect(cycles[0].ticked).toEqual(
      expect.arrayContaining(["real", "high-sim", "balanced-sim", "crypto"]),
    );
    expect(cycles[0].skipped).toHaveLength(0);
  });

  it("bounded starvation: nobody waits much beyond the 6h starvation window", () => {
    // With a tight budget only the override lets sims through, and the
    // override only fires once a portfolio is STARVED_MS stale — so the
    // worst-case wait is the starvation window plus one cycle, not forever.
    const { cycles } = simulate({
      portfolios: PORTFOLIOS,
      preflightMs: 20_000,
      tickMs: 9_000,
      budgetMs: 22_000,
      cycles: 10,
      initialLastDecision: { real: 0, "high-sim": 0, "balanced-sim": 0, crypto: 0 },
    });
    const lastSeen = new Map<string, number>(PORTFOLIOS.map((p) => [p.id, -1]));
    const maxGap = new Map<string, number>(PORTFOLIOS.map((p) => [p.id, 0]));
    cycles.forEach((c, i) => {
      for (const id of c.ticked) {
        maxGap.set(id, Math.max(maxGap.get(id)!, i - lastSeen.get(id)!));
        lastSeen.set(id, i);
      }
    });
    for (const p of PORTFOLIOS) {
      expect(lastSeen.get(p.id), `${p.id} never ticked`).toBeGreaterThanOrEqual(0);
      expect(maxGap.get(p.id), `${p.id} gap too large`).toBeLessThanOrEqual(
        STARVED_MS / HOUR + 1,
      );
    }
  });
});

describe("manual runs", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);

  it("manual gate remains bounded after the request budget is exhausted", () => {
    // Manual requests cannot use starvation overrides: allowing every stale
    // portfolio through caused the worker to time out and strand run_locks.
    const last = new Map<string, number>([
      ["real", now - 2 * HOUR],
      ["high-sim", now - 3 * HOUR],
    ]);
    const gate = createBudgetGate(55_000, last, { overrides: 0 });
    expect(gate.shouldSkip("real", 54_999, now)).toBe(false);
    expect(gate.shouldSkip("high-sim", 55_001, now)).toBe(true);
  });

  it("manual gate skips a recent portfolio after the deadline", () => {
    const gate = createBudgetGate(55_000, new Map([["fresh", now - 5 * 60_000]]), {
      overrides: 0,
    });
    expect(gate.shouldSkip("fresh", 90_000, now)).toBe(true);
  });

  it("cron gate is unchanged: one 6h override only", () => {
    const last = new Map<string, number>([
      ["a", now - 8 * HOUR],
      ["b", now - 8 * HOUR],
    ]);
    const gate = createBudgetGate(22_000, last, { overrides: 1 });
    expect(gate.shouldSkip("a", 90_000, now)).toBe(false);
    expect(gate.shouldSkip("b", 90_000, now)).toBe(true);
  });
});
