import { describe, expect, it } from "vitest";
import {
  formatGlobalEventBlock,
  measureGlobalEvent,
  studyGlobalEvents,
  summariseByCategory,
} from "../global-event-study";
import { GLOBAL_EVENTS, type GlobalEvent } from "../global-events";
import type { IndexBar } from "../macro-history";

function bars(from: string, count: number, fn: (i: number) => number): IndexBar[] {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    close: fn(i),
  }));
}

const CRASH: GlobalEvent = {
  id: "crash",
  label: "Test crash",
  short: "TC",
  start: "2000-02-01",
  end: "2000-02-20",
  category: "crisis",
  severity: 3,
  note: "",
};

describe("measureGlobalEvent", () => {
  it("measures the fall inside the window and the recovery afterwards", () => {
    // Flat at 100 for 40 days, -30% over the window, then recovers to 110.
    const series = bars("2000-01-01", 400, (i) => {
      if (i < 31) return 100;
      if (i <= 50) return 100 - (i - 30) * 1.5;
      return Math.min(110, 70 + (i - 50) * 0.5);
    });
    const m = measureGlobalEvent(CRASH, series);
    expect(m.covered).toBe(true);
    expect(m.drawdown_pct).toBeGreaterThan(25);
    expect(m.window_pct).toBeLessThan(0);
    expect(m.recovery_days).toBeGreaterThan(0);
    expect(m.fwd_60d).toBeGreaterThan(0);
  });

  it("reports uncovered when the series does not reach the event", () => {
    const series = bars("2010-01-01", 100, () => 100);
    expect(measureGlobalEvent(CRASH, series).covered).toBe(false);
  });

  it("snaps a single-day event that lands outside trading days", () => {
    const series = bars("2000-01-01", 200, (i) => 100 + i);
    const holiday: GlobalEvent = { ...CRASH, start: "2000-03-01", end: "2000-03-01" };
    expect(measureGlobalEvent(holiday, series).covered).toBe(true);
  });
});

describe("summariseByCategory", () => {
  it("marks a category with strong positive forward returns as buy_the_dip", () => {
    const series = bars("2000-01-01", 500, (i) => (i <= 50 ? 100 - i * 0.4 : 80 + (i - 50) * 0.3));
    const cats = summariseByCategory([measureGlobalEvent(CRASH, series)]);
    expect(cats).toHaveLength(1);
    expect(cats[0]!.category).toBe("crisis");
    expect(cats[0]!.stance).toBe("buy_the_dip");
    expect(cats[0]!.note).toContain("crisis");
  });

  it("ignores uncovered events", () => {
    const series = bars("2010-01-01", 100, () => 100);
    expect(summariseByCategory([measureGlobalEvent(CRASH, series)])).toEqual([]);
  });
});

describe("studyGlobalEvents", () => {
  it("walks the whole curated reel and reports coverage", () => {
    const series = bars("1990-01-01", 13000, (i) => 100 * Math.exp(i / 6000));
    const study = studyGlobalEvents(series);
    expect(study.events_total).toBe(GLOBAL_EVENTS.length);
    expect(study.measurements).toHaveLength(GLOBAL_EVENTS.length);
    expect(study.events_measured).toBeGreaterThan(15);
    expect(study.categories.length).toBeGreaterThan(3);
    const block = formatGlobalEventBlock(study);
    expect(block).toContain("GLOBAL EVENT REEL");
    expect(block).toContain("severity 3");
  });

  it("returns an empty prompt block with no data", () => {
    expect(formatGlobalEventBlock(studyGlobalEvents([]))).toBe("");
  });
});
