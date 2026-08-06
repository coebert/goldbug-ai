import { describe, expect, it } from "vitest";
import {
  buildSectorExposureSeries,
  dayRange,
  sectorLabel,
  type SectorExposureInput,
} from "../sector-exposure";

const phases = {
  "2026-01-01": { technology: "growing", energy: "shrinking", utilities: "stagnating" },
} as SectorExposureInput["phasesByDay"];

function prices(sym: string, days: string[], close: number) {
  return { [sym]: days.map((d) => ({ date: d, close })) };
}

describe("dayRange", () => {
  it("is inclusive and ordered", () => {
    expect(dayRange("2026-01-01", "2026-01-04")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("returns nothing for an inverted range", () => {
    expect(dayRange("2026-01-05", "2026-01-01")).toEqual([]);
  });
});

describe("buildSectorExposureSeries", () => {
  const days = dayRange("2026-01-01", "2026-01-03");

  it("buckets value by the sector phase of the day", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [{ symbol: "AAPL", side: "buy", quantity: 10, trade_date: "2026-01-01" }],
      prices: prices("AAPL", days, 100),
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    const last = out.points.at(-1)!;
    expect(last.growing).toBe(1000);
    expect(last.growingPct).toBe(1);
    expect(last.tilt).toBe(1);
  });

  it("splits growing vs shrinking and computes the net tilt", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 10, trade_date: "2026-01-01" },
        { symbol: "XOM", side: "buy", quantity: 10, trade_date: "2026-01-01" },
      ],
      prices: { ...prices("AAPL", days, 300), ...prices("XOM", days, 100) },
      sectorOf: { AAPL: "technology", XOM: "energy" },
      phasesByDay: phases,
    });
    const last = out.points.at(-1)!;
    expect(last.growingPct).toBeCloseTo(0.75, 6);
    expect(last.shrinkingPct).toBeCloseTo(0.25, 6);
    expect(last.tilt).toBeCloseTo(0.5, 6);
  });

  it("tracks position changes as trades land mid-window", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 10, trade_date: "2026-01-01" },
        { symbol: "XOM", side: "buy", quantity: 10, trade_date: "2026-01-03" },
      ],
      prices: { ...prices("AAPL", days, 100), ...prices("XOM", days, 100) },
      sectorOf: { AAPL: "technology", XOM: "energy" },
      phasesByDay: phases,
    });
    expect(out.points[0].tilt).toBe(1);
    expect(out.points[2].tilt).toBe(0);
    expect(out.tiltChange).toBe(-1);
  });

  it("removes exposure once a position is sold out", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 10, trade_date: "2026-01-01" },
        { symbol: "AAPL", side: "sell", quantity: 10, trade_date: "2026-01-02" },
      ],
      prices: prices("AAPL", days, 100),
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    expect(out.points[0].invested).toBe(1000);
    expect(out.points[1].invested).toBe(0);
    expect(out.points[1].tilt).toBe(0);
  });

  it("never goes short when sells exceed buys", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 5, trade_date: "2026-01-01" },
        { symbol: "AAPL", side: "sell", quantity: 50, trade_date: "2026-01-02" },
      ],
      prices: prices("AAPL", days, 100),
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    expect(out.points.every((p) => p.invested >= 0)).toBe(true);
    expect(out.points[2].invested).toBe(0);
  });

  it("carries positions opened before the window", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [{ symbol: "AAPL", side: "buy", quantity: 4, trade_date: "2025-12-20" }],
      prices: prices("AAPL", days, 50),
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    expect(out.points[0].invested).toBe(200);
  });

  it("falls back to the most recent earlier phase map", () => {
    const out = buildSectorExposureSeries({
      days: dayRange("2026-01-01", "2026-01-05"),
      trades: [{ symbol: "AAPL", side: "buy", quantity: 1, trade_date: "2026-01-01" }],
      prices: prices("AAPL", dayRange("2026-01-01", "2026-01-05"), 10),
      sectorOf: { AAPL: "technology" },
      phasesByDay: {
        "2026-01-01": { technology: "growing" },
        "2026-01-04": { technology: "shrinking" },
      },
    });
    expect(out.points[2].tilt).toBe(1); // 03 Jan still uses the 01 Jan map
    expect(out.points[4].tilt).toBe(-1); // 05 Jan uses the 04 Jan map
  });

  it("treats symbols with no sector as unclassified, not growing", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [{ symbol: "GLD", side: "buy", quantity: 2, trade_date: "2026-01-01" }],
      prices: prices("GLD", days, 100),
      sectorOf: { GLD: null },
      phasesByDay: phases,
    });
    const last = out.points.at(-1)!;
    expect(last.unclassifiedPct).toBe(1);
    expect(last.growingPct).toBe(0);
    expect(last.tilt).toBe(0);
  });

  it("skips days with no price and carries the last known close", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [{ symbol: "AAPL", side: "buy", quantity: 1, trade_date: "2026-01-01" }],
      prices: { AAPL: [{ date: "2026-01-01", close: 100 }] },
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    expect(out.points.map((p) => p.invested)).toEqual([100, 100, 100]);
  });

  it("reports latest sector breakdown sorted by value", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 1, trade_date: "2026-01-01" },
        { symbol: "XOM", side: "buy", quantity: 5, trade_date: "2026-01-01" },
      ],
      prices: { ...prices("AAPL", days, 100), ...prices("XOM", days, 100) },
      sectorOf: { AAPL: "technology", XOM: "energy" },
      phasesByDay: phases,
    });
    expect(out.latestBySector.map((s) => s.sector)).toEqual(["energy", "technology"]);
    expect(out.latestBySector[0].phase).toBe("shrinking");
    expect(out.latestBySector[0].pct).toBeCloseTo(5 / 6, 6);
  });

  it("percentages always sum to 1 when invested", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 3, trade_date: "2026-01-01" },
        { symbol: "XOM", side: "buy", quantity: 7, trade_date: "2026-01-01" },
        { symbol: "NEE", side: "buy", quantity: 4, trade_date: "2026-01-01" },
        { symbol: "GLD", side: "buy", quantity: 2, trade_date: "2026-01-01" },
      ],
      prices: {
        ...prices("AAPL", days, 100),
        ...prices("XOM", days, 100),
        ...prices("NEE", days, 100),
        ...prices("GLD", days, 100),
      },
      sectorOf: { AAPL: "technology", XOM: "energy", NEE: "utilities", GLD: null },
      phasesByDay: phases,
    });
    for (const p of out.points) {
      expect(p.growingPct + p.stagnatingPct + p.shrinkingPct + p.unclassifiedPct).toBeCloseTo(1, 9);
    }
  });

  it("returns an empty, safe result with no trades", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [],
      prices: {},
      sectorOf: {},
      phasesByDay: phases,
    });
    expect(out.averageTilt).toBe(0);
    expect(out.tiltChange).toBe(0);
    expect(out.latestBySector).toEqual([]);
    expect(out.points.every((p) => p.invested === 0)).toBe(true);
  });

  it("averages tilt only over days with exposure", () => {
    const out = buildSectorExposureSeries({
      days,
      trades: [{ symbol: "AAPL", side: "buy", quantity: 1, trade_date: "2026-01-03" }],
      prices: prices("AAPL", days, 100),
      sectorOf: { AAPL: "technology" },
      phasesByDay: phases,
    });
    expect(out.averageTilt).toBe(1);
  });

  it("labels sector keys for display", () => {
    expect(sectorLabel("consumer_discretionary")).toBe("Consumer Discretionary");
    expect(sectorLabel("unclassified")).toBe("Unclassified");
  });
});
