// End-to-end simulation of a MANUAL run triggered with "Force clear lock & run"
// against a SELECTED subset of portfolios.
//
// Mirrors the production path in `hourly-run.server.ts`:
//   force -> delete run_locks row -> TTL sweep -> acquireRunLock ->
//   selection filter -> paused filter -> orderPortfoliosForRun ->
//   createBudgetGate({ overrides: 0 }) -> tick fan-out -> finally release
//
// Regressions this guards:
//   1. A wedged lock (live heartbeat, not yet expired) must NOT block a force
//      run — the row is deleted before acquisition.
//   2. The lock must always be released at the end, including when a tick
//      throws, so the next manual run isn't wedged by this one.
//   3. A scoped force run must tick every selected portfolio and never touch
//      an unselected one.

import { describe, expect, it } from "vitest";
import {
  orderPortfoliosForRun,
  createBudgetGate,
  type SchedulablePortfolio,
} from "@/lib/run-scheduling";
import { expiryFor, isExpired, lockTtlMsForBudget } from "@/lib/run-lock-ttl";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 3, 13, 0, 0);
const BUDGET_MS = 55_000;

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

/** In-memory stand-in for the single-row `public.run_locks` table. */
type LockRow = { name: string; owner: string; acquired_at: string; expires_at: string | null };

class FakeLockTable {
  rows = new Map<string, LockRow>();
  deletes = 0;
  sweeps = 0;

  seed(row: LockRow) {
    this.rows.set(row.name, row);
  }
  /** `force: true` path — unconditional delete, no TTL check. */
  forceDelete(name: string) {
    this.deletes += 1;
    this.rows.delete(name);
  }
  /** TTL sweep: only rows whose absolute deadline has lapsed. */
  sweep(name: string, nowMs: number, fallbackTtlMs: number): number {
    this.sweeps += 1;
    const row = this.rows.get(name);
    if (!row) return 0;
    if (!isExpired({ acquired_at: row.acquired_at, expires_at: row.expires_at }, nowMs, fallbackTtlMs)) {
      return 0;
    }
    this.rows.delete(name);
    return 1;
  }
  acquire(name: string, owner: string, nowMs: number, ttlMs: number): LockRow | null {
    if (this.rows.has(name)) return null;
    const row: LockRow = {
      name,
      owner,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: expiryFor(nowMs, ttlMs),
    };
    this.rows.set(name, row);
    return row;
  }
  release(name: string, owner: string) {
    const row = this.rows.get(name);
    if (row && row.owner === owner) this.rows.delete(name);
  }
}

type RunOutcome = {
  ok: boolean;
  error?: string;
  ticked: string[];
  skipped: string[];
  untouched: string[];
  skippedPaused: number;
  lockHeldAfter: boolean;
  lockDeletes: number;
  durationMs: number;
};

