import { describe, expect, it } from "vitest";
import {
  explainPortfolioSchedule,
  isLondonWeekend,
  londonDayKey,
  summariseJobRuns,
  summariseTickActivity,
  type SchedulerJobRunRow,
} from "@/lib/scheduler-status";

const SAT = "2026-08-08T12:00:00.000Z"; // Saturday
const SUN = "2026-08-09T12:00:00.000Z";
const MON = "2026-08-10T12:00:00.000Z";

describe("london calendar helpers", () => {
  it("detects weekends in London time", () => {
    expect(isLondonWeekend(SAT)).toBe(true);
    expect(isLondonWeekend(SUN)).toBe(true);
    expect(isLondonWeekend(MON)).toBe(false);
  });
  it("uses London day boundaries, not UTC", () => {
    // 23:30 UTC on Friday in BST is already Saturday in London
    expect(londonDayKey("2026-08-07T23:30:00.000Z")).toBe("2026-08-08");
    expect(isLondonWeekend("2026-08-07T23:30:00.000Z")).toBe(true);
  });
});

function run(over: Partial<SchedulerJobRunRow>): SchedulerJobRunRow {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: MON,
    triggered_by: "cron",
    success: true,
    duration_ms: 1000,
    ...over,
  };
}

describe("summariseJobRuns", () => {
  it("splits runs, failures and durations by weekend vs weekday", () => {
    const [cron] = summariseJobRuns([
      run({ created_at: MON, duration_ms: 1000 }),
      run({ created_at: SAT, duration_ms: 3000 }),
      run({ created_at: SUN, success: false, error: "boom", duration_ms: 2000 }),
    ]);
    expect(cron.job).toBe("cron");
    expect(cron.runs).toBe(3);
    expect(cron.weekendRuns).toBe(2);
    expect(cron.weekdayRuns).toBe(1);
    expect(cron.failures).toBe(1);
    expect(cron.weekendFailures).toBe(1);
    expect(cron.avgDurationMs).toBe(2000);
    expect(cron.lastRunAt).toBe(SUN);
    expect(cron.lastWeekendRunAt).toBe(SUN);
  });

  it("aggregates skipped phases with their last note", () => {
    const [cron] = summariseJobRuns([
      run({
        created_at: SAT,
        phases: [
          { phase: "prices", ms: 0, skipped: true, note: "all venues closed" },
          { phase: "news", ms: 200, skipped: false },
        ],
      }),
      run({
        created_at: MON,
        phases: [{ phase: "prices", ms: 0, skipped: true, note: "preflight disabled" }],
      }),
    ]);
    expect(cron.skippedPhases).toEqual([
      { phase: "prices", weekend: 1, weekday: 1, lastNote: "preflight disabled" },
    ]);
  });

  it("groups distinct jobs and sorts by volume", () => {
    const out = summariseJobRuns([
      run({ triggered_by: "manual" }),
      run({ triggered_by: "cron" }),
      run({ triggered_by: "cron" }),
    ]);
    expect(out.map((j) => j.job)).toEqual(["cron", "manual"]);
  });

  it("sums budget-exceeded portfolio skips", () => {
    const [cron] = summariseJobRuns([
      run({ budget_exceeded_count: 2 }),
      run({ budget_exceeded_count: 1 }),
    ]);
    expect(cron.portfoliosSkippedBudget).toBe(3);
  });

  it("reports no weekend run when only weekdays are present", () => {
    const [cron] = summariseJobRuns([run({ created_at: MON })]);
    expect(cron.lastWeekendRunAt).toBeNull();
  });
});

describe("explainPortfolioSchedule", () => {
  const closedEquities = [
    { symbol: "AAPL", venue: "NASDAQ", isOpen: false, phase: "weekend" },
    { symbol: "VOD.L", venue: "LSE", isOpen: false, phase: "weekend" },
  ];

  it("skips a portfolio whose venues are all closed", () => {
    const v = explainPortfolioSchedule({ symbols: closedEquities });
    expect(v.willTick).toBe(false);
    expect(v.outcome).toBe("all_venues_closed");
    expect(v.closedVenues).toEqual(["LSE", "NASDAQ"]);
    expect(v.reason).toContain("LSE, NASDAQ");
  });

  it("still ticks when crypto is in the universe", () => {
    const v = explainPortfolioSchedule({
      symbols: [...closedEquities, { symbol: "BTC-USD", venue: "CRYPTO", isOpen: true, phase: "always_open" }],
    });
    expect(v.willTick).toBe(true);
    expect(v.outcome).toBe("would_tick");
    expect(v.openVenues).toEqual(["CRYPTO"]);
    expect(v.openSymbols).toBe(1);
    expect(v.closedSymbols).toBe(2);
  });

  it("paused beats market hours", () => {
    const v = explainPortfolioSchedule({
      symbols: [{ symbol: "BTC-USD", venue: "CRYPTO", isOpen: true, phase: "always_open" }],
      paused: true,
    });
    expect(v.outcome).toBe("paused");
    expect(v.willTick).toBe(false);
  });

  it("flags an empty universe distinctly", () => {
    expect(explainPortfolioSchedule({ symbols: [] }).outcome).toBe("no_universe");
  });
});

describe("summariseTickActivity", () => {
  it("buckets decisions into weekend and weekday", () => {
    const a = summariseTickActivity([MON, SAT, SUN, "2026-08-09T15:00:00.000Z"]);
    expect(a.total).toBe(4);
    expect(a.weekend).toBe(3);
    expect(a.weekday).toBe(1);
    expect(a.lastTickAt).toBe(MON);
    expect(a.lastWeekendTickAt).toBe("2026-08-09T15:00:00.000Z");
    expect(a.weekendDays).toEqual(["2026-08-08", "2026-08-09"]);
  });

  it("handles a portfolio that never ticked", () => {
    expect(summariseTickActivity([])).toMatchObject({
      total: 0,
      lastTickAt: null,
      lastWeekendTickAt: null,
      weekendDays: [],
    });
  });
});
