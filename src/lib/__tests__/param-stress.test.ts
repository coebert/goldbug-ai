import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRESS_CONSTRAINTS,
  armTableRows,
  cellTurnover,
  checkCell,
  formatScenarioTable,
  groupArms,
  selectBestFeasible,
  stressArm,
  stressGrid,
  summariseStress,
  type StressCell,
  type StressConstraints,
} from "../param-stress";
import { scaleFrictions, type TicketSpec } from "../cost-sweep";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKET: TicketSpec = { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 };
const TICKET_SMALL: TicketSpec = { label: "12 x 7%", maxNames: 12, perNameWeight: 0.07 };

function cell(
  over: Partial<StressCell> & { scale: number },
  ticket = TICKET,
  style = "swing",
): StressCell {
  const { scale, ...rest } = over;
  return {
    ticket,
    scenario: { label: `${scale * 100}% cost`, scale, frictions: scaleFrictions(BASE, scale) },
    style,
    riskLevel: "balanced",
    totalReturnPct: 10,
    benchmarkReturnPct: 8,
    trades: 100,
    feeDragPct: 5,
    sharpe: 0.8,
    maxDrawdownPct: -12,
    years: 5,
    ...rest,
  };
}

const C: StressConstraints = { maxTradesPerYear: 40, maxDrawdownPct: 20, minReturnPct: 0 };

describe("cellTurnover", () => {
  it("prefers an explicit trades-per-year field", () => {
    expect(cellTurnover(cell({ scale: 1, tradesPerYear: 33, trades: 999 }))).toBe(33);
  });

  it("derives from trades and years otherwise", () => {
    expect(cellTurnover(cell({ scale: 1, trades: 100, years: 4 }))).toBe(25);
  });

  it("falls back to the raw trade count with no horizon", () => {
    const c = cell({ scale: 1, trades: 7 });
    delete (c as { years?: number }).years;
    expect(cellTurnover(c)).toBe(7);
  });

  it("uses the caller-supplied horizon when the cell has none", () => {
    const c = cell({ scale: 1, trades: 50 });
    delete (c as { years?: number }).years;
    expect(cellTurnover(c, 2)).toBe(25);
  });
});

describe("checkCell", () => {
  it("passes a cell inside every constraint", () => {
    const v = checkCell(cell({ scale: 1 }), C);
    expect(v.pass).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.excessPct).toBeCloseTo(2, 10);
  });

  it("flags a turnover breach", () => {
    const v = checkCell(cell({ scale: 1, tradesPerYear: 90 }), C);
    expect(v.violations).toEqual(["turnover"]);
    expect(v.pass).toBe(false);
  });

  it("flags a drawdown breach on magnitude, sign-insensitively", () => {
    expect(checkCell(cell({ scale: 1, maxDrawdownPct: -31 }), C).violations).toEqual(["drawdown"]);
    expect(checkCell(cell({ scale: 1, maxDrawdownPct: 31 }), C).violations).toEqual(["drawdown"]);
  });

  it("normalises the reported drawdown to a negative number", () => {
    expect(checkCell(cell({ scale: 1, maxDrawdownPct: 31 }), C).drawdownPct).toBe(-31);
  });

  it("accumulates multiple violations", () => {
    const v = checkCell(
      cell({ scale: 1, tradesPerYear: 200, maxDrawdownPct: -40, totalReturnPct: -5, sharpe: -1 }),
      { ...C, minSharpe: 0.2, beatBenchmark: true },
    );
    expect(v.violations).toEqual(["turnover", "drawdown", "return", "sharpe", "benchmark"]);
  });

  it("treats the constraint boundary as satisfied", () => {
    const v = checkCell(cell({ scale: 1, tradesPerYear: 40, maxDrawdownPct: -20 }), C);
    expect(v.pass).toBe(true);
  });

  it("only requires beating the benchmark when asked", () => {
    const under = cell({ scale: 1, totalReturnPct: 5, benchmarkReturnPct: 9 });
    expect(checkCell(under, C).pass).toBe(true);
    expect(checkCell(under, { ...C, beatBenchmark: true }).violations).toEqual(["benchmark"]);
  });

  it("reports round-trip bps when a base model and account size are given", () => {
    const v = checkCell(cell({ scale: 1 }), C, { baseFrictions: BASE, startingCash: 10_300 });
    expect(v.roundTripBps).toBeGreaterThan(0);
    const cheap = checkCell(cell({ scale: 0.25 }), C, {
      baseFrictions: BASE,
      startingCash: 10_300,
    });
    expect(cheap.roundTripBps!).toBeLessThan(v.roundTripBps!);
  });

  it("rejects nonsensical constraints", () => {
    expect(() => checkCell(cell({ scale: 1 }), { ...C, maxTradesPerYear: 0 })).toThrow();
    expect(() => checkCell(cell({ scale: 1 }), { ...C, maxDrawdownPct: -5 })).toThrow();
  });
});

