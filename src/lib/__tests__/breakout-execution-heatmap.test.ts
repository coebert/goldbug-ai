import { describe, expect, it } from "vitest";
import { buildHeatmap } from "@/lib/breakout-execution-heatmap";
import type { ExecutionCell, ExecutionGrid } from "@/lib/breakout-driver-execution";
import type { RiskLevel } from "@/lib/breakout-driver-actions";
import { DEFAULT_SIZING_LIMITS } from "@/lib/breakout-sizing-limits";

const noLimitReport = {
  limits: DEFAULT_SIZING_LIMITS,
  breaches: { position: 0, concurrency: 0, budget: 0 },
  requestedDeployedPct: 80,
  deployedPct: 80,
  peakConcurrent: 2,
  peakPositionSize: 1,
  summary: "",
};

function cell(risk: RiskLevel, gapWeight: number, ret: number, dd: number): ExecutionCell {
  return {
    risk,
    gapWeight,
    signals: 10,
    taken: 8,
    skipped: 2,
    avgSize: 0.8,
    deployedPct: 80,
    winRatePct: 50,
    avgReturnPct: ret / 10,
    expectancyPct: ret / 10,
    cumulativeReturnPct: ret,
    maxDrawdownPct: dd,
    returnPerUnitPct: ret / 0.8,
    actionCounts: { prioritise: 1, trade: 2, downsize: 1, avoid: 0 },
    limits: noLimitReport,
    vsBaseline: {
      cumulativeReturnPp: 0,
      avgReturnPp: 0,
      maxDrawdownPp: 0,
      deployedPp: 0,
    },
  };
}

const grid: ExecutionGrid = {
  baseline: cell("balanced", 0, 1, 10),
  limits: DEFAULT_SIZING_LIMITS,
  risks: ["conservative", "balanced", "aggressive"],
  gapWeights: [0, 2],
  cells: [
    cell("conservative", 0, 1, 5),
    cell("conservative", 2, 3, 7),
    cell("balanced", 0, 5, 9),
    cell("balanced", 2, 9, 12),
    cell("aggressive", 0, 4, 20),
    cell("aggressive", 2, 7, 25),
  ],
  best: null,
  summary: "",
};

describe("buildHeatmap", () => {
  it("normalises compounded return with higher = better", () => {
    const map = buildHeatmap(grid, "cumulativeReturnPct");
    expect(map.rows).toHaveLength(3);
    expect(map.min).toBe(1);
    expect(map.max).toBe(9);
    expect(map.best?.risk).toBe("balanced");
    expect(map.best?.gapWeight).toBe(2);
    expect(map.best?.intensity).toBe(1);
    expect(map.worst?.risk).toBe("conservative");
    expect(map.worst?.intensity).toBe(0);
  });

  it("inverts the scale for drawdown so lower is better", () => {
    const map = buildHeatmap(grid, "maxDrawdownPct");
    expect(map.best?.value).toBe(5);
    expect(map.best?.risk).toBe("conservative");
    expect(map.worst?.value).toBe(25);
    expect(map.best?.good).toBe(true);
    expect(map.worst?.good).toBe(false);
  });

  it("keeps every risk × gap-weight combination as a cell", () => {
    const map = buildHeatmap(grid, "returnPerUnitPct");
    expect(map.gapWeights).toEqual([0, 2]);
    expect(map.rows.flatMap((r) => r.cells)).toHaveLength(6);
    expect(map.summary).toContain("Best");
  });

  it("handles a flat grid without dividing by zero", () => {
    const flat: ExecutionGrid = {
      ...grid,
      risks: ["balanced"],
      gapWeights: [0, 2],
      cells: [cell("balanced", 0, 2, 3), cell("balanced", 2, 2, 3)],
    };
    const map = buildHeatmap(flat, "cumulativeReturnPct");
    for (const c of map.rows[0].cells) expect(c.intensity).toBe(0.5);
  });

  it("returns an empty map when there are no cells", () => {
    const map = buildHeatmap({ ...grid, risks: [], cells: [] }, "cumulativeReturnPct");
    expect(map.rows).toHaveLength(0);
    expect(map.best).toBeNull();
    expect(map.summary).toContain("No execution cells");
  });
});
