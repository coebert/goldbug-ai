// End-to-end simulation of a MANUAL run whose worker is TERMINATED mid-flight
// (deadline hit / isolate evicted), so its `finally { release() }` never runs
// and the `run_locks` row survives.
//
// Mirrors the production path in `run-lock.server.ts` + `hourly-run.server.ts`:
//   sweepExpiredRunLocks(TTL) -> insert -> on conflict read row ->
//   isExpired || age > staleMs -> delete(name, acquired_at) + re-insert
//
// Regressions this guards:
//   1. A second manual run started while the abandoned lock is still inside
//      its TTL must be told "run in progress" (no double-run).
//   2. Once the TTL lapses the stale row is auto-released with NO force clear,
//      and the second run acquires the lock and ticks the SAME selection.
//   3. The recovered lock belongs to the new owner, carries a fresh expiry,
//      and is properly released when the second run completes.

import { describe, expect, it } from "vitest";
import {
  orderPortfoliosForRun,
  createBudgetGate,
  type SchedulablePortfolio,
} from "@/lib/run-scheduling";
import {
  expiryFor,
  isExpired,
  lockTtlMsForBudget,
  msUntilExpiry,
} from "@/lib/run-lock-ttl";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 3, 13, 0, 0);
const BUDGET_MS = 55_000;
const STALE_MS = 90 * 1000;
const TTL_MS = lockTtlMsForBudget(BUDGET_MS); // 55s + 20s grace, floored at 60s

type Portfolio = SchedulablePortfolio & { live_paused?: boolean };

const ALL: Portfolio[] = [
  { id: "real", mode: "live_prod" },
  { id: "high-sim", mode: "live_sim" },
  { id: "balanced-sim", mode: "live_sim" },
  { id: "crypto", mode: "paper" },
];

const SELECTION = ["high-sim", "balanced-sim"];

function lastDecisionMap(): Map<string, number> {
  return new Map<string, number>([
    ["real", T0 - 2 * HOUR],
    ["high-sim", T0 - 30 * HOUR],
    ["balanced-sim", T0 - 20 * HOUR],
    ["crypto", T0 - 10 * HOUR],
  ]);
}

type LockRow = { name: string; owner: string; acquired_at: string; expires_at: string | null };

/** In-memory stand-in for `public.run_locks` with the real acquire semantics. */
class FakeLockTable {
  rows = new Map<string, LockRow>();
  sweepsRemoved = 0;
  evictions = 0;
  forceDeletes = 0;

  seed(row: LockRow) {
    this.rows.set(row.name, row);
  }
  forceDelete(name: string) {
    this.forceDeletes += 1;
    this.rows.delete(name);
  }
  /** `sweepExpiredRunLocks` — deletes only rows past their absolute deadline. */
  sweep(name: string, nowMs: number): number {
    const row = this.rows.get(name);
    if (!row) return 0;
    if (!isExpired(row, nowMs, STALE_MS)) return 0;
    this.rows.delete(name);
    this.sweepsRemoved += 1;
    return 1;
  }
  /** `acquireRunLock` — sweep, insert, else TTL/age eviction, else busy. */
  acquire(
    name: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): { row: LockRow; trigger: "fresh" | "ttl-expired" | "age" } | { busy: LockRow } {
    this.sweep(name, nowMs);
    const claim = (): LockRow => ({
      name,
      owner,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: expiryFor(nowMs, ttlMs),
    });
    const existing = this.rows.get(name);
    if (!existing) {
      const row = claim();
      this.rows.set(name, row);
      return { row, trigger: "fresh" };
    }
    const ttlExpired = isExpired(existing, nowMs, STALE_MS);
    const ageMs = nowMs - Date.parse(existing.acquired_at);
    if (ttlExpired || ageMs > STALE_MS) {
      this.rows.delete(name);
      const row = claim();
      this.rows.set(name, row);
      this.evictions += 1;
      return { row, trigger: ttlExpired ? "ttl-expired" : "age" };
    }
    return { busy: existing };
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
  lockOwner: string | null;
  lockTrigger: string | null;
  lockHeldAfter: boolean;
};

/**
 * One manual run. `killAt` simulates worker termination: we throw out of the
 * loop WITHOUT running the release, exactly like a terminated isolate.
 */
function runManual(
  table: FakeLockTable,
  opts: {
    owner: string;
    startedAt: number;
    portfolioIds?: string[];
    force?: boolean;
    tickMs?: number;
    preflightMs?: number;
    terminateAfterMs?: number;
  },
): RunOutcome {
  const ticked: string[] = [];
  const skipped: string[] = [];
  let now = opts.startedAt;

  if (opts.force) table.forceDelete("hourly-run");

  const res = table.acquire("hourly-run", opts.owner, now, TTL_MS);
  if ("busy" in res) {
    return {
      ok: false,
      error: "run_in_progress",
      ticked,
      skipped,
      untouched: ALL.map((p) => p.id),
      lockOwner: res.busy.owner,
      lockTrigger: null,
      lockHeldAfter: true,
    };
  }

  let error: string | undefined;
  let terminated = false;
  try {
    now += opts.preflightMs ?? 4_000;
    const selection = (opts.portfolioIds ?? []).filter(Boolean);
    const selected = selection.length ? ALL.filter((p) => selection.includes(p.id)) : ALL;
    const ordered = orderPortfoliosForRun(selected, lastDecisionMap());
    const gate = createBudgetGate(BUDGET_MS, lastDecisionMap(), { overrides: 0 });

    for (const p of ordered) {
      if (
        opts.terminateAfterMs !== undefined &&
        now - opts.startedAt >= opts.terminateAfterMs
      ) {
        terminated = true;
        break;
      }
      if (gate.shouldSkip(p.id, now - opts.startedAt, now)) {
        skipped.push(p.id);
        continue;
      }
      now += opts.tickMs ?? 9_000;
      ticked.push(p.id);
    }
    if (terminated) error = "worker_terminated";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    // A terminated worker never reaches its release — skip it deliberately.
    if (!terminated) table.release("hourly-run", res.row.owner);
  }

  const touched = new Set([...ticked, ...skipped]);
  return {
    ok: !error,
    error,
    ticked,
    skipped,
    untouched: ALL.map((p) => p.id).filter((id) => !touched.has(id)),
    lockOwner: res.row.owner,
    lockTrigger: res.trigger,
    lockHeldAfter: table.rows.has("hourly-run"),
  };
}

describe("manual run timeout → stale lock auto-release — e2e", () => {
  it("leaves the lock behind when the worker is terminated mid-run", () => {
    const table = new FakeLockTable();
    const first = runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });

    expect(first.ok).toBe(false);
    expect(first.error).toBe("worker_terminated");
    expect(first.lockHeldAfter).toBe(true);
    expect(table.rows.get("hourly-run")?.owner).toBe("manual-1");
  });

