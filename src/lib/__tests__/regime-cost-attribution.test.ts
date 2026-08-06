// Per-regime cost decomposition: axis split, train vs out-of-sample, erosion.
import { describe, it, expect } from "vitest";
import {
  attributeWindowCosts,
  axisCostsFromDrag,
  axisShares,
  buildRegimeCostReport,
  dominantCostAxis,
  explainRegimeCosts,
  phaseCosts,
  splitFillsByPhase,
  summariseCostAttribution,
  summariseRegimeCosts,
  totalAxisCost,
  regimeCostTableRows,
  REGIME_COST_COLUMNS,
  type CostWindowRow,
  type DatedFill,
} from "../regime-cost-attribution";
import { buildRegimeReport, type WindowResult } from "../regime-walk-forward";

const FRICTIONS = { commissionBps: 8, minCommission: 3, slippageBps: 5, buyTaxBps: 0 };

/** A fill whose booked fee is exactly the bps rate — no minimum-fee floor. */
const bigTicket = (date: string, notional = 10_000): DatedFill => ({
  date,
  notional,
  fee: notional * 0.0008,
  side: "BUY",
});

/** A tiny ticket where the £3 floor dominates the 8bps rate. */
const smallTicket = (date: string, notional = 300): DatedFill => ({
  date,
  notional,
  fee: 3,
  side: "BUY",
});

describe("axis decomposition", () => {
  it("splits commission into rate and floor so the axes are disjoint", () => {
    const axes = axisCostsFromDrag({
      commissionPct: 1.0,
      minFeePct: 0.7,
      slippagePct: 0.5,
      otherPct: 0.1,
    });
    expect(axes.rate_commission).toBeCloseTo(0.3, 9);
    expect(axes.min_fee).toBeCloseTo(0.7, 9);
    // Disjoint axes must sum to the true total, not double-count commission.
    expect(totalAxisCost(axes)).toBeCloseTo(1.6, 9);
  });

  it("clamps negative inputs rather than inventing a credit", () => {
    const axes = axisCostsFromDrag({
      commissionPct: -1,
      minFeePct: -1,
      slippagePct: -1,
      otherPct: -1,
    });
    expect(totalAxisCost(axes)).toBe(0);
  });

  it("reports shares that sum to 1 when anything was paid", () => {
    const s = axisShares({ min_fee: 2, slippage: 1, rate_commission: 1, other: 0 });
    expect(s.min_fee).toBeCloseTo(0.5, 9);
    expect(s.min_fee + s.slippage + s.rate_commission + s.other).toBeCloseTo(1, 9);
  });

  it("returns all-zero shares when nothing was paid", () => {
    const s = axisShares({ min_fee: 0, slippage: 0, rate_commission: 0, other: 0 });
    expect(totalAxisCost(s)).toBe(0);
  });
});

describe("dominantCostAxis", () => {
  it("names the biggest axis and flags a majority", () => {
    const d = dominantCostAxis({ min_fee: 6, slippage: 2, rate_commission: 1, other: 1 });
    expect(d.axis).toBe("min_fee");
    expect(d.share).toBeCloseTo(0.6, 9);
    expect(d.majority).toBe(true);
  });

  it("does not claim a majority for a plurality", () => {
    const d = dominantCostAxis({ min_fee: 4, slippage: 3, rate_commission: 3, other: 0 });
    expect(d.axis).toBe("min_fee");
    expect(d.majority).toBe(false);
  });

  it("breaks ties toward the more actionable axis", () => {
    expect(dominantCostAxis({ min_fee: 5, slippage: 5, rate_commission: 0, other: 0 }).axis)
      .toBe("min_fee");
    expect(dominantCostAxis({ min_fee: 0, slippage: 5, rate_commission: 5, other: 0 }).axis)
      .toBe("slippage");
  });

  it("reports 'none' when nothing traded", () => {
    const d = dominantCostAxis({ min_fee: 0, slippage: 0, rate_commission: 0, other: 0 });
    expect(d.axis).toBe("none");
    expect(d.majority).toBe(false);
  });
});

