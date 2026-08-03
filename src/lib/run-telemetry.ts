// Structured telemetry for the hourly / manual run cycle.
//
// Why: manual runs were failing intermittently (deadline overruns, slow
// pre-flight, wrong portfolio selection) and the plain `console.log` trail
// was not enough to tell WHICH of those happened. Everything here emits a
// single-line JSON record with a stable `evt` name and a shared `run_id`, so
// a whole run can be reconstructed from the server logs by grepping one id.
//
// Pure and dependency-free so it can be unit-tested without a database.

export type RunPhase =
  | "saxo_refresh"
  | "news"
  | "regime"
  | "symbols"
  | "prices"
  | "ticks";

export type PhaseTiming = { phase: RunPhase; ms: number; skipped: boolean; note?: string };

export type SelectionTelemetry = {
  requested: string[];
  requested_count: number;
  matched: string[];
  unknown_ids: string[];
  paused_excluded: string[];
  eligible: string[];
  scoped: boolean;
};

export type RunTelemetrySnapshot = {
  run_id: string;
  triggered_by: "manual" | "cron";
  force: boolean;
  budget_ms: number;
  preflight_refresh: boolean;
  preflight_ms: number;
  /** Fraction of the run budget consumed before the first portfolio tick. */
  preflight_budget_pct: number;
  phases: PhaseTiming[];
  selection: SelectionTelemetry | null;
  ticks: Array<{ id: string; mode: string; ms: number; outcome: "ok" | "error" | "skipped"; reason?: string }>;
  ticked: string[];
  skipped_budget: string[];
  duration_ms: number;
  /** True when the run ran past its own budget (the manual-run failure mode). */
  deadline_exceeded: boolean;
  overrun_ms: number;
};

type Emit = (record: Record<string, unknown>) => void;

const defaultEmit: Emit = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

export function newRunId(now = Date.now(), rand = Math.random): string {
  return `run_${now.toString(36)}_${Math.floor(rand() * 1e6).toString(36)}`;
}

/**
 * Collects timings + selection facts for one run and emits structured logs.
 *
 * `now` and `emit` are injectable so tests can drive deterministic clocks and
 * capture records instead of writing to the console.
 */
