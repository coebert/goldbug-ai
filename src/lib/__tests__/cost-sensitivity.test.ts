import { describe, expect, it } from "vitest";
import {
  axisElasticity,
  buildSensitivityGrid,
  cellMargin,
  DEFAULT_PER_TRADE,
  DEFAULT_SLIPPAGE_BPS,
  dominantCostAxis,
  formatRobustness,
  frictionsAt,
  summariseRobustness,
  toMarginGrid,
  type SensitivityCell,
} from "../cost-sensitivity";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 50,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

/** Synthetic cell whose return decays linearly in both cost axes. */
function cell(
  slippageBps: number,
  perTrade: number,
  opts: { base?: number; slipSlope?: number; feeSlope?: number; benchmark?: number } = {},
): SensitivityCell {
  const base = opts.base ?? 20;
  const ret = base + (opts.slipSlope ?? -1) * slippageBps + (opts.feeSlope ?? -0.5) * perTrade;
  return {
    slippageBps,
    perTrade,
    style: "swing",
    riskLevel: "balanced",
    totalReturnPct: ret,
    benchmarkReturnPct: opts.benchmark ?? 10,
    sharpe: 0.5,
    maxDrawdownPct: -12,
    trades: 100,
    feeDragPct: 1,
  };
}

const gridCells = (opts?: Parameters<typeof cell>[2]) =>
  buildSensitivityGrid([2, 5, 10, 20], [0, 3, 8]).map((p) =>
    cell(p.slippageBps, p.perTrade, opts),
  );

describe("frictionsAt", () => {
  it("overrides only the two swept axes", () => {
    const f = frictionsAt(BASE, { slippageBps: 20, perTrade: 8 });
    expect(f.slippageBps).toBe(20);
    expect(f.minCommission).toBe(8);
    expect(f.commissionBps).toBe(BASE.commissionBps);
    expect(f.buyTaxBps).toBe(BASE.buyTaxBps);
    expect(f.impactPerUnit).toBe(BASE.impactPerUnit);
  });

  it("allows a frictionless corner", () => {
    expect(frictionsAt(BASE, { slippageBps: 0, perTrade: 0 })).toMatchObject({
      slippageBps: 0,
      minCommission: 0,
    });
  });

  it("rejects negative or non-finite inputs", () => {
    expect(() => frictionsAt(BASE, { slippageBps: -1, perTrade: 0 })).toThrow(/slippageBps/);
    expect(() => frictionsAt(BASE, { slippageBps: 5, perTrade: Number.NaN })).toThrow(/perTrade/);
  });
});

describe("buildSensitivityGrid", () => {
  it("is the cartesian product of both axes", () => {
    const g = buildSensitivityGrid([2, 20], [0, 5]);
    expect(g).toEqual([
      { slippageBps: 2, perTrade: 0 },
      { slippageBps: 2, perTrade: 5 },
      { slippageBps: 20, perTrade: 0 },
      { slippageBps: 20, perTrade: 5 },
    ]);
  });

  it("defaults to the 2–20bps × $0–8 grid", () => {
    const g = buildSensitivityGrid();
    expect(g).toHaveLength(DEFAULT_SLIPPAGE_BPS.length * DEFAULT_PER_TRADE.length);
    expect(Math.min(...g.map((p) => p.slippageBps))).toBe(2);
    expect(Math.max(...g.map((p) => p.slippageBps))).toBe(20);
    expect(Math.max(...g.map((p) => p.perTrade))).toBe(8);
  });
});

describe("cellMargin", () => {
  it("uses raw return against zero and excess return against the benchmark", () => {
    const c = cell(5, 0, { base: 20, slipSlope: 0, feeSlope: 0, benchmark: 12 });
    expect(cellMargin(c, "zero")).toBeCloseTo(20);
    expect(cellMargin(c, "benchmark")).toBeCloseTo(8);
  });
});

