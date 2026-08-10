import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPECTANCY_GUARDRAILS,
  diffExpectancyTables,
  mergeExpectancyWindows,
  parseExpectancyTable,
  totalTrades,
  validateExpectancyTable,
  type ExpectancyWindow,
} from "../breakout-expectancy-refresh";
import type { BreakoutExpectancyTable } from "../alpha/breakout-regime-policy";

function win(label: string, weight: number, stats: ExpectancyWindow["stats"]): ExpectancyWindow {
  return { label, weight, from: "2024-01-01", to: "2026-08-01", stats };
}

const row = (cohort: string, regime: string, trades: number, expectancyPct: number, winRatePct = 50) => ({
  cohort,
  regime,
  trades,
  expectancyPct,
  winRatePct,
});

describe("mergeExpectancyWindows", () => {
  it("pools windows with recency weighting but keeps raw trade counts", () => {
    const table = mergeExpectancyWindows(
      [
        win("12m", 2, [row("confirmed", "bull", 50, 1.0, 55)]),
        win("36m", 1, [row("confirmed", "bull", 50, -2.0, 40)]),
      ],
      { source: "test", asOf: "2026-08-10" },
    );
    const cell = table.cells.confirmed!.bull!;
    // weights 2*50 vs 1*50 => (2*1 + 1*-2)/3 = 0
    expect(cell.expectancyPct).toBeCloseTo(0, 6);
    expect(cell.winRatePct).toBeCloseTo(50, 6);
    // trade counts are raw observations, never weighted
    expect(cell.trades).toBe(100);
    expect(table.asOf).toBe("2026-08-10");
  });

  it("collapses regime dialects onto the three buckets", () => {
    const table = mergeExpectancyWindows(
      [win("12m", 1, [row("pending", "bull_quiet", 10, 1), row("pending", "recovery", 30, 3)])],
      { source: "test" },
    );
    expect(table.cells.pending!.bull).toEqual({
      trades: 40,
      expectancyPct: 2.5,
      winRatePct: 50,
    });
  });

  it("ignores aggregate rows, zero-trade cells and zero-weight windows", () => {
    const table = mergeExpectancyWindows(
      [
        win("12m", 0, [row("confirmed", "bull", 100, 5)]),
        win("36m", 1, [
          row("all", "bull", 100, 5),
          row("confirmed", "all", 100, 5),
          row("confirmed", "bear", 0, 5),
          row("confirmed", "sideways", 12, -1),
        ]),
      ],
      { source: "test" },
    );
    expect(table.cells.confirmed?.bull).toBeUndefined();
    expect(table.cells.confirmed?.bear).toBeUndefined();
    expect(table.cells.confirmed!.sideways!.trades).toBe(12);
    expect(totalTrades(table)).toBe(12);
  });
});

describe("validateExpectancyTable", () => {
  const good: BreakoutExpectancyTable = {
    source: "candidate",
    asOf: "2026-08-10",
    cells: {
      confirmed: {
        bull: { trades: 120, expectancyPct: -0.4, winRatePct: 45 },
        sideways: { trades: 100, expectancyPct: -1.1, winRatePct: 42 },
      },
    },
  };

  it("accepts a candidate with enough pooled evidence", () => {
    const v = validateExpectancyTable(good);
    expect(v.ok).toBe(true);
    expect(v.totalTrades).toBe(220);
    expect(v.reasons).toEqual([]);
  });

  it("drops thin and implausible cells instead of publishing them", () => {
    const v = validateExpectancyTable({
      ...good,
      cells: {
        ...good.cells,
        pending: {
          bear: { trades: 3, expectancyPct: 1, winRatePct: 60 },
          bull: { trades: 40, expectancyPct: 900, winRatePct: 60 },
        },
      },
    });
    expect(v.table.cells.pending).toBeUndefined();
    expect(v.droppedCells).toHaveLength(2);
    expect(v.droppedCells.join(" ")).toContain("only 3 trades");
    expect(v.droppedCells.join(" ")).toContain("implausible");
    expect(v.ok).toBe(true); // the required cells survived
  });

  it("rejects a candidate that is too small or missing required cells", () => {
    const thin = validateExpectancyTable({
      source: "x",
      asOf: null,
      cells: { confirmed: { bull: { trades: 10, expectancyPct: 0.2, winRatePct: 50 } } },
    });
    expect(thin.ok).toBe(false);
    expect(thin.reasons.join(" ")).toContain("pooled trades");
    expect(thin.reasons.join(" ")).toContain("confirmed/sideways");
  });

  it("rejects non-finite stats", () => {
    const v = validateExpectancyTable({
      source: "x",
      asOf: null,
      cells: { confirmed: { bull: { trades: 500, expectancyPct: Number.NaN, winRatePct: 50 } } },
    });
    expect(v.table.cells.confirmed).toBeUndefined();
    expect(v.ok).toBe(false);
  });

  it("honours guardrail overrides", () => {
    const v = validateExpectancyTable(good, { minTotalTrades: 10_000 });
    expect(v.ok).toBe(false);
    expect(DEFAULT_EXPECTANCY_GUARDRAILS.minTotalTrades).toBeLessThan(10_000);
  });
});

describe("diffExpectancyTables", () => {
  const before: BreakoutExpectancyTable = {
    source: "old",
    asOf: null,
    cells: {
      confirmed: {
        bull: { trades: 60, expectancyPct: -0.35, winRatePct: 45 },
        sideways: { trades: 40, expectancyPct: -1.6, winRatePct: 42 },
      },
    },
  };

  it("reports sign flips, additions and removals", () => {
    const after: BreakoutExpectancyTable = {
      source: "new",
      asOf: null,
      cells: {
        confirmed: {
          bull: { trades: 90, expectancyPct: 0.8, winRatePct: 52 },
          bear: { trades: 30, expectancyPct: 1.1, winRatePct: 55 },
        },
      },
    };
    const d = diffExpectancyTables(before, after);
    expect(d.signFlips.map((c) => `${c.cohort}/${c.bucket}`)).toEqual(["confirmed/bull"]);
    expect(d.added).toEqual(["confirmed/bear"]);
    expect(d.removed).toEqual(["confirmed/sideways"]);
    expect(d.changed.find((c) => c.bucket === "bull")!.deltaExpectancyPct).toBeCloseTo(1.15, 6);
    expect(d.summary).toContain("sign flip");
  });

  it("says nothing changed when the tables match", () => {
    expect(diffExpectancyTables(before, before).summary).toBe("no change");
  });
});

describe("parseExpectancyTable", () => {
  it("round-trips a stored grid", () => {
    const merged = mergeExpectancyWindows(
      [win("12m", 1, [row("confirmed", "bull", 30, -0.5, 44)])],
      { source: "stored", asOf: "2026-08-10" },
    );
    const parsed = parseExpectancyTable(JSON.parse(JSON.stringify(merged)));
    expect(parsed).toEqual(merged);
  });

  it("returns null for junk and skips malformed cells", () => {
    expect(parseExpectancyTable(null)).toBeNull();
    expect(parseExpectancyTable({ cells: {} })).toBeNull();
    expect(
      parseExpectancyTable({
        cells: { confirmed: { bull: { trades: "x", expectancyPct: 1, winRatePct: 2 } } },
      }),
    ).toBeNull();
  });
});
