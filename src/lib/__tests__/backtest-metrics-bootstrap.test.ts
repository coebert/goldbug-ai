import { describe, expect, it } from "vitest";
import {
  bootstrapCIs,
  computeBacktestMetrics,
  computeMaxDrawdown,
  computeSharpe,
  type EquityPoint,
} from "../backtest-metrics";

// A modest, mixed-sign daily return series so both Sharpe and MDD are non-trivial.
const R = [
  0.01, -0.02, 0.015, 0.005, -0.01, 0.02, -0.005, 0.008, -0.015, 0.012,
  0.003, -0.007, 0.011, -0.009, 0.004, 0.006, -0.012, 0.017, -0.003, 0.009,
];

function equityFromReturns(returns: number[], start = 1000): EquityPoint[] {
  let v = start;
  const out: EquityPoint[] = [
    { snapshot_date: "2024-01-01", total_value: v },
  ];
  for (let i = 0; i < returns.length; i++) {
    v = v * (1 + returns[i]);
    const d = new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10);
    out.push({ snapshot_date: d, total_value: v });
  }
  return out;
}

describe("bootstrapCIs", () => {
  it("returns null CIs when there is not enough data to resample", () => {
    expect(bootstrapCIs([])).toMatchObject({ sharpe: null, maxDrawdown: null });
    expect(bootstrapCIs([0.01])).toMatchObject({ sharpe: null, maxDrawdown: null });
  });


  it("is deterministic for a given seed", () => {
    const a = bootstrapCIs(R, { samples: 500, seed: 42 });
    const b = bootstrapCIs(R, { samples: 500, seed: 42 });
    expect(a).toEqual(b);
  });

  it("changes distribution when the seed changes", () => {
    const a = bootstrapCIs(R, { samples: 500, seed: 1 });
    const b = bootstrapCIs(R, { samples: 500, seed: 2 });
    expect(a.sharpe!.median).not.toBe(b.sharpe!.median);
  });

  it("produces low ≤ median ≤ high for both metrics", () => {
    const { sharpe, maxDrawdown } = bootstrapCIs(R, { samples: 800, seed: 7 });
    expect(sharpe!.low).toBeLessThanOrEqual(sharpe!.median);
    expect(sharpe!.median).toBeLessThanOrEqual(sharpe!.high);
    expect(maxDrawdown!.low).toBeLessThanOrEqual(maxDrawdown!.median);
    expect(maxDrawdown!.median).toBeLessThanOrEqual(maxDrawdown!.high);
  });

  it("max drawdown CI bounds are ≤ 0 (drawdown is non-positive)", () => {
    const { maxDrawdown } = bootstrapCIs(R, { samples: 500, seed: 3 });
    expect(maxDrawdown!.high).toBeLessThanOrEqual(0);
    expect(maxDrawdown!.low).toBeLessThanOrEqual(0);
  });

  it("point estimates fall inside a wide bootstrap CI", () => {
    const equity = equityFromReturns(R);
    const pointSharpe = computeSharpe(R);
    const pointMDD = computeMaxDrawdown(equity).pct;
    const { sharpe, maxDrawdown } = bootstrapCIs(R, { samples: 2000, seed: 11 });
    // Point estimates should lie between the min and max of the resample
    // distribution — with 2000 draws this is effectively guaranteed for a
    // resample space this small.
    expect(pointSharpe).toBeGreaterThanOrEqual(sharpe!.low - 1e-9);
    expect(pointSharpe).toBeLessThanOrEqual(sharpe!.high + 1e-9);
    // For MDD the resampled paths differ from the observed path, so we
    // only assert the observed MDD is at least as bad as the CI upper
    // bound (closer to 0) — i.e. the observed value is a plausible draw.
    expect(pointMDD).toBeLessThanOrEqual(maxDrawdown!.high + 1e-9);
  });

  it("attaches sharpeCI and maxDrawdownCI to computeBacktestMetrics output", () => {
    const m = computeBacktestMetrics(equityFromReturns(R), [], 1000);
    expect(m.sharpeCI).not.toBeNull();
    expect(m.maxDrawdownCI).not.toBeNull();
    expect(m.sharpeCI!.samples).toBeGreaterThanOrEqual(100);
    expect(m.maxDrawdownCI!.samples).toBeGreaterThanOrEqual(100);
  });

  it("returns null CIs on empty equity", () => {
    const m = computeBacktestMetrics([], [], 1000);
    expect(m.sharpeCI).toBeNull();
    expect(m.maxDrawdownCI).toBeNull();
  });
});
