import { describe, it, expect } from "vitest";
import {
  buildBreakevenChart,
  buildBreakevenCurve,
  buildCostReturnChart,
  buildCostReturnPanels,
  costScales,
  niceTicks,
  renderXYChart,
} from "../cost-return-chart";
import { buildCostScenarios, type SweepCell, type TicketSpec } from "../cost-sweep";
import { renderBacktestReportHtml } from "../backtest-report-chart";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKETS: TicketSpec[] = [
  { label: "12 x 7%", maxNames: 12, perNameWeight: 0.07 },
  { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 },
  { label: "3 x 30%", maxNames: 3, perNameWeight: 0.3 },
];

const SCALES = [0, 0.25, 0.5, 1];
const scenarios = buildCostScenarios(BASE, SCALES);
const START = 10_300;

/**
 * Synthetic sweep: returns fall as cost rises, and rise with ticket size
 * (bigger tickets amortise the fixed commission minimum). Small tickets stay
 * under water at baseline cost; the largest ticket clears it.
 */
function makeCells(riskLevel: string, style = "swing"): SweepCell[] {
  const cells: SweepCell[] = [];
  TICKETS.forEach((ticket, ti) => {
    for (const scenario of scenarios) {
      const gross = 12 + ti * 2;
      const costDrag = scenario.scale * (30 - ti * 9);
      cells.push({
        ticket,
        scenario,
        style,
        riskLevel,
        totalReturnPct: gross - costDrag,
        benchmarkReturnPct: 9,
        trades: 100 - ti * 20,
        feeDragPct: costDrag,
        sharpe: 0.5,
        maxDrawdownPct: -12,
      });
    }
  });
  return cells;
}

const cells = makeCells("balanced");
const opts = { baseFrictions: BASE, startingCash: START, tickets: TICKETS };

describe("niceTicks", () => {
  it("produces round, ascending ticks inside the range", () => {
    const t = niceTicks(-12, 34);
    expect(t.length).toBeGreaterThan(2);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(t[0]!).toBeGreaterThanOrEqual(-12);
    expect(t.at(-1)!).toBeLessThanOrEqual(34);
  });

  it("degrades safely on a flat or invalid range", () => {
    expect(niceTicks(5, 5)).toEqual([5, 5]);
    expect(niceTicks(NaN, 3)).toEqual([3]);
  });
});

