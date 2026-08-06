import { describe, it, expect } from "vitest";
import {
  armKey,
  cellRoundTripBps,
  DEFAULT_ROBUSTNESS_WEIGHTS,
  formatRobustnessTable,
  gradeFor,
  gridWidth,
  groupCells,
  median,
  rankRobustness,
  robustnessTableRows,
  ROBUSTNESS_COLUMNS,
  scoreArm,
  slope,
  squash,
  summariseRobustness,
} from "../robustness-score";
import { buildCostGrid, type SweepCell, type TicketSpec } from "../cost-sweep";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKET: TicketSpec = { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 };
const SMALL: TicketSpec = { label: "12 x 7%", maxNames: 12, perNameWeight: 0.07 };

const scenarios = buildCostGrid(BASE, { scales: [0, 0.5, 1] });

function cell(over: Partial<SweepCell> & { scale?: number }): SweepCell {
  const sc = scenarios.find((s) => s.scale === (over.scale ?? 1))!;
  return {
    ticket: TICKET,
    scenario: sc,
    style: "swing",
    riskLevel: "balanced",
    totalReturnPct: 10,
    benchmarkReturnPct: 5,
    trades: 40,
    feeDragPct: 1,
    sharpe: 1,
    maxDrawdownPct: 10,
    ...over,
  };
}

describe("statistics helpers", () => {
  it("medians odd and even length series and ignores NaN", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([1, Number.NaN, 3])).toBe(2);
    expect(median([])).toBe(0);
  });

  it("squashes into 0..1 monotonically around zero", () => {
    expect(squash(0, 20)).toBeCloseTo(0.5, 10);
    expect(squash(100, 20)).toBeGreaterThan(0.99);
    expect(squash(-100, 20)).toBeLessThan(0.01);
    expect(squash(10, 20)).toBeGreaterThan(squash(5, 20));
    expect(() => squash(1, 0)).toThrow(/scale/);
  });

  it("fits a slope and returns null without x spread", () => {
    expect(slope([0, 1, 2], [0, 2, 4])).toBeCloseTo(2, 10);
    expect(slope([1, 1, 1], [0, 2, 4])).toBeNull();
    expect(slope([1], [1])).toBeNull();
  });
});

describe("grouping", () => {
  const cells = [
    cell({ style: "swing", riskLevel: "balanced" }),
    cell({ style: "position", riskLevel: "balanced" }),
    cell({ style: "swing", riskLevel: "high", ticket: SMALL }),
  ];

  it("keys arms by the requested dimension", () => {
    expect(armKey(cells[0]!, "style")).toBe("swing");
    expect(armKey(cells[0]!, "risk+style")).toBe("balanced · swing");
    expect(armKey(cells[2]!, "risk+style+ticket")).toBe("high · swing · 12 x 7%");
    expect(armKey(cells[2]!, "ticket")).toBe("12 x 7%");
  });

  it("collapses cells into buckets", () => {
    expect([...groupCells(cells, "style").keys()].sort()).toEqual(["position", "swing"]);
    expect(groupCells(cells, "style").get("swing")).toHaveLength(2);
    expect(groupCells(cells, "risk+style+ticket").size).toBe(3);
  });

  it("counts distinct cost scenarios as the grid width", () => {
    const wide = scenarios.map((s) => cell({ scale: s.scale }));
    expect(gridWidth(wide)).toBe(3);
    expect(gridWidth([cell({}), cell({})])).toBe(1);
  });
});

describe("cellRoundTripBps", () => {
  it("prices the ticket notional under the cell's own frictions", () => {
    const zero = cellRoundTripBps(cell({ scale: 0 }), { baseFrictions: BASE, startingCash: 10_000 });
    const full = cellRoundTripBps(cell({ scale: 1 }), { baseFrictions: BASE, startingCash: 10_000 });
    expect(zero).toBe(0);
    expect(full!).toBeGreaterThan(zero!);
  });

  it("charges a small ticket more bps than a large one", () => {
    const big = cellRoundTripBps(cell({ ticket: TICKET }), { baseFrictions: BASE, startingCash: 10_000 })!;
    const small = cellRoundTripBps(cell({ ticket: SMALL }), { baseFrictions: BASE, startingCash: 10_000 })!;
    expect(small).toBeGreaterThan(big);
  });

  it("returns null without an account size", () => {
    expect(cellRoundTripBps(cell({}), { baseFrictions: BASE })).toBeNull();
  });
});