describe("splitFillsByPhase", () => {
  const fills = [
    bigTicket("2020-01-10"),
    bigTicket("2020-02-10"),
    bigTicket("2020-06-10"),
    bigTicket("2020-07-10"),
  ];
  const bounds = { trainFrom: "2020-01-01", testFrom: "2020-06-01", testTo: "2020-12-31" };

  it("assigns fills on either side of the boundary", () => {
    const s = splitFillsByPhase(fills, bounds);
    expect(s.train.map((f) => f.date)).toEqual(["2020-01-10", "2020-02-10"]);
    expect(s.test.map((f) => f.date)).toEqual(["2020-06-10", "2020-07-10"]);
  });

  it("puts a fill exactly on the test open into the out-of-sample slice", () => {
    const s = splitFillsByPhase([bigTicket("2020-06-01")], bounds);
    expect(s.train).toHaveLength(0);
    expect(s.test).toHaveLength(1);
  });

  it("drops fills outside the window entirely", () => {
    const s = splitFillsByPhase(
      [bigTicket("2019-12-31"), bigTicket("2021-01-01")],
      bounds,
    );
    expect(s.train).toHaveLength(0);
    expect(s.test).toHaveLength(0);
  });
});

describe("phaseCosts", () => {
  it("attributes a tiny-ticket book to the minimum fee", () => {
    const p = phaseCosts("test", [smallTicket("2020-06-10"), smallTicket("2020-06-20")], FRICTIONS, 10_000, 126);
    expect(p.dominant.axis).toBe("min_fee");
    expect(p.axes.min_fee).toBeGreaterThan(p.axes.rate_commission);
    expect(p.trades).toBe(2);
  });

  it("attributes a big-ticket book to the rate and slippage, not the floor", () => {
    const p = phaseCosts("test", [bigTicket("2020-06-10"), bigTicket("2020-06-20")], FRICTIONS, 10_000, 126);
    expect(p.axes.min_fee).toBeCloseTo(0, 6);
    expect(p.dominant.axis).toBe("rate_commission");
    expect(p.axes.slippage).toBeGreaterThan(0);
  });

  it("annualises the drag by the phase length", () => {
    const half = phaseCosts("test", [bigTicket("2020-06-10")], FRICTIONS, 10_000, 126);
    expect(half.years).toBeCloseTo(0.5, 9);
    expect(half.annualDragPct).toBeCloseTo(half.totalDragPct * 2, 9);
  });

  it("is inert with no fills or no capital", () => {
    expect(phaseCosts("train", [], FRICTIONS, 10_000, 252).totalDragPct).toBe(0);
    expect(phaseCosts("train", [bigTicket("2020-01-02")], FRICTIONS, 0, 252).totalDragPct).toBe(0);
  });
});

describe("attributeWindowCosts", () => {
  const base = {
    frictions: FRICTIONS,
    startingCash: 10_000,
    trainFrom: "2020-01-01",
    testFrom: "2020-07-01",
    testTo: "2020-12-31",
    trainBars: 126,
    testBars: 126,
  };

  it("separates the two phases and measures the drift between them", () => {
    const c = attributeWindowCosts({
      ...base,
      fills: [bigTicket("2020-02-01"), smallTicket("2020-08-01"), smallTicket("2020-09-01")],
    });
    expect(c.train.trades).toBe(1);
    expect(c.test.trades).toBe(2);
    expect(c.train.dominant.axis).toBe("rate_commission");
    expect(c.test.dominant.axis).toBe("min_fee");
    // Cheap in training, expensive out of sample => positive drift.
    expect(c.dragDriftPct).toBeCloseTo(c.test.annualDragPct - c.train.annualDragPct, 9);
  });

  it("reports zero drift when both phases trade identically", () => {
    const c = attributeWindowCosts({
      ...base,
      fills: [bigTicket("2020-02-01"), bigTicket("2020-08-01")],
    });
    expect(c.dragDriftPct).toBeCloseTo(0, 9);
  });

  it("handles a window that never traded", () => {
    const c = attributeWindowCosts({ ...base, fills: [] });
    expect(c.train.totalDragPct).toBe(0);
    expect(c.test.totalDragPct).toBe(0);
    expect(c.dragDriftPct).toBe(0);
  });
});

