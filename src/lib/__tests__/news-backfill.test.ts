import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  backfillFetchedAt,
  backfillProgress,
  clampBackfillDays,
  daysBetween,
  describeBackfillStatus,
  hostFromUrl,
  newCatalogueSources,
  nextBackfillDate,
  planBackfillWindow,
  seenDateToISODay,
  MIN_BACKFILL_DAYS,
  MAX_BACKFILL_DAYS,
} from "../news-backfill";

describe("clampBackfillDays", () => {
  it("clamps to the supported 30–90 day range", () => {
    expect(clampBackfillDays(5)).toBe(MIN_BACKFILL_DAYS);
    expect(clampBackfillDays(45)).toBe(45);
    expect(clampBackfillDays(365)).toBe(MAX_BACKFILL_DAYS);
    expect(clampBackfillDays("nonsense")).toBe(MIN_BACKFILL_DAYS);
    expect(clampBackfillDays(undefined)).toBe(MIN_BACKFILL_DAYS);
  });
});

describe("planBackfillWindow", () => {
  it("ends at yesterday so it never fights the live refresh over today", () => {
    const w = planBackfillWindow("2026-07-30", 30);
    expect(w.end_date).toBe("2026-07-29");
    expect(w.start_date).toBe("2026-06-30");
    expect(w.days_total).toBe(30);
    expect(daysBetween(w.start_date, w.end_date)).toBe(29);
  });

  it("supports the full 90-day lookback", () => {
    const w = planBackfillWindow("2026-07-30", 90);
    expect(w.days_total).toBe(90);
    expect(daysBetween(w.start_date, w.end_date)).toBe(89);
  });

  it("crosses month and year boundaries correctly", () => {
    const w = planBackfillWindow("2026-01-15", 30);
    expect(w.end_date).toBe("2026-01-14");
    expect(w.start_date).toBe("2025-12-16");
  });
});

describe("nextBackfillDate", () => {
  it("walks newest → oldest and stops at the window start", () => {
    expect(nextBackfillDate("2026-07-29", "2026-06-30")).toBe("2026-07-29");
    expect(nextBackfillDate("2026-06-30", "2026-06-30")).toBe("2026-06-30");
    expect(nextBackfillDate(addDaysISO("2026-06-30", -1), "2026-06-30")).toBeNull();
    expect(nextBackfillDate(null, "2026-06-30")).toBeNull();
  });
});

describe("backfillProgress", () => {
  const base = {
    status: "running",
    start_date: "2026-06-30",
    end_date: "2026-07-29",
    cursor_date: "2026-07-29",
    days_total: 30,
    days_done: 0,
    headlines_inserted: 0,
  };

  it("reports 0% at the start and 100% when completed", () => {
    expect(backfillProgress(base).pct).toBe(0);
    expect(backfillProgress({ ...base, status: "completed", cursor_date: null }).pct).toBe(100);
  });

  it("tracks the cursor as it moves back through the window", () => {
    const mid = backfillProgress({ ...base, cursor_date: "2026-07-14", days_done: 15 });
    expect(mid.remaining_days).toBe(15);
    expect(mid.pct).toBe(50);
  });

  it("never exceeds 100% or reports negative work left", () => {
    const p = backfillProgress({ ...base, days_done: 999, cursor_date: null });
    expect(p.pct).toBeLessThanOrEqual(100);
    expect(p.remaining_days).toBe(0);
  });
});

describe("newCatalogueSources", () => {
  const sources = [
    { id: "reuters", url: "https://feeds.reuters.com/Reuters/worldNews", label: "Reuters" },
    { id: "nikkei", url: "https://www.nikkei.com/rss/index.xml", label: "Nikkei" },
    { id: "nikkei-biz", url: "https://nikkei.com/rss/biz.xml", label: "Nikkei Biz" },
    { id: "broken", url: "not a url", label: "Broken" },
  ];

  it("returns only feeds whose publisher has no history in the cache", () => {
    const fresh = newCatalogueSources(sources, ["feeds.reuters.com"]);
    expect(fresh.map((s) => s.id)).toEqual(["nikkei", "broken"].filter((id) => id !== "broken"));
  });

  it("ignores www. prefixes and casing when matching known domains", () => {
    expect(newCatalogueSources(sources, ["WWW.Nikkei.com", "feeds.reuters.com"])).toHaveLength(0);
  });

  it("deduplicates feeds that share one publisher domain", () => {
    const fresh = newCatalogueSources(sources, []);
    expect(fresh.map((s) => s.id)).toEqual(["reuters", "nikkei"]);
  });
});

describe("seenDateToISODay", () => {
  it("parses GDELT seendate stamps", () => {
    expect(seenDateToISODay("20260701T120000Z")).toBe("2026-07-01");
    expect(seenDateToISODay("20260701")).toBe("2026-07-01");
  });

  it("returns null for junk", () => {
    expect(seenDateToISODay(null)).toBeNull();
    expect(seenDateToISODay("")).toBeNull();
    expect(seenDateToISODay("yesterday")).toBeNull();
  });
});

describe("backfillFetchedAt", () => {
  it("stamps history on its own day so the reel stays newest-first", () => {
    const stamp = backfillFetchedAt("2026-06-15");
    expect(stamp).toBe("2026-06-15T12:00:00.000Z");
    expect(Date.parse(stamp)).toBeLessThan(Date.parse("2026-07-30T00:00:00Z"));
  });

  it("orders older backfilled days below newer ones", () => {
    expect(Date.parse(backfillFetchedAt("2026-06-01"))).toBeLessThan(
      Date.parse(backfillFetchedAt("2026-06-02")),
    );
  });
});

describe("hostFromUrl / describeBackfillStatus", () => {
  it("normalises hosts", () => {
    expect(hostFromUrl("https://www.BBC.co.uk/news/rss.xml")).toBe("bbc.co.uk");
    expect(hostFromUrl("garbage")).toBeNull();
    expect(hostFromUrl(null)).toBeNull();
  });

  it("describes each job state in plain English", () => {
    expect(describeBackfillStatus(null)).toMatch(/No backfill/);
    const job = {
      status: "running",
      start_date: "2026-06-30",
      end_date: "2026-07-29",
      cursor_date: "2026-07-14",
      days_total: 30,
      days_done: 15,
      headlines_inserted: 120,
    };
    expect(describeBackfillStatus(job)).toMatch(/50% done/);
    expect(describeBackfillStatus({ ...job, status: "completed" })).toMatch(/complete/);
    expect(describeBackfillStatus({ ...job, status: "failed" })).toMatch(/resume/);
  });
});
