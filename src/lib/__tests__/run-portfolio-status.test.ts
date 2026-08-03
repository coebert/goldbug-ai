import { describe, expect, it } from "vitest";
import {
  buildPortfolioRunStatuses,
  classifyRunResult,
  formatRelativeTime,
  summarizeRunStatuses,
  type RunPortfolioRef,
  type RunResultRow,
} from "@/lib/run-portfolio-status";

const PORTFOLIOS: RunPortfolioRef[] = [
  { id: "real", name: "Real Money", mode: "live_prod" },
  { id: "high", name: "High Risk Sim", mode: "live_sim" },
  { id: "bal", name: "Balanced Sim", mode: "live_sim" },
  { id: "paused", name: "Paused Sim", mode: "live_sim", live_paused: true },
];

describe("classifyRunResult", () => {
  const base: RunResultRow = { id: "x", mode: "live_sim", ok: true };

  it("maps a clean result to ticked", () => {
    expect(classifyRunResult({ ...base, value: 10 })).toBe("ticked");
  });
  it("maps failures to error", () => {
    expect(classifyRunResult({ ...base, ok: false, error: "boom" })).toBe("error");
  });
  it("recognises the recent-decision skip", () => {
    expect(
      classifyRunResult({ ...base, skipped: "already ticked at 2026-08-03T13:00:00Z — pass force:true" }),
    ).toBe("skipped_recent");
  });
  it("recognises the budget skip", () => {
    expect(classifyRunResult({ ...base, skipped: "budget-exceeded (elapsed 52s)" })).toBe(
      "skipped_budget",
    );
  });
  it("recognises the market-hours skip", () => {
    expect(classifyRunResult({ ...base, skipped: "all venues closed — AI tick skipped" })).toBe(
      "skipped_closed",
    );
  });
});

describe("buildPortfolioRunStatuses", () => {
  it("marks unselected portfolios as untouched in a scoped run", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["high"],
      results: [{ id: "high", mode: "live_sim", ok: true, value: 12345 }],
      previousRunAt: { high: "2026-08-03T10:00:00.000Z" },
      lastRunAt: { high: "2026-08-03T13:05:00.000Z" },
    });

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.high.status).toBe("ticked");
    expect(byId.high.ticked).toBe(true);
    expect(byId.high.lastRunAt).toBe("2026-08-03T13:05:00.000Z");
    expect(byId.high.previousRunAt).toBe("2026-08-03T10:00:00.000Z");
    expect(byId.real.status).toBe("not_selected");
    expect(byId.bal.status).toBe("not_selected");
    expect(byId.real.selected).toBe(false);
  });

  it("shows the already-ticked reason on a repeated scoped run", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["high", "bal"],
      results: [
        { id: "high", mode: "live_sim", ok: true, skipped: "already ticked at 2026-08-03T13:05:00Z" },
        { id: "bal", mode: "live_sim", ok: true, skipped: "already ticked at 2026-08-03T13:05:10Z" },
      ],
      lastRunAt: { high: "2026-08-03T13:05:00.000Z", bal: "2026-08-03T13:05:10.000Z" },
    });

    expect(rows.filter((r) => r.status === "skipped_recent")).toHaveLength(2);
    expect(rows.every((r) => !r.ticked)).toBe(true);
    expect(rows.find((r) => r.id === "real")?.status).toBe("not_selected");
  });

  it("flags paused live portfolios the run never reached", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["paused", "high"],
      results: [{ id: "high", mode: "live_sim", ok: true }],
    });
    expect(rows.find((r) => r.id === "paused")?.status).toBe("paused");
  });

  it("treats an unscoped run as all-selected", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: [],
      results: [{ id: "real", mode: "live_prod", ok: false, error: "broker down" }],
    });
    expect(rows.every((r) => r.selected)).toBe(true);
    expect(rows[0].status).toBe("error");
    expect(rows[0].detail).toBe("broker down");
  });

  it("carries per-portfolio duration and value", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      results: [{ id: "bal", mode: "live_sim", ok: true, value: 987.6, duration_ms: 28_400 }],
    });
    const bal = rows.find((r) => r.id === "bal")!;
    expect(bal.durationMs).toBe(28_400);
    expect(bal.value).toBeCloseTo(987.6);
  });

  it("orders failures and ticks above untouched rows", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["real", "high"],
      results: [
        { id: "high", mode: "live_sim", ok: true },
        { id: "real", mode: "live_prod", ok: false, error: "x" },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["real", "high", "bal", "paused"]);
  });

  it("falls back to the previous timestamp when nothing newer exists", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["high"],
      results: [{ id: "high", mode: "live_sim", ok: true, skipped: "already ticked at ..." }],
      previousRunAt: { real: "2026-08-03T09:00:00.000Z" },
    });
    expect(rows.find((r) => r.id === "real")?.lastRunAt).toBe("2026-08-03T09:00:00.000Z");
  });
});

describe("summarizeRunStatuses / formatRelativeTime", () => {
  it("counts the outcome buckets", () => {
    const rows = buildPortfolioRunStatuses({
      portfolios: PORTFOLIOS,
      requestedIds: ["high", "bal", "paused"],
      results: [
        { id: "high", mode: "live_sim", ok: true },
        { id: "bal", mode: "live_sim", ok: true, skipped: "budget-exceeded (elapsed 54s)" },
      ],
    });
    const s = summarizeRunStatuses(rows);
    expect(s).toMatchObject({ total: 4, ticked: 1, skipped: 1, untouched: 1, paused: 1, failed: 0 });
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 7, 3, 13, 0, 0);
    expect(formatRelativeTime(null, now)).toBe("never");
    expect(formatRelativeTime(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
    expect(formatRelativeTime(new Date(now - 50 * 3_600_000).toISOString(), now)).toBe("2d ago");
  });
});