describe("scoreArm", () => {
  const opts = { baseFrictions: BASE, startingCash: 10_000 };

  it("rewards an arm that is profitable and ahead of the benchmark everywhere", () => {
    const good = scoreArm(
      "good",
      scenarios.map((s) => cell({ scale: s.scale, totalReturnPct: 18, benchmarkReturnPct: 5 })),
      opts,
    );
    expect(good.profitHitRate).toBe(1);
    expect(good.benchmarkHitRate).toBe(1);
    expect(good.score).toBeGreaterThan(70);
    expect(good.grade).toBe("A");
  });

  it("punishes an arm that only works at zero cost", () => {
    const knife = scoreArm(
      "knife",
      [
        cell({ scale: 0, totalReturnPct: 30 }),
        cell({ scale: 0.5, totalReturnPct: 2 }),
        cell({ scale: 1, totalReturnPct: -25 }),
      ],
      opts,
    );
    const flat = scoreArm(
      "flat",
      scenarios.map((s) => cell({ scale: s.scale, totalReturnPct: 6 })),
      opts,
    );
    expect(knife.profitHitRate).toBeCloseTo(2 / 3, 10);
    expect(knife.returnPerTenBps!).toBeLessThan(0);
    expect(flat.score).toBeGreaterThan(knife.score);
  });

  it("reports the worst and best cells and the median", () => {
    const r = scoreArm(
      "spread",
      [
        cell({ scale: 0, totalReturnPct: 20 }),
        cell({ scale: 0.5, totalReturnPct: 5 }),
        cell({ scale: 1, totalReturnPct: -10 }),
      ],
      opts,
    );
    expect(r.bestReturnPct).toBe(20);
    expect(r.worstReturnPct).toBe(-10);
    expect(r.medianReturnPct).toBe(5);
    expect(r.cells).toBe(3);
  });

  it("penalises deeper drawdowns at equal returns", () => {
    const shallow = scoreArm("shallow", [cell({ maxDrawdownPct: 5 })], opts);
    const deep = scoreArm("deep", [cell({ maxDrawdownPct: 35 })], opts);
    expect(shallow.score).toBeGreaterThan(deep.score);
    expect(deep.components.drawdown).toBeLessThan(shallow.components.drawdown);
  });

  it("labels mixed groups rather than guessing", () => {
    const r = scoreArm("mixed", [cell({ style: "swing" }), cell({ style: "position" })], opts);
    expect(r.style).toBe("mixed");
    expect(r.riskLevel).toBe("balanced");
  });

  it("normalises partial weight overrides and keeps the score bounded", () => {
    const r = scoreArm("w", [cell({})], { ...opts, weights: { profitHit: 10 } });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    // Profit hit now dominates the blend.
    expect(r.score).toBeGreaterThan(80);
  });

  it("treats a missing cost axis as neutral stability", () => {
    const r = scoreArm("nocost", [cell({})]);
    expect(r.returnPerTenBps).toBeNull();
    expect(r.components.costStability).toBe(0.5);
  });

  it("throws on an empty group", () => {
    expect(() => scoreArm("empty", [])).toThrow(/no cells/);
  });

  it("weights are a normalised distribution", () => {
    const total = Object.values(DEFAULT_ROBUSTNESS_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("rankRobustness", () => {
  const cells: SweepCell[] = [
    ...scenarios.map((s) =>
      cell({ scale: s.scale, style: "swing", totalReturnPct: 18, benchmarkReturnPct: 5 }),
    ),
    ...scenarios.map((s) =>
      cell({ scale: s.scale, style: "position", totalReturnPct: -4, benchmarkReturnPct: 5 }),
    ),
  ];

  it("ranks the stronger rule first and grades every row", () => {
    const rows = rankRobustness(cells, {
      groupBy: "style",
      baseFrictions: BASE,
      startingCash: 10_000,
    });
    expect(rows.map((r) => r.arm)).toEqual(["swing", "position"]);
    expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score);
    expect(rows.every((r) => "ABCDE".includes(r.grade))).toBe(true);
  });

  it("is deterministic across repeated runs and input order", () => {
    const a = rankRobustness(cells, { groupBy: "style" });
    const b = rankRobustness([...cells].reverse(), { groupBy: "style" });
    expect(a.map((r) => [r.arm, r.score])).toEqual(b.map((r) => [r.arm, r.score]));
  });

  it("defaults to the finest grouping", () => {
    const rows = rankRobustness(cells);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.arm).toContain("·");
  });

  it("grades bands at their boundaries", () => {
    expect(gradeFor(75)).toBe("A");
    expect(gradeFor(60)).toBe("B");
    expect(gradeFor(45)).toBe("C");
    expect(gradeFor(30)).toBe("D");
    expect(gradeFor(29.9)).toBe("E");
  });
});

describe("table output", () => {
  const rows = rankRobustness(
    scenarios.map((s) => cell({ scale: s.scale })),
    { groupBy: "style", baseFrictions: BASE, startingCash: 10_000 },
  );

  it("emits one row per arm with a cell per column", () => {
    const body = robustnessTableRows(rows);
    expect(body).toHaveLength(rows.length);
    expect(body[0]).toHaveLength(ROBUSTNESS_COLUMNS.length);
    expect(body[0]![0]).toBe("1");
  });

  it("renders an aligned text table with a header rule", () => {
    const text = formatRobustnessTable(rows);
    const lines = text.split("\n");
    expect(lines[0]).toContain("score");
    expect(lines[1]).toMatch(/^-+/);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it("summarises the winner in one sentence", () => {
    const s = summariseRobustness(rows);
    expect(s).toContain("Most robust");
    expect(s).toContain("beats buy & hold");
    expect(summariseRobustness([])).toBe("No cells to score.");
  });
});