// -------------------------------------------------------------- aggregation

const costRow = (
  regime: "bull" | "bear" | "sideways",
  netCagrPct: number,
  testFills: DatedFill[],
  trainFills: DatedFill[] = testFills,
): CostWindowRow => ({
  regime,
  netCagrPct,
  costs: attributeWindowCosts({
    fills: [...trainFills, ...testFills.map((f) => ({ ...f, date: `2020-08-${f.date.slice(-2)}` }))],
    frictions: FRICTIONS,
    startingCash: 10_000,
    trainFrom: "2020-01-01",
    testFrom: "2020-07-01",
    testTo: "2020-12-31",
    trainBars: 126,
    testBars: 126,
  }),
});

describe("summariseRegimeCosts", () => {
  it("is inert for a regime with no windows", () => {
    const s = summariseRegimeCosts("bear", []);
    expect(s.windows).toBe(0);
    expect(s.dominant.axis).toBe("none");
    expect(s.erosionShare).toBe(0);
  });

  it("reconstructs gross CAGR by adding the out-of-sample drag back to net", () => {
    const rows = [costRow("bull", 6, [bigTicket("2020-01-05")])];
    const s = summariseRegimeCosts("bull", rows);
    expect(s.medianNetCagrPct).toBe(6);
    expect(s.medianGrossCagrPct).toBeCloseTo(6 + s.medianAnnualDragPct.test, 9);
    expect(s.medianGrossCagrPct).toBeGreaterThan(6);
  });

  it("measures erosion as the share of gross return that cost consumed", () => {
    const rows = [costRow("bull", 6, [bigTicket("2020-01-05")])];
    const s = summariseRegimeCosts("bull", rows);
    expect(s.erosionShare).toBeCloseTo(
      s.medianAnnualDragPct.test / s.medianGrossCagrPct,
      9,
    );
    expect(s.erosionShare).toBeGreaterThan(0);
    expect(s.erosionShare).toBeLessThan(1);
  });

  it("flags when cost alone flipped a profitable gross into a net loss", () => {
    const rows = [costRow("sideways", -0.5, Array.from({ length: 12 }, (_, i) =>
      smallTicket(`2020-01-${String(i + 10).padStart(2, "0")}`)))];
    const s = summariseRegimeCosts("sideways", rows);
    expect(s.medianGrossCagrPct).toBeGreaterThan(0);
    expect(s.medianNetCagrPct).toBeLessThan(0);
    expect(s.costFlippedSign).toBe(true);
    expect(s.erosionShare).toBeGreaterThan(1);
  });

  it("does not report erosion when there was no gross return to erode", () => {
    const rows = [costRow("bear", -20, [bigTicket("2020-01-05")])];
    const s = summariseRegimeCosts("bear", rows);
    expect(s.erosionShare).toBe(0);
    expect(s.costFlippedSign).toBe(false);
  });

  it("names the dominant out-of-sample axis, cost-weighted across windows", () => {
    const rows = [
      costRow("bull", 5, Array.from({ length: 10 }, (_, i) =>
        smallTicket(`2020-01-${String(i + 10).padStart(2, "0")}`))),
      costRow("bull", 5, [bigTicket("2020-01-05")]),
    ];
    const s = summariseRegimeCosts("bull", rows);
    expect(s.windows).toBe(2);
    expect(s.dominant.axis).toBe("min_fee");
    expect(s.testAxisShares.min_fee).toBeGreaterThan(s.testAxisShares.rate_commission);
  });

  it("ignores windows belonging to other regimes", () => {
    const rows = [
      costRow("bull", 10, [bigTicket("2020-01-05")]),
      costRow("bear", -10, [bigTicket("2020-01-05")]),
    ];
    expect(summariseRegimeCosts("bear", rows).windows).toBe(1);
    expect(summariseRegimeCosts("bear", rows).medianNetCagrPct).toBe(-10);
  });

  it("surfaces a positive drift when out-of-sample trading is dearer than training", () => {
    const rows = [
      costRow(
        "bull",
        5,
        Array.from({ length: 8 }, (_, i) => smallTicket(`2020-01-${String(i + 10).padStart(2, "0")}`)),
        [bigTicket("2020-02-03")],
      ),
    ];
    expect(summariseRegimeCosts("bull", rows).medianDragDriftPct).toBeGreaterThan(0);
  });
});

