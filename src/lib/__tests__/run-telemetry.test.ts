// Unit tests for run telemetry: deadline accounting, pre-flight phase
// timings, and portfolio-selection diagnostics.

import { describe, expect, it } from "vitest";
import { createRunTelemetry, describeSelection, newRunId } from "@/lib/run-telemetry";

function harness(opts: Partial<Parameters<typeof createRunTelemetry>[0]> = {}) {
  let t = 1_000_000;
  const records: Array<Record<string, unknown>> = [];
  const tel = createRunTelemetry({
    triggeredBy: "manual",
    budgetMs: 55_000,
    preflightRefresh: false,
    runId: "run_test",
    now: () => t,
    emit: (r) => records.push(r),
    ...opts,
  });
  return { tel, records, advance: (ms: number) => (t += ms) };
}

describe("run telemetry", () => {
  it("emits a run.start record with budget and trigger", () => {
    const { records } = harness();
    expect(records[0]).toMatchObject({
      evt: "run.start",
      run_id: "run_test",
      triggered_by: "manual",
      budget_ms: 55_000,
      preflight_refresh: false,
    });
  });

  it("tags every record with the same run_id", () => {
    const { tel, records, advance } = harness();
    tel.recordPhase("news", 100);
    advance(500);
    tel.finish();
    expect(new Set(records.map((r) => r.run_id))).toEqual(new Set(["run_test"]));
  });

  it("accumulates pre-flight cost and expresses it as a share of budget", () => {
    const { tel } = harness();
    tel.recordPhase("saxo_refresh", 11_000);
    tel.recordPhase("prices", 5_000);
    tel.recordPhase("news", 0, true, "preflight disabled");
    const snap = tel.snapshot();
    expect(snap.preflight_ms).toBe(16_000);
    expect(snap.preflight_budget_pct).toBeCloseTo(29.1, 1);
    expect(snap.phases.find((p) => p.phase === "news")?.skipped).toBe(true);
  });

  it("flags a deadline overrun with the overrun amount", () => {
    const { tel, advance } = harness();
    advance(70_000);
    const snap = tel.finish();
    expect(snap.deadline_exceeded).toBe(true);
    expect(snap.overrun_ms).toBe(15_000);
  });

  it("a run inside its budget is not flagged", () => {
    const { tel, advance, records } = harness();
    advance(40_000);
    const snap = tel.finish();
    expect(snap.deadline_exceeded).toBe(false);
    expect(snap.overrun_ms).toBe(0);
    expect(records.at(-1)).toMatchObject({ evt: "run.finish", level: "info" });
  });

  it("records tick durations and outcomes", () => {
    const { tel, advance } = harness();
    const t0 = tel.tickStart("real", "live_prod");
    advance(9_000);
    tel.tickEnd("real", "live_prod", t0, "ok");
    tel.tickSkipped("crypto", "paper", "budget-exceeded");
    const snap = tel.snapshot();
    expect(snap.ticked).toEqual(["real"]);
    expect(snap.skipped_budget).toEqual(["crypto"]);
    expect(snap.ticks[0].ms).toBe(9_000);
  });

  it("logs skipped ticks at warn level so they surface in log filters", () => {
    const { tel, records } = harness();
    tel.tickSkipped("high-sim", "live_sim", "budget-exceeded (elapsed 56s)");
    expect(records.at(-1)).toMatchObject({ evt: "tick.skip", level: "warn" });
  });

  it("records a failed run with the error message", () => {
    const { tel, records } = harness();
    tel.failed(new Error("worker terminated"));
    expect(records.at(-1)).toMatchObject({
      evt: "run.failed",
      level: "error",
      error: "worker terminated",
    });
  });

  it("run ids are unique", () => {
    expect(newRunId(1, () => 0.1)).not.toBe(newRunId(2, () => 0.9));
  });
});

describe("describeSelection", () => {
  const rows = [
    { id: "real", mode: "live_prod", live_paused: false },
    { id: "high-sim", mode: "live_sim", live_paused: false },
    { id: "paused-sim", mode: "live_sim", live_paused: true },
    { id: "crypto", mode: "paper", live_paused: true },
  ];

  it("reports an unscoped run as all eligible portfolios", () => {
    const s = describeSelection(undefined, rows);
    expect(s.scoped).toBe(false);
    // paper portfolios ignore live_paused
    expect(s.eligible).toEqual(["real", "high-sim", "crypto"]);
    expect(s.paused_excluded).toEqual(["paused-sim"]);
  });

  it("reports matched vs unknown ids for a scoped manual run", () => {
    const s = describeSelection(["high-sim", "ghost"], rows);
    expect(s.scoped).toBe(true);
    expect(s.requested_count).toBe(2);
    expect(s.matched).toEqual(["high-sim"]);
    expect(s.unknown_ids).toEqual(["ghost"]);
    expect(s.eligible).toEqual(["high-sim"]);
  });

  it("keeps a paused selection visible instead of silently dropping it", () => {
    const s = describeSelection(["paused-sim"], rows);
    expect(s.matched).toEqual(["paused-sim"]);
    expect(s.paused_excluded).toEqual(["paused-sim"]);
    expect(s.eligible).toEqual([]);
  });

  it("warns in the log when a requested id does not exist", () => {
    const { tel, records } = harness();
    tel.recordSelection(describeSelection(["ghost"], rows));
    expect(records.at(-1)).toMatchObject({ evt: "selection.resolved", level: "warn" });
  });

  it("selection logging includes pre-flight cost already spent", () => {
    const { tel, records } = harness();
    tel.recordPhase("prices", 20_000);
    tel.recordSelection(describeSelection(["real"], rows));
    expect(records.at(-1)).toMatchObject({
      evt: "selection.resolved",
      preflight_ms: 20_000,
      preflight_budget_pct: 36.4,
    });
  });
});
