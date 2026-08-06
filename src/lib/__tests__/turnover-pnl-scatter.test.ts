// Turnover × re-entry-gap → net P&L scatter and drilldown.
import { describe, it, expect } from "vitest";
import {
  allGapBands,
  bandOf,
  buildDrilldownGrid,
  buildTurnoverPnlPanels,
  correlation,
  describeScatter,
  drilldownTableRows,
  DRILLDOWN_COLUMNS,
  explainDrilldown,
  gapBandFor,
  median,
  percentile,
  renderGapPnlScatter,
  renderTurnoverPnlScatter,
  scatterLegend,
  scatterPoints,
  scatterTableRows,
  SCATTER_COLUMNS,
  turnoverBands,
  type ScatterPoint,
} from "../turnover-pnl-scatter";
import type { TradeLeg, TurnoverRow } from "../turnover-attribution";

// A run: params + metrics + feasibility, matching the optimizer's shape.
const run = (
  params: Record<string, number>,
  m: { tradesPerYear: number; cagrPct: number; feeDragPct?: number; maxDrawdownPct?: number },
  check: { feasible: boolean; disqualified: boolean } = { feasible: true, disqualified: false },
): TurnoverRow => ({
  params,
  metrics: {
    tradesPerYear: m.tradesPerYear,
    cagrPct: m.cagrPct,
    feeDragPct: m.feeDragPct ?? 1,
    maxDrawdownPct: m.maxDrawdownPct ?? -10,
  },
  check,
});

/** A round trip on one symbol, re-bought `gap` days after the exit. */
const roundTrips = (symbol: string, gap: number, count = 2): TradeLeg[] => {
  const legs: TradeLeg[] = [];
  let day = 1;
  for (let i = 0; i < count; i++) {
    const buy = day;
    const sell = day + 10;
    legs.push({ date: iso(buy), side: "buy", symbol, quantity: 10 });
    legs.push({ date: iso(sell), side: "sell", symbol, quantity: 10 });
    day = sell + gap;
  }
  return legs;
};

const iso = (dayOffset: number) =>
  new Date(Date.UTC(2020, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);

describe("statistics helpers", () => {
  it("interpolates percentiles and handles degenerate samples", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 9);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
  });

  it("clamps out-of-range percentile requests", () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });

  it("returns 0 correlation for flat or too-short series", () => {
    expect(correlation([1, 1, 1], [1, 2, 3])).toBe(0);
    expect(correlation([1], [1])).toBe(0);
  });

  it("measures sign and strength of a real relationship", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
  });
});

describe("gap bands", () => {
  it("bands a median gap by re-entry speed", () => {
    expect(gapBandFor(0).key).toBe("immediate");
    expect(gapBandFor(2).key).toBe("immediate");
    expect(gapBandFor(3).key).toBe("fast");
    expect(gapBandFor(5).key).toBe("fast");
    expect(gapBandFor(6).key).toBe("patient");
    expect(gapBandFor(15).key).toBe("patient");
    expect(gapBandFor(40).key).toBe("slow");
  });

  it("uses a dedicated bucket for runs that never re-entered", () => {
    expect(gapBandFor(null).key).toBe("none");
    expect(gapBandFor(Number.NaN).key).toBe("none");
    expect(allGapBands().map((b) => b.key)).toContain("none");
  });
});