describe("axisElasticity", () => {
  it("recovers the per-bp slippage slope", () => {
    const e = axisElasticity(gridCells(), "slippageBps");
    expect(e).toBeCloseTo(-1, 6);
  });

  it("recovers the per-dollar commission slope", () => {
    const e = axisElasticity(gridCells(), "perTrade");
    expect(e).toBeCloseTo(-0.5, 6);
  });

  it("is unchanged by a constant benchmark shift", () => {
    const zero = axisElasticity(gridCells(), "slippageBps", "zero");
    const bench = axisElasticity(gridCells(), "slippageBps", "benchmark");
    expect(bench).toBeCloseTo(zero!, 9);
  });

  it("returns null when an axis has no variation", () => {
    const flat = [cell(5, 0), cell(5, 3)];
    expect(axisElasticity(flat, "slippageBps")).toBeNull();
  });
});

describe("summariseRobustness", () => {
  it("marks a strategy that survives every cell as robust", () => {
    const s = summariseRobustness(gridCells({ base: 100 }));
    expect(s.survivalRate).toBe(1);
    expect(s.verdict).toBe("robust");
    expect(s.maxViableSlippageBps).toBe(20);
    expect(s.maxViablePerTrade).toBe(8);
  });

  it("marks a strategy that dies everywhere as broken", () => {
    const s = summariseRobustness(gridCells({ base: -50 }));
    expect(s.survivalRate).toBe(0);
    expect(s.verdict).toBe("breaks");
    expect(s.maxViableSlippageBps).toBeNull();
    expect(s.maxViablePerTrade).toBeNull();
  });

  it("finds the frontier for a partially viable grid", () => {
    // base 12, -1%/bp, -0.5%/$: at $0 fee it survives to 10bps, not 20.
    const s = summariseRobustness(gridCells({ base: 12 }));
    expect(s.verdict).toBe("fragile");
    expect(s.maxViableSlippageBps).toBe(10);
    expect(s.maxViablePerTrade).toBe(8);
    expect(s.bestCell).toMatchObject({ slippageBps: 2, perTrade: 0 });
    expect(s.worstCell).toMatchObject({ slippageBps: 20, perTrade: 8 });
  });

  it("handles an empty grid without throwing", () => {
    const s = summariseRobustness([]);
    expect(s.cells).toBe(0);
    expect(s.survivalRate).toBe(0);
    expect(s.bestCell).toBeNull();
  });
});

describe("dominantCostAxis", () => {
  it("blames slippage when it dominates over the swept ranges", () => {
    const s = summariseRobustness(gridCells({ slipSlope: -1, feeSlope: -0.01 }));
    expect(dominantCostAxis(s, 18, 8)).toBe("slippage");
  });

  it("blames commission when the fixed fee dominates", () => {
    const s = summariseRobustness(gridCells({ slipSlope: -0.01, feeSlope: -5 }));
    expect(dominantCostAxis(s, 18, 8)).toBe("commission");
  });

  it("reports balanced when both axes cost about the same", () => {
    // 18bps × 1 ≈ 8$ × 2.25
    const s = summariseRobustness(gridCells({ slipSlope: -1, feeSlope: -2.25 }));
    expect(dominantCostAxis(s, 18, 8)).toBe("balanced");
  });
});

describe("toMarginGrid", () => {
  it("lays cells out in axis order with holes preserved", () => {
    const cells = [cell(2, 0), cell(20, 5)];
    const g = toMarginGrid(cells, [2, 20], [0, 5]);
    expect(g.map((r) => r.slippageBps)).toEqual([2, 20]);
    expect(g[0]!.margins[1]).toBeNull();
    expect(g[1]!.margins[0]).toBeNull();
    expect(g[0]!.margins[0]).toBeCloseTo(18);
  });
});

describe("formatRobustness", () => {
  it("summarises the verdict, elasticities and frontier", () => {
    const line = formatRobustness(summariseRobustness(gridCells({ base: 12 })));
    expect(line).toContain("fragile");
    expect(line).toContain("%/bp");
    expect(line).toContain("%/$");
    expect(line).toContain("10bps");
  });
});
