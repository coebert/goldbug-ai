// Pure logic for the scheduler status panel.
//
// Answers two questions without touching a database:
//   1. Which scheduled jobs actually ran (and which phases they skipped),
//      split by London weekend vs weekday.
//   2. For each portfolio + its universe, would a run tick right now — and if
//      not, why (paused, or every venue in the universe is closed)?
//
// Everything here is deterministic so it can be unit tested.

export type SchedulerPhaseRow = {
  phase: string;
  ms: number;
  skipped?: boolean;
  note?: string | null;
};

export type SchedulerJobRunRow = {
  id: string;
  created_at: string;
  triggered_by: string;
  success: boolean;
  error?: string | null;
  duration_ms?: number | null;
  portfolios_total?: number | null;
  portfolios_ok?: number | null;
  portfolios_error?: number | null;
  budget_exceeded_count?: number | null;
  phases?: SchedulerPhaseRow[] | null;
};

const LONDON_WEEKDAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
});

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toDate(v: string | number | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** True when the instant falls on a Saturday or Sunday in London. */
export function isLondonWeekend(v: string | number | Date): boolean {
  const wd = LONDON_WEEKDAY.format(toDate(v));
  return wd === "Sat" || wd === "Sun";
}

/** `YYYY-MM-DD` for the London calendar day of the instant. */
export function londonDayKey(v: string | number | Date): string {
  return LONDON_DAY.format(toDate(v));
}

export type SkippedPhaseSummary = {
  phase: string;
  weekend: number;
  weekday: number;
  /** Most recent skip note seen for this phase, if the run recorded one. */
  lastNote: string | null;
};

export type JobSummary = {
  job: string;
  runs: number;
  weekendRuns: number;
  weekdayRuns: number;
  failures: number;
  weekendFailures: number;
  lastRunAt: string | null;
  lastWeekendRunAt: string | null;
  avgDurationMs: number | null;
  portfoliosSkippedBudget: number;
  skippedPhases: SkippedPhaseSummary[];
};

/** Groups run rows by job name with weekend/weekday splits and phase skips. */
export function summariseJobRuns(rows: readonly SchedulerJobRunRow[]): JobSummary[] {
  const byJob = new Map<string, JobSummary>();
  const durations = new Map<string, number[]>();
  const phases = new Map<string, Map<string, SkippedPhaseSummary>>();

  const sorted = [...rows].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );

  for (const r of sorted) {
    const job = r.triggered_by || "unknown";
    let s = byJob.get(job);
    if (!s) {
      s = {
        job,
        runs: 0,
        weekendRuns: 0,
        weekdayRuns: 0,
        failures: 0,
        weekendFailures: 0,
        lastRunAt: null,
        lastWeekendRunAt: null,
        avgDurationMs: null,
        portfoliosSkippedBudget: 0,
        skippedPhases: [],
      };
      byJob.set(job, s);
      durations.set(job, []);
      phases.set(job, new Map());
    }
    const weekend = isLondonWeekend(r.created_at);
    s.runs += 1;
    if (weekend) s.weekendRuns += 1;
    else s.weekdayRuns += 1;
    if (!r.success) {
      s.failures += 1;
      if (weekend) s.weekendFailures += 1;
    }
    s.lastRunAt = r.created_at;
    if (weekend) s.lastWeekendRunAt = r.created_at;
    s.portfoliosSkippedBudget += r.budget_exceeded_count ?? 0;
    if (typeof r.duration_ms === "number") durations.get(job)!.push(r.duration_ms);

    for (const p of r.phases ?? []) {
      if (!p?.skipped) continue;
      const m = phases.get(job)!;
      const entry = m.get(p.phase) ?? {
        phase: p.phase,
        weekend: 0,
        weekday: 0,
        lastNote: null,
      };
      if (weekend) entry.weekend += 1;
      else entry.weekday += 1;
      if (p.note) entry.lastNote = p.note;
      m.set(p.phase, entry);
    }
  }

  for (const [job, s] of byJob) {
    const d = durations.get(job)!;
    s.avgDurationMs = d.length
      ? Math.round(d.reduce((a, b) => a + b, 0) / d.length)
      : null;
    s.skippedPhases = [...phases.get(job)!.values()].sort(
      (a, b) => b.weekend + b.weekday - (a.weekend + a.weekday),
    );
  }

  return [...byJob.values()].sort((a, b) => b.runs - a.runs);
}

export type UniverseSymbolStatus = {
  symbol: string;
  venue: string;
  isOpen: boolean;
  phase: string;
};

export type PortfolioScheduleVerdict = {
  willTick: boolean;
  /** Machine-readable outcome for badges/tests. */
  outcome: "would_tick" | "paused" | "all_venues_closed" | "no_universe";
  reason: string;
  openVenues: string[];
  closedVenues: string[];
  openSymbols: number;
  closedSymbols: number;
};

/**
 * Mirrors the hourly-run market-hours gate: a portfolio is skipped when every
 * symbol in its universe sits on a closed venue (crypto/FX never close, so a
 * portfolio holding either still ticks at the weekend).
 */
export function explainPortfolioSchedule(args: {
  symbols: readonly UniverseSymbolStatus[];
  paused?: boolean;
}): PortfolioScheduleVerdict {
  const open = args.symbols.filter((s) => s.isOpen);
  const closed = args.symbols.filter((s) => !s.isOpen);
  const openVenues = [...new Set(open.map((s) => s.venue))].sort();
  const closedVenues = [...new Set(closed.map((s) => s.venue))].sort();
  const base = {
    openVenues,
    closedVenues,
    openSymbols: open.length,
    closedSymbols: closed.length,
  };

  if (args.paused) {
    return {
      ...base,
      willTick: false,
      outcome: "paused",
      reason: "Live trading is paused for this portfolio — the run drops it before the tick loop.",
    };
  }
  if (args.symbols.length === 0) {
    return {
      ...base,
      willTick: false,
      outcome: "no_universe",
      reason: "No tradeable symbols resolved from this portfolio's universe.",
    };
  }
  if (open.length === 0) {
    return {
      ...base,
      willTick: false,
      outcome: "all_venues_closed",
      reason: `All venues closed (${closedVenues.join(", ")}) — the AI tick is skipped to save credits.`,
    };
  }
  return {
    ...base,
    willTick: true,
    outcome: "would_tick",
    reason: `${open.length} symbol${open.length === 1 ? "" : "s"} open on ${openVenues.join(", ")}.`,
  };
}

export type TickActivity = {
  total: number;
  weekend: number;
  weekday: number;
  lastTickAt: string | null;
  lastWeekendTickAt: string | null;
  /** Distinct London weekend days on which at least one tick happened. */
  weekendDays: string[];
};

/** Buckets decision timestamps into weekend vs weekday activity. */
export function summariseTickActivity(timestamps: readonly string[]): TickActivity {
  const sorted = [...timestamps].sort((a, b) => Date.parse(a) - Date.parse(b));
  const out: TickActivity = {
    total: sorted.length,
    weekend: 0,
    weekday: 0,
    lastTickAt: null,
    lastWeekendTickAt: null,
    weekendDays: [],
  };
  const days = new Set<string>();
  for (const t of sorted) {
    if (isLondonWeekend(t)) {
      out.weekend += 1;
      out.lastWeekendTickAt = t;
      days.add(londonDayKey(t));
    } else {
      out.weekday += 1;
    }
    out.lastTickAt = t;
  }
  out.weekendDays = [...days].sort();
  return out;
}