  it("blocks a second manual run while the abandoned lock is still inside its TTL", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });

    const second = runManual(table, {
      owner: "manual-2",
      startedAt: T0 + 10_000, // well inside the TTL
      portfolioIds: SELECTION,
    });

    expect(second.ok).toBe(false);
    expect(second.error).toBe("run_in_progress");
    expect(second.lockOwner).toBe("manual-1");
    expect(second.ticked).toEqual([]);
    expect(table.evictions).toBe(0);
  });

  it("auto-releases the stale lock once the TTL lapses and the second run acquires it", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });

    const after = T0 + TTL_MS + 1_000;
    expect(msUntilExpiry(table.rows.get("hourly-run")!, after, STALE_MS)).toBeLessThan(0);

    const second = runManual(table, {
      owner: "manual-2",
      startedAt: after,
      portfolioIds: SELECTION,
    });

    expect(second.ok).toBe(true);
    expect(second.error).toBeUndefined();
    expect(second.lockOwner).toBe("manual-2");
    // Recovered by the TTL sweep, not by an age fallback and not by force.
    expect(table.sweepsRemoved).toBe(1);
    expect(table.forceDeletes).toBe(0);
  });

  it("ticks exactly the same selection on the recovered run", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 0, // died before any tick
    });

    const second = runManual(table, {
      owner: "manual-2",
      startedAt: T0 + TTL_MS + 1_000,
      portfolioIds: SELECTION,
    });

    expect(second.ticked.sort()).toEqual([...SELECTION].sort());
    expect(second.skipped).toEqual([]);
    expect(second.untouched.sort()).toEqual(["crypto", "real"]);
  });

  it("gives the recovered lock a fresh owner and a fresh expiry", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });
    const staleExpiry = Date.parse(table.rows.get("hourly-run")!.expires_at!);

    const after = T0 + TTL_MS + 1_000;
    let captured: LockRow | null = null;
    const origRelease = table.release.bind(table);
    table.release = (name, owner) => {
      captured = table.rows.get(name) ?? null;
      origRelease(name, owner);
    };

    const second = runManual(table, {
      owner: "manual-2",
      startedAt: after,
      portfolioIds: SELECTION,
    });

    expect(second.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.owner).toBe("manual-2");
    expect(Date.parse(captured!.expires_at!)).toBeGreaterThan(staleExpiry);
  });

  it("releases the lock at the end of the recovered run so a third run is fresh", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });
    runManual(table, {
      owner: "manual-2",
      startedAt: T0 + TTL_MS + 1_000,
      portfolioIds: SELECTION,
    });

    expect(table.rows.has("hourly-run")).toBe(false);

    const third = runManual(table, {
      owner: "manual-3",
      startedAt: T0 + TTL_MS + 60_000,
      portfolioIds: SELECTION,
    });
    expect(third.ok).toBe(true);
    expect(third.lockTrigger).toBe("fresh");
    expect(table.rows.has("hourly-run")).toBe(false);
  });

  it("force clear is an alternative, not a requirement, for a timed-out run", () => {
    const table = new FakeLockTable();
    runManual(table, {
      owner: "manual-1",
      startedAt: T0,
      portfolioIds: SELECTION,
      terminateAfterMs: 5_000,
    });

    const forced = runManual(table, {
      owner: "manual-2",
      startedAt: T0 + 10_000, // inside TTL — only force can clear this
      portfolioIds: SELECTION,
      force: true,
    });

    expect(forced.ok).toBe(true);
    expect(table.forceDeletes).toBe(1);
    expect(forced.ticked.sort()).toEqual([...SELECTION].sort());
  });

  it("legacy rows without expires_at are still recovered via the staleness fallback", () => {
    const table = new FakeLockTable();
    table.seed({
      name: "hourly-run",
      owner: "legacy-worker",
      acquired_at: new Date(T0 - 5 * 60_000).toISOString(),
      expires_at: null,
    });

    const r = runManual(table, {
      owner: "manual-2",
      startedAt: T0,
      portfolioIds: SELECTION,
    });

    expect(r.ok).toBe(true);
    expect(r.lockOwner).toBe("manual-2");
    expect(r.ticked.sort()).toEqual([...SELECTION].sort());
  });
});
