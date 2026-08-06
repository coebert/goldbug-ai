import { describe, expect, it } from "vitest";
import {
  applyMinCommission,
  applySlippage,
  breakevenGrid,
  buildCostGrid,
  DEFAULT_SLIPPAGE_SPECS,
  roundTripCostBps,
  scenarioKey,
  seriesBaseFrictions,
  slippageBpsOf,
  type SweepCell,
  type TicketSpec,
} from "../cost-sweep";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKET: TicketSpec = { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 };

describe("slippageBpsOf", () => {
  it("adds spread and adverse move", () => {
    expect(slippageBpsOf({ label: "x", slippageBps: 3, spreadBps: 2 })).toBe(5);
  });
  it("treats a missing spread as zero", () => {
    expect(slippageBpsOf({ label: "x", slippageBps: 7 })).toBe(7);
  });
  it("rejects negative inputs", () => {
    expect(() => slippageBpsOf({ label: "x", slippageBps: -1 })).toThrow();
    expect(() => slippageBpsOf({ label: "x", slippageBps: 1, spreadBps: -2 })).toThrow();
  });
});

describe("applySlippage", () => {
  it("overrides only execution terms", () => {
    const f = applySlippage(BASE, { label: "wide", slippageBps: 6, spreadBps: 4 });
    expect(f.slippageBps).toBe(10);
    expect(f.commissionBps).toBe(8);
    expect(f.minCommission).toBe(3);
    expect(f.impactPerUnit).toBe(0.0002);
  });
  it("overrides impact when the spec supplies one", () => {
    const f = applySlippage(BASE, { label: "flat", slippageBps: 1, impactPerUnit: 0 });
    expect(f.impactPerUnit).toBe(0);
  });
});

describe("applyMinCommission", () => {
  it("sets the fixed minimum and rejects bad values", () => {
    expect(applyMinCommission(BASE, 0).minCommission).toBe(0);
    expect(() => applyMinCommission(BASE, -1)).toThrow();
  });
});

describe("buildCostGrid", () => {
  it("falls back to the scale-only axis", () => {
    const grid = buildCostGrid(BASE, { scales: [0.5, 1] });
    expect(grid).toHaveLength(2);
    expect(grid[1]!.label).toBe("baseline");
    expect(grid[0]!.slippage).toBeUndefined();
  });

  it("produces the full cartesian product with unique keys", () => {
    const grid = buildCostGrid(BASE, {
      scales: [0.5, 1],
      slippage: DEFAULT_SLIPPAGE_SPECS,
      minCommission: [0, 3],
    });
    expect(grid).toHaveLength(2 * 4 * 2);
    expect(new Set(grid.map(scenarioKey)).size).toBe(grid.length);
    expect(new Set(grid.map((g) => g.label)).size).toBe(grid.length);
  });

  it("applies overrides after scaling, so the axes are literal", () => {
    const [cell] = buildCostGrid(BASE, {
      scales: [0.5],
      slippage: [{ label: "20bps", slippageBps: 10, spreadBps: 10 }],
      minCommission: [8],
    });
    // commission halved by the scale, slippage/min-fee exactly as requested
    expect(cell!.frictions.commissionBps).toBe(4);
    expect(cell!.frictions.slippageBps).toBe(20);
    expect(cell!.frictions.minCommission).toBe(8);
  });

  it("keeps slippage untouched by a zero commission scale", () => {
    const [cell] = buildCostGrid(BASE, {
      scales: [0],
      slippage: [{ label: "5bps", slippageBps: 5 }],
    });
    expect(cell!.frictions.commissionBps).toBe(0);
    expect(cell!.frictions.slippageBps).toBe(5);
  });
});

describe("roundTripCostBps with independent slippage", () => {
  it("grows monotonically with the slippage axis at a fixed ticket", () => {
    const bps = DEFAULT_SLIPPAGE_SPECS.map((s) => roundTripCostBps(applySlippage(BASE, s), 1854));
    for (let i = 1; i < bps.length; i++) expect(bps[i]!).toBeGreaterThan(bps[i - 1]!);
  });

  it("shows the minimum fee dominating small tickets", () => {
    const cheap = roundTripCostBps(applyMinCommission(BASE, 0), 300);
    const dear = roundTripCostBps(applyMinCommission(BASE, 8), 300);
    expect(dear - cheap).toBeGreaterThan(400);
  });
});

describe("seriesBaseFrictions", () => {
  it("re-applies the series overrides onto the baseline", () => {
    const [sc] = buildCostGrid(BASE, {
      scales: [1],
      slippage: [{ label: "20bps", slippageBps: 20 }],
      minCommission: [8],
    });
    const f = seriesBaseFrictions(BASE, sc);
    expect(f.slippageBps).toBe(20);
    expect(f.minCommission).toBe(8);
  });
  it("passes the baseline through when nothing was varied", () => {
    expect(seriesBaseFrictions(BASE, undefined)).toEqual(BASE);
  });
});

describe("breakevenGrid", () => {
  const scenarios = buildCostGrid(BASE, {
    scales: [0, 0.5, 1],
    slippage: [
      { label: "tight 2bps", slippageBps: 2 },
      { label: "stressed 20bps", slippageBps: 20 },
    ],
  });

  // Return falls with both the commission scale and the slippage level.
  const cells: SweepCell[] = scenarios.map((scenario) => ({
    ticket: TICKET,
    scenario,
    style: "swing",
    riskLevel: "balanced",
    totalReturnPct: 6 - scenario.scale * 8 - (scenario.slippage!.slippageBps === 20 ? 5 : 0),
    benchmarkReturnPct: 4,
    trades: 100,
    feeDragPct: 1,
    sharpe: 0.5,
    maxDrawdownPct: 10,
  }));

  it("groups one series per slippage level", () => {
    const groups = breakevenGrid(cells, { baseFrictions: BASE, startingCash: 10_300 });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.slippageLabel).sort()).toEqual(["stressed 20bps", "tight 2bps"]);
  });

  it("reports a worse breakeven under stressed execution", () => {
    const groups = breakevenGrid(cells, { baseFrictions: BASE, startingCash: 10_300 });
    const tight = groups.find((g) => g.slippageLabel === "tight 2bps")!;
    const stressed = groups.find((g) => g.slippageLabel === "stressed 20bps")!;
    expect(tight.vsZero.verdict).toBe("interpolated");
    expect(stressed.vsZero.verdict).toBe("never");
    expect(stressed.baselineRoundTripBps).toBeGreaterThan(tight.baselineRoundTripBps);
  });

  it("expresses breakeven bps with the series' own slippage, not a scaled one", () => {
    const groups = breakevenGrid(cells, { baseFrictions: BASE, startingCash: 10_300 });
    const tight = groups.find((g) => g.slippageLabel === "tight 2bps")!;
    // slippage stays at 2bps per side = 4bps round trip regardless of the scale
    expect(tight.vsZero.roundTripBps!).toBeGreaterThanOrEqual(4);
    expect(tight.vsZero.roundTripBps!).toBeLessThan(tight.baselineRoundTripBps);
  });

  it("uses the ticket weight for the notional", () => {
    const [g] = breakevenGrid(cells, { baseFrictions: BASE, startingCash: 10_000 });
    expect(g!.ticketValue).toBeCloseTo(1800, 6);
  });
});