/** Runs the same force-clear + selection + budget + release rules as the server. */
function runManualForceCycle(
  table: FakeLockTable,
  opts: {
    portfolioIds?: string[];
    force: boolean;
    preflightMs?: number;
    tickMs?: number;
    failOn?: string;
  },
): RunOutcome {
  const runStartedAt = NOW;
  const STALE_MS = 90 * 1000;
  const ticked: string[] = [];
  const skipped: string[] = [];
  let skippedPaused = 0;
  let now = runStartedAt;

  if (opts.force) table.forceDelete("hourly-run");
  table.sweep("hourly-run", now, STALE_MS);

  const lock = table.acquire("hourly-run", "manual", now, lockTtlMsForBudget(BUDGET_MS));
  if (!lock) {
    return {
      ok: false,
      error: "run_in_progress",
      ticked,
      skipped,
      untouched: ALL.map((p) => p.id),
      skippedPaused: 0,
      lockHeldAfter: table.rows.has("hourly-run"),
      lockDeletes: table.deletes,
      durationMs: 0,
    };
  }

  let error: string | undefined;
  try {
    now += opts.preflightMs ?? 4_000;

    const selection = (opts.portfolioIds ?? []).filter((id) => typeof id === "string" && id);
    const selected = selection.length ? ALL.filter((p) => selection.includes(p.id)) : ALL;
    const eligible = selected.filter((p) => !(p.mode !== "paper" && p.live_paused));
    skippedPaused = selected.length - eligible.length;

    const ordered = orderPortfoliosForRun(eligible, LAST_DECISION);
    // Manual runs are request-bound: no starvation overrides.
    const gate = createBudgetGate(BUDGET_MS, LAST_DECISION, { overrides: 0 });

    for (const p of ordered) {
      if (gate.shouldSkip(p.id, now - runStartedAt, now)) {
        skipped.push(p.id);
        continue;
      }
      now += opts.tickMs ?? 9_000;
      if (opts.failOn === p.id) throw new Error(`tick failed for ${p.id}`);
      ticked.push(p.id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    // `finally { await lock.release() }` in the server.
    table.release("hourly-run", lock.owner);
  }

  const touched = new Set([...ticked, ...skipped]);
  return {
    ok: !error,
    error,
    ticked,
    skipped,
    untouched: ALL.map((p) => p.id).filter((id) => !touched.has(id)),
    skippedPaused,
    lockHeldAfter: table.rows.has("hourly-run"),
    lockDeletes: table.deletes,
    durationMs: now - runStartedAt,
  };
}

/** A wedged lock: heartbeated recently, so TTL sweep alone would not clear it. */
function wedgedLock(): LockRow {
  return {
    name: "hourly-run",
    owner: "cron",
    acquired_at: new Date(NOW - 5_000).toISOString(),
    expires_at: expiryFor(NOW - 5_000, lockTtlMsForBudget(BUDGET_MS)),
  };
}

describe("manual force-clear, scoped run — e2e", () => {
  it("clears a live (non-expired) lock and still runs", () => {
    const table = new FakeLockTable();
    table.seed(wedgedLock());

    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["high-sim", "crypto"],
    });

    expect(r.ok).toBe(true);
    expect(r.lockDeletes).toBe(1);
    expect(r.ticked.sort()).toEqual(["crypto", "high-sim"]);
  });

  it("without force, the same wedged lock blocks the run and nothing ticks", () => {
    const table = new FakeLockTable();
    table.seed(wedgedLock());

    const r = runManualForceCycle(table, {
      force: false,
      portfolioIds: ["high-sim", "crypto"],
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe("run_in_progress");
    expect(r.ticked).toEqual([]);
    // The holder's row is untouched — a blocked trigger must not evict it.
    expect(table.rows.get("hourly-run")?.owner).toBe("cron");
  });

  it("releases the lock when the run finishes", () => {
    const table = new FakeLockTable();
    table.seed(wedgedLock());

    const r = runManualForceCycle(table, { force: true, portfolioIds: ["real"] });

    expect(r.ok).toBe(true);
    expect(r.lockHeldAfter).toBe(false);
    expect(table.rows.size).toBe(0);
  });

  it("releases the lock even when a tick throws", () => {
    const table = new FakeLockTable();
    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["high-sim", "crypto"],
      failOn: "high-sim",
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("tick failed for high-sim");
    expect(r.lockHeldAfter).toBe(false);
  });

  it("only the selected portfolios tick; the rest are untouched", () => {
    const table = new FakeLockTable();
    table.seed(wedgedLock());

    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["balanced-sim", "crypto"],
    });

    expect(r.ticked.sort()).toEqual(["balanced-sim", "crypto"]);
    expect(r.skipped).toEqual([]);
    expect(r.untouched.sort()).toEqual(["high-sim", "paused-sim", "real"]);
  });

  it("does not tick the real-money portfolio unless it is selected", () => {
    const table = new FakeLockTable();
    const r = runManualForceCycle(table, { force: true, portfolioIds: ["crypto"] });
    expect(r.ticked).toEqual(["crypto"]);
    expect(r.untouched).toContain("real");
  });

  it("a paused live portfolio in the selection is reported, never ticked", () => {
    const table = new FakeLockTable();
    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["paused-sim", "crypto"],
    });

    expect(r.skippedPaused).toBe(1);
    expect(r.ticked).toEqual(["crypto"]);
    expect(r.untouched).toContain("paused-sim");
  });

  it("selected real money runs first, then stalest sims", () => {
    const table = new FakeLockTable();
    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["crypto", "real", "high-sim"],
    });
    expect(r.ticked).toEqual(["real", "high-sim", "crypto"]);
  });

  it("a second force run right after the first is never blocked", () => {
    const table = new FakeLockTable();
    table.seed(wedgedLock());

    const first = runManualForceCycle(table, { force: true, portfolioIds: ["high-sim"] });
    const second = runManualForceCycle(table, { force: true, portfolioIds: ["crypto"] });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ticked).toEqual(["crypto"]);
    expect(table.rows.size).toBe(0);
  });

  it("stays inside the manual request deadline", () => {
    const table = new FakeLockTable();
    const r = runManualForceCycle(table, {
      force: true,
      portfolioIds: ["real", "high-sim", "balanced-sim", "crypto"],
      preflightMs: 4_000,
      tickMs: 9_000,
    });

    expect(r.ticked).toHaveLength(4);
    expect(r.durationMs).toBeLessThanOrEqual(BUDGET_MS + 9_000);
  });
});