describe("scatterPoints", () => {
  const rows = [
    run({ a: 1 }, { tradesPerYear: 60, cagrPct: -2, feeDragPct: 6 }),
    run({ a: 2 }, { tradesPerYear: 12, cagrPct: 7, feeDragPct: 1 }),
  ];
  const logs: Record<string, TradeLeg[]> = {
    "a=1": roundTrips("AAA", 1, 3),
    "a=2": roundTrips("BBB", 30, 3),
  };
  const logFor = (r: TurnoverRow) => logs[`a=${r.params["a"]}`] ?? [];

  it("joins metrics with the gap distribution rebuilt from each run's own log", () => {
    const pts = scatterPoints(rows, logFor);
    expect(pts).toHaveLength(2);
    const churny = pts.find((p) => p.label === "a=1")!;
    expect(churny.medianGapDays).toBe(1);
    expect(churny.band.key).toBe("immediate");
    expect(churny.netCagrPct).toBe(-2);
    const patient = pts.find((p) => p.label === "a=2")!;
    expect(patient.medianGapDays).toBe(30);
    expect(patient.band.key).toBe("slow");
  });

  it("reports the p90 gap alongside the median so tails stay visible", () => {
    const uneven: TradeLeg[] = [
      ...roundTrips("AAA", 2, 3),
      { date: "2021-01-01", side: "buy", symbol: "ZZZ", quantity: 1 },
      { date: "2021-01-05", side: "sell", symbol: "ZZZ", quantity: 1 },
      { date: "2021-04-05", side: "buy", symbol: "ZZZ", quantity: 1 },
    ];
    const [p] = scatterPoints([rows[0]!], () => uneven);
    expect(p!.p90GapDays).toBeGreaterThan(p!.medianGapDays!);
  });

  it("marks a run with no re-entries as the 'none' band rather than gap zero", () => {
    const [p] = scatterPoints([rows[0]!], () => [
      { date: "2020-01-02", side: "buy", symbol: "AAA", quantity: 5 },
      { date: "2020-02-02", side: "sell", symbol: "AAA", quantity: 5 },
    ]);
    expect(p!.medianGapDays).toBeNull();
    expect(p!.p90GapDays).toBeNull();
    expect(p!.band.key).toBe("none");
    expect(p!.reentryRate).toBe(0);
  });

  it("excludes disqualified runs by default and includes them on request", () => {
    const withBad = [
      ...rows,
      run({ a: 3 }, { tradesPerYear: 400, cagrPct: 99 }, { feasible: false, disqualified: true }),
    ];
    expect(scatterPoints(withBad, logFor)).toHaveLength(2);
    expect(scatterPoints(withBad, logFor, { includeDisqualified: true })).toHaveLength(3);
  });

  it("keeps infeasible-but-scored runs, flagged", () => {
    const soft = [run({ a: 9 }, { tradesPerYear: 200, cagrPct: 1 }, { feasible: false, disqualified: false })];
    const [p] = scatterPoints(soft, () => []);
    expect(p!.feasible).toBe(false);
  });
});

// -------------------------------------------------------------- drilldown

const point = (
  label: string,
  tradesPerYear: number,
  netCagrPct: number,
  medianGapDays: number | null,
  extra: Partial<ScatterPoint> = {},
): ScatterPoint => ({
  label,
  params: {},
  tradesPerYear,
  netCagrPct,
  feeDragPct: extra.feeDragPct ?? 2,
  maxDrawdownPct: extra.maxDrawdownPct ?? -10,
  feasible: extra.feasible ?? true,
  medianGapDays,
  p90GapDays: medianGapDays,
  reentryRate: extra.reentryRate ?? 0.8,
  fastReentryShare: extra.fastReentryShare ?? 0.2,
  reentries: extra.reentries ?? 4,
  band: gapBandFor(medianGapDays),
});

