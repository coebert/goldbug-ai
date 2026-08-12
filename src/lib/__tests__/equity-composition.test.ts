import { describe, it, expect } from "vitest";
import {
  ROW_GAP,
  ROW_INTERPOLATED,
  buildEquityComposition,
  fillCompositionGaps,
  validateComposition,
} from "@/lib/equity-composition";
describe("composition", () => {
  it("stacks to total", () => {
    const r = buildEquityComposition({
      snapshots: [
        { snapshot_date: "2026-01-02", cash: 500, holdings_value: 500, total_value: 1000 },
        { snapshot_date: "2026-01-03", cash: 400, holdings_value: 700, total_value: 1100 },
      ],
      trades: [{ trade_date: "2026-01-02", symbol: "A:xnas", side: "buy", quantity: 10 }],
      prices: { "A:xnas": [{ date: "2026-01-02", close: 50 }, { date: "2026-01-03", close: 70 }] },
    });
    expect(r.symbols).toEqual(["A:xnas"]);
    expect(r.rows[1]).toMatchObject({ cash: 400, "A:xnas": 700, total: 1100 });
  });
});

describe("validateComposition", () => {
  const keys = ["cash", "AAA", "BBB"];

  it("passes when bands sum to the stored total", () => {
    const rows = [{ date: "2026-01-01", cash: 100, AAA: 50, BBB: 25, total: 175 }];
    expect(validateComposition(rows, keys)).toEqual([]);
  });

  it("tolerates float noise", () => {
    const rows = [{ date: "2026-01-01", cash: 0.1, AAA: 0.2, BBB: 0, total: 0.3 }];
    expect(validateComposition(rows, keys)).toEqual([]);
  });

  it("flags rows whose bands miss the stored total", () => {
    const rows = [
      { date: "2026-01-01", cash: 100, AAA: 50, BBB: 25, total: 175 },
      { date: "2026-01-02", cash: 100, AAA: 40, BBB: 25, total: 175 },
    ];
    const bad = validateComposition(rows, keys);
    expect(bad).toHaveLength(1);
    expect(bad[0].date).toBe("2026-01-02");
    expect(bad[0].diff).toBeCloseTo(-10);
  });
});

describe("fillCompositionGaps", () => {
  const keys = ["cash", "total"];

  it("interpolates short gaps and flags them", () => {
    const { rows, gaps } = fillCompositionGaps(
      [
        { date: "2026-01-05", cash: 100, total: 200 },
        { date: "2026-01-07", cash: 200, total: 400 },
      ],
      keys,
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    expect(rows[1].total).toBeCloseTo(300);
    expect(rows[1][ROW_INTERPOLATED]).toBe(1);
    expect(gaps).toEqual([
      { from: "2026-01-05", to: "2026-01-07", missingDays: 1, interpolated: true },
    ]);
  });

  it("ignores weekends", () => {
    // 2026-01-09 is a Friday, 2026-01-12 the following Monday.
    const { rows, gaps } = fillCompositionGaps(
      [
        { date: "2026-01-09", cash: 1, total: 1 },
        { date: "2026-01-12", cash: 2, total: 2 },
      ],
      keys,
    );
    expect(rows).toHaveLength(2);
    expect(gaps).toEqual([]);
  });

  it("leaves long gaps blank rather than inventing data", () => {
    const { rows, gaps } = fillCompositionGaps(
      [
        { date: "2026-01-05", cash: 100, total: 200 },
        { date: "2026-01-16", cash: 200, total: 400 },
      ],
      keys,
      3,
    );
    const blanks = rows.filter((r) => r[ROW_GAP]);
    expect(blanks.length).toBe(8);
    expect(blanks[0].total).toBeNull();
    expect(gaps[0].interpolated).toBe(false);
    expect(validateComposition(rows, ["cash"])).toHaveLength(rows.length - blanks.length);
  });
});