describe("stressArm", () => {
  const series = [
    cell({ scale: 0.25, totalReturnPct: 22 }),
    cell({ scale: 0.5, totalReturnPct: 14 }),
    cell({ scale: 1, totalReturnPct: 6 }),
    cell({ scale: 2, totalReturnPct: -9, maxDrawdownPct: -28 }),
    cell({ scale: 3, totalReturnPct: -21, maxDrawdownPct: -34, tradesPerYear: 88 }),
  ];

  it("summarises pass rate and the binding constraint", () => {
    const r = stressArm(series, C, { baseFrictions: BASE, startingCash: 10_300 });
    expect(r.scenarioCount).toBe(5);
    expect(r.passCount).toBe(3);
    expect(r.passRate).toBeCloseTo(0.6, 10);
    expect(r.verdict).toBe("fragile");
    expect(r.bindingCounts.drawdown).toBe(2);
    expect(r.primaryBinding).toBe("drawdown");
  });

  it("reports the worst case across scenarios", () => {
    const r = stressArm(series, C);
    expect(r.worstReturnPct).toBe(-21);
    expect(r.worstDrawdownPct).toBe(-34);
    expect(r.peakTurnover).toBe(88);
  });

  it("reports how far up the cost axis the arm survives", () => {
    const r = stressArm(series, C, { baseFrictions: BASE, startingCash: 10_300 });
    expect(r.survivesToScale).toBe(1);
    expect(r.survivesToBps).toBeGreaterThan(0);
  });

  it("calls an arm robust only when every scenario passes", () => {
    const clean = [cell({ scale: 1 }), cell({ scale: 2 }), cell({ scale: 4 })];
    expect(stressArm(clean, C).verdict).toBe("robust");
    expect(stressArm(clean, C).primaryBinding).toBeNull();
  });

  it("calls a mostly-passing arm conditional", () => {
    const mostly = [
      cell({ scale: 0.5 }),
      cell({ scale: 1 }),
      cell({ scale: 2 }),
      cell({ scale: 4, totalReturnPct: -3 }),
    ];
    expect(stressArm(mostly, C).verdict).toBe("conditional");
  });

  it("orders scenarios by cost scale", () => {
    const r = stressArm([...series].reverse(), C);
    expect(r.scenarios.map((s) => s.scale)).toEqual([0.25, 0.5, 1, 2, 3]);
  });

  it("is deterministic", () => {
    const run = () => JSON.stringify(stressArm(series, C, { startingCash: 10_300 }));
    expect(run()).toBe(run());
  });

  it("rejects an empty arm", () => {
    expect(() => stressArm([], C)).toThrow();
  });
});