describe("turnoverBands", () => {
  it("cuts the population into roughly equal quantile bands", () => {
    const pts = [10, 20, 30, 40, 50, 60].map((t, i) => point(`p${i}`, t, 1, 10));
    const bands = turnoverBands(pts, 3);
    expect(bands).toHaveLength(3);
    expect(bands[bands.length - 1]!.max).toBe(Infinity);
    // Every point lands in exactly one band.
    for (const p of pts) expect(bandOf(bands, p.tradesPerYear)).not.toBeNull();
  });

  it("collapses to a single band when every run traded the same amount", () => {
    const bands = turnoverBands([point("a", 25, 1, 5), point("b", 25, 2, 5)], 4);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.label).toContain("25");
  });

  it("does not emit duplicate empty bands from repeated quantiles", () => {
    const pts = [1, 1, 1, 1, 90].map((t, i) => point(`p${i}`, t, 1, 5));
    const bands = turnoverBands(pts, 4);
    const labels = bands.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("returns nothing for an empty population", () => {
    expect(turnoverBands([], 3)).toEqual([]);
    expect(bandOf([], 10)).toBeNull();
  });
});

describe("buildDrilldownGrid", () => {
  // Churny fast re-entry loses money; patient low-turnover makes money.
  const pts = [
    point("churn-a", 90, -3, 1, { feeDragPct: 7 }),
    point("churn-b", 80, -2, 2, { feeDragPct: 6 }),
    point("mid-a", 40, 1, 8, { feeDragPct: 3 }),
    point("mid-b", 35, 2, 9, { feeDragPct: 3 }),
    point("calm-a", 10, 8, 40, { feeDragPct: 1 }),
    point("calm-b", 8, 9, 45, { feeDragPct: 1 }),
  ];

  it("cross-tabulates every turnover × gap combination present", () => {
    const g = buildDrilldownGrid(pts, { turnoverBandCount: 3 });
    expect(g.runs).toBe(6);
    expect(g.cells).toHaveLength(g.turnoverBands.length * g.gapBands.length);
    // Only the diagonal is populated in this synthetic set.
    expect(g.ranked).toHaveLength(3);
    expect(g.ranked.reduce((a, c) => a + c.runs, 0)).toBe(6);
  });

  it("ranks cells by median net outcome after costs", () => {
    const g = buildDrilldownGrid(pts, { turnoverBandCount: 3 });
    expect(g.ranked[0]!.medianNetCagrPct).toBeCloseTo(8.5, 9);
    expect(g.ranked[0]!.gap.key).toBe("slow");
    expect(g.ranked[g.ranked.length - 1]!.gap.key).toBe("immediate");
  });

  it("surfaces the cost channel: turnover correlates with fees and against P&L", () => {
    const g = buildDrilldownGrid(pts);
    expect(g.turnoverPnlCorr).toBeLessThan(-0.8);
    expect(g.turnoverFeeCorr).toBeGreaterThan(0.8);
    expect(g.gapPnlCorr).toBeGreaterThan(0.8);
  });

  it("summarises each cell with spread, fees and hit rates", () => {
    const g = buildDrilldownGrid(pts, { turnoverBandCount: 3 });
    const worst = g.ranked[g.ranked.length - 1]!;
    expect(worst.runs).toBe(2);
    expect(worst.bestNetCagrPct).toBe(-2);
    expect(worst.worstNetCagrPct).toBe(-3);
    expect(worst.profitableShare).toBe(0);
    expect(worst.feasibleShare).toBe(1);
    expect(worst.meanFeeDragPct).toBeCloseTo(6.5, 9);
    expect(worst.members).toEqual(["churn-b", "churn-a"]);
  });

  it("caps the example configs stored per cell", () => {
    const many = Array.from({ length: 9 }, (_, i) => point(`p${i}`, 20, i, 30));
    const g = buildDrilldownGrid(many, { turnoverBandCount: 1, maxMembers: 2 });
    expect(g.ranked[0]!.members).toHaveLength(2);
    expect(g.ranked[0]!.members[0]).toBe("p8");
  });

  it("keeps the no-re-entry population as its own column", () => {
    const g = buildDrilldownGrid([point("solo", 5, 4, null)]);
    expect(g.gapBands.map((b) => b.key)).toEqual(["none"]);
    expect(g.gapPnlCorr).toBe(0);
  });

  it("is inert on an empty population", () => {
    const g = buildDrilldownGrid([]);
    expect(g.runs).toBe(0);
    expect(g.cells).toEqual([]);
    expect(g.ranked).toEqual([]);
    expect(g.turnoverPnlCorr).toBe(0);
  });
});

describe("tables", () => {
  const pts = [point("a", 50, -1, 2), point("b", 10, 6, 20)];

  it("emits one drilldown row per populated cell with the right arity", () => {
    const g = buildDrilldownGrid(pts, { turnoverBandCount: 2 });
    const rows = drilldownTableRows(g);
    expect(rows).toHaveLength(g.ranked.length);
    for (const r of rows) expect(r).toHaveLength(DRILLDOWN_COLUMNS.length);
  });

  it("sorts the per-run table by net outcome, best first", () => {
    const rows = scatterTableRows(pts);
    expect(rows[0]![0]).toBe("b");
    for (const r of rows) expect(r).toHaveLength(SCATTER_COLUMNS.length);
  });

  it("renders an em dash rather than 0 for runs with no measured gap", () => {
    const rows = scatterTableRows([point("none", 5, 1, null)]);
    expect(rows[0]).toContain("—");
  });
});

describe("rendering", () => {
  const pts = [
    point("churn", 90, -3, 1, { feeDragPct: 8 }),
    point("calm", 10, 6, 30, { feeDragPct: 1, feasible: false }),
  ];

  it("draws one dot per run, coloured by re-entry band", () => {
    const svg = renderTurnoverPnlScatter(pts);
    expect((svg.match(/<circle/g) ?? [])).toHaveLength(2);
    expect(svg).toContain(gapBandFor(1).colour);
    expect(svg).toContain(gapBandFor(30).colour);
  });

  it("scales dot radius with fee drag", () => {
    const radii = [...renderTurnoverPnlScatter(pts).matchAll(/r="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii));
  });

  it("fades infeasible runs instead of hiding them", () => {
    expect(renderTurnoverPnlScatter(pts)).toContain('fill-opacity="0.35"');
  });

  it("puts the full drilldown into each dot's tooltip", () => {
    const svg = renderTurnoverPnlScatter(pts);
    expect(svg).toContain("90 trades/yr");
    expect(svg).toContain("median gap 1d");
    expect(svg).toContain("fees 8.00%");
  });

  it("marks the fitted breakeven turnover when supplied", () => {
    const svg = renderTurnoverPnlScatter(pts, {
      markerX: { value: 45, label: "fitted breakeven turnover" },
    });
    expect(svg).toContain("fitted breakeven turnover");
    expect(svg).toContain('stroke-dasharray="4 4"');
  });

  it("draws the zero line when outcomes straddle breakeven", () => {
    expect(renderTurnoverPnlScatter(pts)).toContain('class="zero"');
  });

  it("degrades to a labelled empty chart with no runs", () => {
    const svg = renderTurnoverPnlScatter([]);
    expect(svg).toContain("no data");
    expect(svg).not.toContain("<circle");
  });

  it("escapes config labels so a param string cannot break the SVG", () => {
    const svg = renderTurnoverPnlScatter([point('a<b>&"', 10, 1, 5)]);
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).not.toMatch(/<title>a<b>/);
  });

  it("plots the gap view on the gap axis and drops runs that never re-entered", () => {
    const svg = renderGapPnlScatter([...pts, point("never", 5, 2, null)]);
    expect((svg.match(/<circle/g) ?? [])).toHaveLength(2);
    expect(svg).toContain("re-entry gap");
  });

  it("legends only the bands actually present", () => {
    const legend = scatterLegend(pts);
    expect(legend.map((l) => l.label)).toEqual([
      gapBandFor(1).label,
      gapBandFor(30).label,
    ]);
  });
});

describe("explanations", () => {
  const churnHurts = [
    point("a", 90, -3, 1, { feeDragPct: 8 }),
    point("b", 60, -1, 2, { feeDragPct: 5 }),
    point("c", 20, 4, 20, { feeDragPct: 2 }),
    point("d", 8, 7, 30, { feeDragPct: 1 }),
  ];

  it("names the direction of the turnover relationship and the fee channel", () => {
    const text = describeScatter(buildDrilldownGrid(churnHurts));
    expect(text).toContain("negative");
    expect(text).toContain("clearly drives");
    expect(text).toContain("4 runs");
  });

  it("says re-entry speed is not decisive when the gap carries no signal", () => {
    const flat = [
      point("a", 10, 5, 3),
      point("b", 20, 5, 20),
      point("c", 30, 5, 8),
    ];
    expect(describeScatter(buildDrilldownGrid(flat))).toContain("not the deciding factor");
  });

  it("flags early exits when faster re-entries score better", () => {
    const fastWins = [
      point("a", 20, 8, 1),
      point("b", 20, 4, 10),
      point("c", 20, 0, 30),
    ];
    expect(describeScatter(buildDrilldownGrid(fastWins))).toContain("firing too early");
  });

  it("contrasts the best and worst cells with the spread between them", () => {
    const text = explainDrilldown(buildDrilldownGrid(churnHurts, { turnoverBandCount: 2 }));
    expect(text).toContain("Best combination");
    expect(text).toContain("Worst");
    expect(text).toMatch(/pp spread/);
  });

  it("does not fabricate a comparison from a single populated cell", () => {
    const text = explainDrilldown(buildDrilldownGrid([point("solo", 10, 3, 20)]));
    expect(text).toContain("Best combination");
    expect(text).not.toContain("Worst");
  });

  it("says plainly when there is nothing to relate", () => {
    expect(describeScatter(buildDrilldownGrid([]))).toContain("No runs to plot");
    expect(explainDrilldown(buildDrilldownGrid([]))).toContain("No populated cells");
  });
});

describe("report panels", () => {
  const pts = [point("a", 90, -3, 1), point("b", 10, 6, 30)];

  it("builds the two scatters, the drilldown and the per-run table", () => {
    const panels = buildTurnoverPnlPanels(pts, {
      frictionNote: "8bps + $3 commission",
      breakevenTradesPerYear: 40,
    });
    expect(panels).toHaveLength(3);
    expect(panels[0]!.charts).toHaveLength(2);
    expect(panels[0]!.legend).toHaveLength(2);
    expect(panels[0]!.subtitle).toContain("8bps + $3 commission");
    expect(panels[0]!.charts![0]).toContain("fitted breakeven turnover");
    expect(panels[1]!.table!.rows).toHaveLength(
      buildDrilldownGrid(pts).ranked.length,
    );
    expect(panels[2]!.table!.rows).toHaveLength(2);
  });

  it("omits the breakeven marker when the fit produced none", () => {
    const panels = buildTurnoverPnlPanels(pts, { breakevenTradesPerYear: null });
    expect(panels[0]!.charts![0]).not.toContain("fitted breakeven turnover");
  });

  it("still renders panels when there are no runs", () => {
    const panels = buildTurnoverPnlPanels([]);
    expect(panels).toHaveLength(3);
    expect(panels[0]!.charts![0]).toContain("no data");
    expect(panels[1]!.table!.rows).toEqual([]);
  });
});