describe("report integration", () => {
  const win = (i: number, regime: "bull" | "bear", net: number, fills: DatedFill[]): WindowResult => ({
    window: { index: i, trainStart: 0, trainEnd: 126, testStart: 126, testEnd: 252 },
    regime,
    purity: 1,
    confidence: 0.9,
    from: "2020-07-01",
    to: "2020-12-31",
    netCagrPct: net,
    maxDrawdownPct: -8,
    benchmarkCagrPct: 4,
    trades: fills.length,
    tradesPerYear: fills.length * 2,
    feeDragPct: 1,
    sharpe: 0.7,
    costs: attributeWindowCosts({
      fills,
      frictions: FRICTIONS,
      startingCash: 10_000,
      trainFrom: "2020-01-01",
      testFrom: "2020-07-01",
      testTo: "2020-12-31",
      trainBars: 126,
      testBars: 126,
    }),
  });

  it("attaches a cost row per regime, aligned with the summaries", () => {
    const report = buildRegimeReport([win(0, "bull", 8, [bigTicket("2020-08-01")])]);
    expect(report.costs).toHaveLength(report.summaries.length);
    expect(report.costs.map((c) => c.regime)).toEqual(report.summaries.map((s) => s.regime));
    expect(report.costs.find((c) => c.regime === "bull")!.windows).toBe(1);
    expect(report.costs.find((c) => c.regime === "bear")!.windows).toBe(0);
  });

  it("tolerates windows with no attribution attached", () => {
    const w = win(0, "bull", 8, [bigTicket("2020-08-01")]);
    delete (w as { costs?: unknown }).costs;
    const report = buildRegimeReport([w]);
    expect(report.costs.every((c) => c.windows === 0)).toBe(true);
    // The return summary is unaffected by the missing cost data.
    expect(report.summaries.find((s) => s.regime === "bull")!.windows).toBe(1);
  });

  it("renders one padded table row per regime", () => {
    const report = buildRegimeReport([win(0, "bull", 8, [bigTicket("2020-08-01")])]);
    const rows = regimeCostTableRows(report.costs);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(REGIME_COST_COLUMNS.length);
  });
});

describe("explanations", () => {
  it("prescribes bigger tickets when the floor dominates", () => {
    const s = summariseRegimeCosts("sideways", [
      costRow("sideways", 1, Array.from({ length: 10 }, (_, i) =>
        smallTicket(`2020-01-${String(i + 10).padStart(2, "0")}`))),
    ]);
    const text = explainRegimeCosts(s);
    expect(text).toContain("minimum fee");
    expect(text).toMatch(/ticket size/);
  });

  it("prescribes patience when slippage dominates", () => {
    const s = summariseRegimeCosts("bull", [
      costRow("bull", 5, [{ date: "2020-01-05", notional: 50_000, fee: 1, side: "BUY" }]),
    ]);
    expect(s.dominant.axis).toBe("slippage");
    expect(explainRegimeCosts(s)).toMatch(/liquid|patiently/);
  });

  it("says so plainly when a regime never traded", () => {
    expect(explainRegimeCosts(summariseRegimeCosts("bear", []))).toContain("nothing to attribute");
  });

  it("headlines the largest axis across regimes", () => {
    const report = buildRegimeCostReport([
      costRow("bull", 5, Array.from({ length: 10 }, (_, i) =>
        smallTicket(`2020-01-${String(i + 10).padStart(2, "0")}`))),
    ]);
    expect(summariseCostAttribution(report)).toContain("minimum fee");
  });

  it("stays quiet when nothing traded anywhere", () => {
    expect(summariseCostAttribution(buildRegimeCostReport([]))).toContain("No trading cost");
  });
});
