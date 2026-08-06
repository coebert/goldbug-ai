import { describe, it, expect } from "vitest";
import {
  summariseCostAxes,
  formatTicket,
  formatViableTickets,
  renderCostAxisMatrix,
  describeCostAxisSummary,
  type CostCellEntry,
} from "../cost-axis-summary";

const entry = (o: Partial<CostCellEntry> & Pick<CostCellEntry, "cagrPct">): CostCellEntry => ({
  slippageLabel: "normal 5bps",
  slippageBps: 5,
  minCommission: 3,
  ticketGbp: 2000,
  ...o,
});

describe("summariseCostAxes", () => {
  it("throws on empty input rather than inventing a grid", () => {
    expect(() => summariseCostAxes([])).toThrow(/no entries/);
  });

  it("orders the slippage axis by measured bps, not label text", () => {
    const s = summariseCostAxes([
      entry({ slippageLabel: "stressed 20bps", slippageBps: 20, cagrPct: 1 }),
      entry({ slippageLabel: "tight 2bps", slippageBps: 2, cagrPct: 5 }),
      entry({ slippageLabel: "wide 10bps", slippageBps: 10, cagrPct: 3 }),
    ]);
    expect(s.slippageLabels).toEqual(["tight 2bps", "wide 10bps", "stressed 20bps"]);
  });

  it("builds one cell per slippage x min-fee pair", () => {
    const s = summariseCostAxes([
      entry({ minCommission: 0, cagrPct: 4 }),
      entry({ minCommission: 8, cagrPct: 1 }),
      entry({ slippageLabel: "wide 10bps", slippageBps: 10, minCommission: 0, cagrPct: 2 }),
      entry({ slippageLabel: "wide 10bps", slippageBps: 10, minCommission: 8, cagrPct: -1 }),
    ]);
    expect(s.cells).toHaveLength(4);
    expect(s.minCommissions).toEqual([0, 8]);
  });

  it("marks larger tickets viable and small ones not, at the same cost", () => {
    const s = summariseCostAxes([
      entry({ ticketGbp: 500, cagrPct: -2 }),
      entry({ ticketGbp: 2000, cagrPct: 0.5 }),
      entry({ ticketGbp: 5000, cagrPct: 4 }),
    ]);
    const cell = s.cells[0]!;
    expect(cell.viableTickets).toEqual([2000, 5000]);
    expect(cell.minViableTicketGbp).toBe(2000);
    expect(cell.viableTicketShare).toBeCloseTo(2 / 3);
  });

  it("respects a non-zero viability bar", () => {
    const rows = [entry({ ticketGbp: 2000, cagrPct: 1 }), entry({ ticketGbp: 5000, cagrPct: 4 })];
    expect(summariseCostAxes(rows, { minCagrPct: 3 }).cells[0]!.viableTickets).toEqual([5000]);
  });

  it("counts a ticket viable on its best config by default, mean when asked", () => {
    const rows = [
      entry({ ticketGbp: 2000, cagrPct: 6, id: "a" }),
      entry({ ticketGbp: 2000, cagrPct: -4, id: "b" }),
    ];
    expect(summariseCostAxes(rows).cells[0]!.viableTickets).toEqual([2000]);
    expect(summariseCostAxes(rows, { basis: "mean" }).cells[0]!.viableTickets).toEqual([2000]);
    const skewed = [
      entry({ ticketGbp: 2000, cagrPct: 1, id: "a" }),
      entry({ ticketGbp: 2000, cagrPct: -4, id: "b" }),
    ];
    expect(summariseCostAxes(skewed, { basis: "mean" }).cells[0]!.viableTickets).toEqual([]);
  });

  it("never lets an infeasible configuration make a ticket viable", () => {
    const s = summariseCostAxes([entry({ ticketGbp: 2000, cagrPct: 9, feasible: false })]);
    expect(s.cells[0]!.viableTickets).toEqual([]);
  });

  it("reports the best feasible configuration id per cell", () => {
    const s = summariseCostAxes([
      entry({ cagrPct: 12, feasible: false, id: "leveraged" }),
      entry({ cagrPct: 3, feasible: true, id: "clean" }),
    ]);
    expect(s.cells[0]!.bestId).toBe("clean");
    expect(s.cells[0]!.bestCagrPct).toBe(3);
  });

  it("computes the median CAGR across all configs in the cell", () => {
    const s = summariseCostAxes([
      entry({ ticketGbp: 1000, cagrPct: 1 }),
      entry({ ticketGbp: 2000, cagrPct: 3 }),
      entry({ ticketGbp: 5000, cagrPct: 11 }),
    ]);
    expect(s.cells[0]!.medianCagrPct).toBe(3);
  });

  it("finds the ticket band that survives every cell", () => {
    const s = summariseCostAxes([
      entry({ minCommission: 0, ticketGbp: 1000, cagrPct: 2 }),
      entry({ minCommission: 0, ticketGbp: 5000, cagrPct: 6 }),
      entry({ minCommission: 8, ticketGbp: 1000, cagrPct: -3 }),
      entry({ minCommission: 8, ticketGbp: 5000, cagrPct: 4 }),
    ]);
    expect(s.universallyViableTickets).toEqual([5000]);
    expect(s.neverViableTickets).toEqual([]);
  });

  it("flags ticket sizes that never clear the bar anywhere", () => {
    const s = summariseCostAxes([
      entry({ minCommission: 0, ticketGbp: 250, cagrPct: -5 }),
      entry({ minCommission: 8, ticketGbp: 250, cagrPct: -9 }),
      entry({ minCommission: 0, ticketGbp: 5000, cagrPct: 5 }),
      entry({ minCommission: 8, ticketGbp: 5000, cagrPct: 3 }),
    ]);
    expect(s.neverViableTickets).toEqual([250]);
  });

  it("is deterministic regardless of input order", () => {
    const rows = [
      entry({ minCommission: 8, ticketGbp: 5000, cagrPct: 3 }),
      entry({ minCommission: 0, ticketGbp: 1000, cagrPct: -1 }),
      entry({ slippageLabel: "tight 2bps", slippageBps: 2, ticketGbp: 1000, cagrPct: 2 }),
    ];
    const a = summariseCostAxes(rows);
    const b = summariseCostAxes([...rows].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("formatting", () => {
  it("abbreviates ticket sizes", () => {
    expect(formatTicket(750)).toBe("£750");
    expect(formatTicket(1800)).toBe("£1.8k");
    expect(formatTicket(5000)).toBe("£5k");
  });

  it("collapses a contiguous tail into a '+' band", () => {
    const s = summariseCostAxes([
      entry({ ticketGbp: 500, cagrPct: -1 }),
      entry({ ticketGbp: 2000, cagrPct: 1 }),
      entry({ ticketGbp: 5000, cagrPct: 3 }),
    ]);
    expect(formatViableTickets(s.cells[0]!, s.ticketSizes)).toBe("£2k+");
  });

  it("says 'all' and 'none' at the extremes", () => {
    const all = summariseCostAxes([
      entry({ ticketGbp: 500, cagrPct: 1 }),
      entry({ ticketGbp: 5000, cagrPct: 3 }),
    ]);
    expect(formatViableTickets(all.cells[0]!, all.ticketSizes)).toBe("all");
    const none = summariseCostAxes([entry({ ticketGbp: 500, cagrPct: -1 })]);
    expect(formatViableTickets(none.cells[0]!, none.ticketSizes)).toBe("none");
  });

  it("lists tickets explicitly when the viable set has a hole", () => {
    const s = summariseCostAxes([
      entry({ ticketGbp: 500, cagrPct: 2 }),
      entry({ ticketGbp: 2000, cagrPct: -2 }),
      entry({ ticketGbp: 5000, cagrPct: 2 }),
    ]);
    expect(formatViableTickets(s.cells[0]!, s.ticketSizes)).toBe("£500, £5k");
  });

  it("renders a matrix with one row per slippage level", () => {
    const s = summariseCostAxes([
      entry({ minCommission: 0, ticketGbp: 2000, cagrPct: 2 }),
      entry({ minCommission: 8, ticketGbp: 2000, cagrPct: -2 }),
      entry({ slippageLabel: "tight 2bps", slippageBps: 2, minCommission: 0, ticketGbp: 2000, cagrPct: 4 }),
      entry({ slippageLabel: "tight 2bps", slippageBps: 2, minCommission: 8, ticketGbp: 2000, cagrPct: 1 }),
    ]);
    const lines = renderCostAxisMatrix(s);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("min £0");
    expect(lines[1]).toContain("tight 2bps");
    expect(lines[2]).toContain("none");
  });

  it("describes whether any ticket survives the whole grid", () => {
    const survives = summariseCostAxes([
      entry({ minCommission: 0, ticketGbp: 5000, cagrPct: 5 }),
      entry({ minCommission: 8, ticketGbp: 5000, cagrPct: 2 }),
    ]);
    expect(describeCostAxisSummary(survives)).toContain("£5k");
    const doomed = summariseCostAxes([entry({ ticketGbp: 500, cagrPct: -5 })]);
    expect(describeCostAxisSummary(doomed)).toMatch(/No ticket size/);
  });
});