export function createRunTelemetry(opts: {
  triggeredBy: "manual" | "cron";
  force?: boolean;
  budgetMs: number;
  preflightRefresh: boolean;
  runId?: string;
  now?: () => number;
  emit?: Emit;
}) {
  const now = opts.now ?? (() => Date.now());
  const emit = opts.emit ?? defaultEmit;
  const runId = opts.runId ?? newRunId(now());
  const startedAt = now();
  const base = {
    svc: "hourly-run",
    run_id: runId,
    triggered_by: opts.triggeredBy,
  } as const;

  const phases: PhaseTiming[] = [];
  const ticks: RunTelemetrySnapshot["ticks"] = [];
  let selection: SelectionTelemetry | null = null;
  let preflightMs = 0;

  const log = (evt: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") =>
    emit({ ...base, evt, level, at: new Date(now()).toISOString(), elapsed_ms: now() - startedAt, ...fields });

  log("run.start", {
    force: opts.force === true,
    budget_ms: opts.budgetMs,
    preflight_refresh: opts.preflightRefresh,
  });

  return {
    runId,
    startedAt,
    elapsedMs: () => now() - startedAt,

    /** Times an awaited pre-flight phase and records whether it was skipped. */
    async phase<T>(phase: RunPhase, skipped: boolean, fn: () => Promise<T>, note?: string): Promise<T | undefined> {
      const t0 = now();
      if (skipped) {
        phases.push({ phase, ms: 0, skipped: true, note });
        log("preflight.skip", { phase, note });
        return undefined;
      }
      try {
        const out = await fn();
        const ms = now() - t0;
        phases.push({ phase, ms, skipped: false, note });
        preflightMs += ms;
        log("preflight.done", { phase, ms, budget_pct: pct(ms, opts.budgetMs) });
        return out;
      } catch (e) {
        const ms = now() - t0;
        phases.push({ phase, ms, skipped: false, note: "failed" });
        preflightMs += ms;
        log("preflight.error", { phase, ms, error: e instanceof Error ? e.message : String(e) }, "error");
        throw e;
      }
    },

    /** Records a phase measured by the caller (for inline try/catch blocks). */
    recordPhase(phase: RunPhase, ms: number, skipped = false, note?: string) {
      phases.push({ phase, ms, skipped, note });
      if (!skipped) preflightMs += ms;
      log(skipped ? "preflight.skip" : "preflight.done", {
        phase,
        ms,
        note,
        budget_pct: pct(ms, opts.budgetMs),
      });
    },

    /** Emitted once the DB rows are known, before any portfolio is touched. */
    recordSelection(sel: SelectionTelemetry) {
      selection = sel;
      log("selection.resolved", {
        scoped: sel.scoped,
        requested_count: sel.requested_count,
        matched: sel.matched,
        unknown_ids: sel.unknown_ids,
        paused_excluded: sel.paused_excluded,
        eligible_count: sel.eligible.length,
        preflight_ms: preflightMs,
        preflight_budget_pct: pct(preflightMs, opts.budgetMs),
      }, sel.unknown_ids.length > 0 ? "warn" : "info");
    },

    tickStart(id: string, mode: string) {
      log("tick.start", { portfolio_id: id, mode, budget_left_ms: opts.budgetMs - (now() - startedAt) });
      return now();
    },

    tickEnd(id: string, mode: string, t0: number, outcome: "ok" | "error", reason?: string) {
      const ms = now() - t0;
      ticks.push({ id, mode, ms, outcome, reason });
      log("tick.end", { portfolio_id: id, mode, ms, outcome, reason }, outcome === "error" ? "error" : "info");
    },

    tickSkipped(id: string, mode: string, reason: string) {
      ticks.push({ id, mode, ms: 0, outcome: "skipped", reason });
      log("tick.skip", {
        portfolio_id: id,
        mode,
        reason,
        elapsed_ms: now() - startedAt,
        budget_ms: opts.budgetMs,
      }, "warn");
    },

    snapshot(): RunTelemetrySnapshot {
      const duration = now() - startedAt;
      const overrun = Math.max(0, duration - opts.budgetMs);
      return {
        run_id: runId,
        triggered_by: opts.triggeredBy,
        force: opts.force === true,
        budget_ms: opts.budgetMs,
        preflight_refresh: opts.preflightRefresh,
        preflight_ms: preflightMs,
        preflight_budget_pct: pct(preflightMs, opts.budgetMs),
        phases: [...phases],
        selection,
        ticks: [...ticks],
        ticked: ticks.filter((t) => t.outcome === "ok").map((t) => t.id),
        skipped_budget: ticks.filter((t) => t.outcome === "skipped").map((t) => t.id),
        duration_ms: duration,
        deadline_exceeded: overrun > 0,
        overrun_ms: overrun,
      };
    },

    finish(extra: Record<string, unknown> = {}) {
      const snap = this.snapshot();
      log(
        "run.finish",
        {
          duration_ms: snap.duration_ms,
          budget_ms: snap.budget_ms,
          deadline_exceeded: snap.deadline_exceeded,
          overrun_ms: snap.overrun_ms,
          preflight_ms: snap.preflight_ms,
          preflight_budget_pct: snap.preflight_budget_pct,
          ticked: snap.ticked,
          skipped_budget: snap.skipped_budget,
          ...extra,
        },
        snap.deadline_exceeded ? "warn" : "info",
      );
      return snap;
    },

    failed(error: unknown) {
      const snap = this.snapshot();
      log(
        "run.failed",
        {
          duration_ms: snap.duration_ms,
          deadline_exceeded: snap.deadline_exceeded,
          preflight_ms: snap.preflight_ms,
          error: error instanceof Error ? error.message : String(error),
        },
        "error",
      );
      return snap;
    },
  };
}

export type RunTelemetry = ReturnType<typeof createRunTelemetry>;

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Derives the selection facts the run should log, from raw DB rows. */
export function describeSelection(
  requested: string[] | undefined,
  allRows: ReadonlyArray<{ id: string; mode: string; live_paused?: boolean | null }>,
): SelectionTelemetry {
  const req = (requested ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const known = new Set(allRows.map((r) => r.id));
  const matchedRows = req.length ? allRows.filter((r) => req.includes(r.id)) : [...allRows];
  const pausedRows = matchedRows.filter((r) => r.mode !== "paper" && r.live_paused);
  const pausedIds = new Set(pausedRows.map((r) => r.id));
  return {
    requested: req,
    requested_count: req.length,
    matched: matchedRows.map((r) => r.id),
    unknown_ids: req.filter((id) => !known.has(id)),
    paused_excluded: pausedRows.map((r) => r.id),
    eligible: matchedRows.filter((r) => !pausedIds.has(r.id)).map((r) => r.id),
    scoped: req.length > 0,
  };
}