describe("groupArms / stressGrid", () => {
  const cells = [
    cell({ scale: 1 }),
    cell({ scale: 2 }),
    cell({ scale: 1, totalReturnPct: -4 }, TICKET_SMALL),
    cell({ scale: 2, totalReturnPct: -18, maxDrawdownPct: -30 }, TICKET_SMALL),
    cell({ scale: 1 }, TICKET, "position"),
    cell({ scale: 2 }, TICKET, "position"),
  ];

  it("splits one arm per risk/style/ticket", () => {
    expect([...groupArms(cells).keys()].sort()).toEqual([
      "balanced · position · 5 x 18%",
      "balanced · swing · 12 x 7%",
      "balanced · swing · 5 x 18%",
    ]);
  });

  it("ranks the most resilient arm first", () => {
    const grid = stressGrid(cells, C);
    expect(grid[0]!.passRate).toBe(1);
    expect(grid.at(-1)!.arm).toBe("balanced · swing · 12 x 7%");
    expect(grid.at(-1)!.passRate).toBe(0);
  });
});

describe("selectBestFeasible", () => {
  const strong = [
    cell({ scale: 1, totalReturnPct: 18, sharpe: 1.2 }),
    cell({ scale: 2, totalReturnPct: 9 }),
    cell({ scale: 4, totalReturnPct: -6, maxDrawdownPct: -26 }),
  ];
  const churny = [
    cell({ scale: 1, totalReturnPct: 25, tradesPerYear: 120 }, TICKET_SMALL),
    cell({ scale: 2, totalReturnPct: 20, tradesPerYear: 120 }, TICKET_SMALL),
    cell({ scale: 4, totalReturnPct: 15, tradesPerYear: 120 }, TICKET_SMALL),
  ];

  it("skips a high-scoring arm that breaches a constraint at baseline", () => {
    const best = selectBestFeasible([...churny, ...strong], C, {
      baseFrictions: BASE,
      startingCash: 10_300,
    });
    expect(best!.arm).toBe("balanced · swing · 5 x 18%");
    expect(best!.consideredArms).toEqual(["balanced · swing · 5 x 18%"]);
    expect(best!.reason).toMatch(/feasible at baseline/);
  });

  it("still returns a report when nothing is feasible", () => {
    const best = selectBestFeasible(churny, C);
    expect(best!.consideredArms).toEqual([]);
    expect(best!.reason).toMatch(/no arm satisfied/);
    expect(best!.stress.verdict).toBe("fragile");
  });

  it("attaches the stress result for the chosen arm", () => {
    const best = selectBestFeasible(strong, C, { baseFrictions: BASE, startingCash: 10_300 });
    expect(best!.stress.scenarioCount).toBe(3);
    expect(best!.robustness.arm).toBe(best!.arm);
  });

  it("returns null on an empty grid", () => {
    expect(selectBestFeasible([], C)).toBeNull();
  });
});

describe("formatting", () => {
  const r = stressArm(
    [cell({ scale: 1 }), cell({ scale: 3, totalReturnPct: -12, maxDrawdownPct: -30 })],
    C,
    { baseFrictions: BASE, startingCash: 10_300 },
  );

  it("renders one row per scenario with a verdict", () => {
    const rows = formatScenarioTable(r).split("\n");
    expect(rows).toHaveLength(3); // header + 2
    expect(rows[2]).toMatch(/breach: drawdown/);
  });

  it("renders an arm table row", () => {
    expect(armTableRows([r])[0]![0]).toBe("balanced · swing · 5 x 18%");
    expect(armTableRows([r])[0]![1]).toBe("fragile");
  });

  it("summarises the constraints in the one-liner", () => {
    const s = summariseStress(r, C);
    expect(s).toContain("≤40 trades/yr");
    expect(s).toContain("-20% drawdown");
    expect(s).toContain("binding constraint: drawdown");
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_STRESS_CONSTRAINTS.maxTradesPerYear).toBeGreaterThan(0);
    expect(DEFAULT_STRESS_CONSTRAINTS.maxDrawdownPct).toBeGreaterThan(0);
  });
});