describe("renderXYChart", () => {
  it("renders a point marker per observation with a hover note", () => {
    const svg = renderXYChart(
      [
        {
          label: "a",
          colour: "#39d98a",
          points: [
            { x: 1, y: 2, note: "first" },
            { x: 2, y: 5, note: "second" },
          ],
        },
      ],
      { title: "T", xLabel: "x", yLabel: "y" },
    );
    expect((svg.match(/<circle/g) ?? []).length).toBe(2);
    expect(svg).toContain("<title>first</title>");
    expect(svg).toContain("<svg");
  });

  it("escapes untrusted labels", () => {
    const svg = renderXYChart([{ label: "<x>", colour: "#fff", points: [{ x: 1, y: 1 }] }], {
      title: '"><script>',
      xLabel: "x",
      yLabel: "y",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;");
  });

  it("draws a zero line only when the range straddles zero", () => {
    const straddle = renderXYChart(
      [{ label: "a", colour: "#fff", points: [{ x: 1, y: -4 }, { x: 2, y: 6 }] }],
      { title: "T", xLabel: "x", yLabel: "y" },
    );
    const positive = renderXYChart(
      [{ label: "a", colour: "#fff", points: [{ x: 1, y: 4 }, { x: 2, y: 6 }] }],
      { title: "T", xLabel: "x", yLabel: "y" },
    );
    expect(straddle).toContain('class="zero"');
    expect(positive).not.toContain('class="zero"');
  });

  it("falls back to a no-data placeholder", () => {
    expect(renderXYChart([], { title: "T", xLabel: "x", yLabel: "y" })).toContain("no data");
    expect(renderXYChart([{ label: "a", colour: "#fff", points: [] }], {
      title: "T",
      xLabel: "x",
      yLabel: "y",
    })).toContain("no data");
  });

  it("never emits NaN coordinates for a single point", () => {
    const svg = renderXYChart([{ label: "a", colour: "#fff", points: [{ x: 5, y: 5 }] }], {
      title: "T",
      xLabel: "x",
      yLabel: "y",
    });
    expect(svg).not.toContain("NaN");
  });
});

describe("costScales", () => {
  it("lists distinct scales ascending", () => {
    expect(costScales(cells)).toEqual(SCALES);
  });
});

describe("buildCostReturnChart", () => {
  it("plots one line per cost scale plus a buy & hold reference", () => {
    const svg = buildCostReturnChart(cells, opts);
    expect((svg.match(/<path class="line"/g) ?? []).length).toBe(SCALES.length + 1);
    expect(svg).toContain("Net return vs ticket size");
    expect(svg).toContain("ticket notional");
  });

  it("uses ticket notional on the x axis, not the ticket index", () => {
    const svg = buildCostReturnChart(cells, opts);
    // 10,300 * 0.30 = 3,090
    expect(svg).toContain("£3,090");
    expect(svg).toContain("£721");
  });

  it("annotates points with cost, fee drag and trade count", () => {
    const svg = buildCostReturnChart(cells, opts);
    expect(svg).toMatch(/100% cost → .*% net \(fees .*%, \d+ trades\)/);
  });
});

describe("buildBreakevenCurve", () => {
  const points = buildBreakevenCurve(cells, opts);

  it("returns one point per ticket size, in order", () => {
    expect(points.map((p) => p.ticket.label)).toEqual(TICKETS.map((t) => t.label));
  });

  it("shows the fixed commission minimum punishing small tickets", () => {
    // Actual round-trip cost per ticket must fall as the ticket grows.
    const bps = points.map((p) => p.baselineBps);
    expect(bps[0]!).toBeGreaterThan(bps[1]!);
    expect(bps[1]!).toBeGreaterThan(bps[2]!);
  });

  it("marks a ticket viable only when its actual cost sits under the breakeven", () => {
    for (const p of points) {
      if (p.viableAtBaseline) {
        expect(p.breakevenZeroBps).not.toBeNull();
        expect(p.breakevenZeroBps!).toBeGreaterThanOrEqual(p.baselineBps);
      }
    }
  });

  it("finds larger tickets more viable than smaller ones", () => {
    const smallest = points[0]!;
    const largest = points.at(-1)!;
    expect(largest.baselineBps).toBeLessThan(smallest.baselineBps);
    expect(Number(largest.viableAtBaseline)).toBeGreaterThanOrEqual(
      Number(smallest.viableAtBaseline),
    );
  });

  it("reports 'never' rather than a bogus number when nothing works", () => {
    const hopeless = cells.map((c) => ({ ...c, totalReturnPct: -20 }));
    const pts = buildBreakevenCurve(hopeless, opts);
    expect(pts.every((p) => p.breakevenZeroBps === null)).toBe(true);
    expect(pts.every((p) => p.viableAtBaseline === false)).toBe(true);
  });

  it("is deterministic", () => {
    expect(buildBreakevenCurve(cells, opts)).toEqual(buildBreakevenCurve(cells, opts));
  });
});

describe("buildBreakevenChart", () => {
  it("draws the breakeven curves against the actual cost line", () => {
    const svg = buildBreakevenChart(buildBreakevenCurve(cells, opts), {});
    expect(svg).toContain("Breakeven cost vs ticket size");
    expect(svg).toContain("round-trip cost (bps)");
    // actual-cost line is always present, even when a breakeven curve is empty
    expect((svg.match(/<path class="line"/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("still renders the actual-cost line when nothing ever breaks even", () => {
    const hopeless = cells.map((c) => ({ ...c, totalReturnPct: -20 }));
    const svg = buildBreakevenChart(buildBreakevenCurve(hopeless, opts), {});
    expect(svg).not.toContain("no data");
    expect((svg.match(/<path class="line"/g) ?? []).length).toBe(1);
  });
});

describe("buildCostReturnPanels", () => {
  const mixed = [...makeCells("balanced"), ...makeCells("high"), ...makeCells("balanced", "position")];

  it("emits one panel per risk level for the chosen style", () => {
    const panels = buildCostReturnPanels(mixed, opts);
    expect(panels.map((p) => p.heading)).toEqual([
      "balanced risk · swing · cost vs return",
      "high risk · swing · cost vs return",
    ]);
  });

  it("scopes each panel's data to its own risk level and style", () => {
    const panels = buildCostReturnPanels(mixed, { ...opts, style: "position" });
    expect(panels).toHaveLength(1);
    expect(panels[0]!.heading).toContain("position");
  });

  it("carries two charts, a legend and a breakeven table", () => {
    const [panel] = buildCostReturnPanels(cells, opts);
    expect(panel!.charts).toHaveLength(2);
    expect(panel!.legend?.length).toBe(3);
    expect(panel!.table?.columns).toContain("viable now");
    expect(panel!.table?.rows).toHaveLength(TICKETS.length);
  });

  it("names the smallest viable ticket in the subtitle", () => {
    const [panel] = buildCostReturnPanels(cells, opts);
    expect(panel!.subtitle).toMatch(/viable from a £\d+ ticket|no swept ticket size/);
  });

  it("says so plainly when no ticket clears today's costs", () => {
    const hopeless = cells.map((c) => ({ ...c, totalReturnPct: -20 }));
    const [panel] = buildCostReturnPanels(hopeless, opts);
    expect(panel!.subtitle).toContain("no swept ticket size clears");
  });

  it("renders inside the standard report without the equity/drawdown pair", () => {
    const html = renderBacktestReportHtml({
      title: "sweep",
      panels: buildCostReturnPanels(cells, opts),
    });
    expect(html).toContain("Breakeven cost vs ticket size");
    expect(html).toContain("Net return vs ticket size");
    expect(html).not.toContain("Equity curve (% from start)");
    expect(html).toContain("breakeven vs buy &amp; hold");
  });
});
