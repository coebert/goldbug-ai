import { describe, it, expect } from "vitest";
import {
  FRICTION_LADDER,
  parseFrictionLadder,
  makeFrictionCostFn,
  applyFrictionToShocks,
  summariseFrictionSensitivity,
  frictionCostDrag,
  formatFrictionSensitivity,
  type ArmMetricRow,
} from "../execution-friction-scenarios";
import { calibrateSymbolExecution } from "../execution-calibration-from-bars";

const bars = Array.from({ length: 90 }, (_, i) => ({
  date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
  close: 100 + Math.sin(i / 5) * 3,
  high: 101 + Math.sin(i / 5) * 3,
  low: 99 + Math.sin(i / 5) * 3,
  volume: 500_000,
}));
const calib = calibrateSymbolExecution({ symbol: "AAPL", bars });
const calibs = new Map([["AAPL", calib]]);

describe("friction ladder parsing", () => {
  it("defaults to the full ladder", () => {
    expect(parseFrictionLadder("").map((s) => s.label))
      .toEqual(FRICTION_LADDER.map((s) => s.label));
  });

  it("selects and dedupes requested scenarios", () => {
    expect(parseFrictionLadder("punitive,calibrated,punitive").map((s) => s.label))
      .toEqual(["punitive", "calibrated"]);
  });

  it("throws on an unknown scenario rather than silently skipping", () => {
    expect(() => parseFrictionLadder("cheap")).toThrow(/Unknown friction scenario/);
  });
});

describe("friction cost function", () => {
  const ladder = Object.fromEntries(FRICTION_LADDER.map((s) => [s.label, s]));

  it("charges nothing in the frictionless world", () => {
    const fn = makeFrictionCostFn(calibs, calib, ladder["frictionless"]!);
    expect(fn("AAPL", 10_000, 1)).toBe(0);
  });

  it("is monotonically more expensive up the ladder", () => {
    const costs = FRICTION_LADDER.map(
      (s) => makeFrictionCostFn(calibs, calib, s)("AAPL", 10_000, 1),
    );
    for (let i = 1; i < costs.length; i++) expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
  });

  it("compounds a stressed slippage draw with a harsh scenario", () => {
    const fn = makeFrictionCostFn(calibs, calib, ladder["punitive"]!);
    expect(fn("AAPL", 10_000, 3)).toBeGreaterThan(fn("AAPL", 10_000, 1));
  });

  it("falls back for unknown symbols and returns zero on zero notional", () => {
    const fn = makeFrictionCostFn(new Map(), calib, ladder["calibrated"]!);
    expect(fn("NOPE", 10_000, 1)).toBeGreaterThan(0);
    expect(fn("NOPE", 0, 1)).toBe(0);
  });
});

describe("shock overlay", () => {
  it("scales sigma and never lets the stress multiplier drop below 1", () => {
    const cfg = { slippageSigma: 0.4, stressSlippageMult: 1.5 };
    const punitive = applyFrictionToShocks(cfg, FRICTION_LADDER[3]!);
    expect(punitive.slippageSigma).toBeCloseTo(0.8, 10);
    expect(punitive.stressSlippageMult).toBeGreaterThan(1.5);
    const none = applyFrictionToShocks(cfg, FRICTION_LADDER[0]!);
    expect(none.slippageSigma).toBe(0);
    expect(none.stressSlippageMult).toBeGreaterThanOrEqual(1);
  });
});

describe("sensitivity verdict", () => {
  const rows = (spread: number): ArmMetricRow[] => [
    { arm: "fixed-global", medianReturnPct: 4, worstDrawdownPct: -20, condCvarPct: -6, costPerPath: 900 },
    { arm: "calib-contagion", medianReturnPct: 4 + spread, worstDrawdownPct: -20, condCvarPct: -6, costPerPath: 950 },
  ];

  it("reports insensitivity when arms agree within tolerance", () => {
    const s = summariseFrictionSensitivity("calibrated", rows(0.3), 1);
    expect(s.tailInsensitive).toBe(true);
    expect(s.returnSpreadPp).toBeCloseTo(0.3, 10);
    expect(s.bestArm).toBe("calib-contagion");
    expect(s.worstArm).toBe("fixed-global");
  });

  it("flags coupling as material once a gap exceeds tolerance", () => {
    expect(summariseFrictionSensitivity("punitive", rows(3), 1).tailInsensitive).toBe(false);
  });

  it("handles an empty arm table without throwing", () => {
    const s = summariseFrictionSensitivity("calibrated", [], 1);
    expect(s.bestArm).toBe("n/a");
    expect(s.returnSpreadPp).toBe(0);
  });

  it("renders a table with one line per scenario", () => {
    const out = formatFrictionSensitivity([
      summariseFrictionSensitivity("calibrated", rows(0.1), 1),
      summariseFrictionSensitivity("punitive", rows(4), 1),
    ]);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toContain("COUPLING MATTERS");
  });
});

describe("cost drag", () => {
  it("measures return given up against the frictionless baseline", () => {
    const drag = frictionCostDrag([
      { scenario: "frictionless", medianReturnPct: 10, meanCostPerPath: 0 },
      { scenario: "calibrated", medianReturnPct: 7, meanCostPerPath: 800 },
      { scenario: "punitive", medianReturnPct: 1, meanCostPerPath: 3000 },
    ]);
    expect(drag[1]).toMatchObject({ returnGivenUpPp: 3, extraCost: 800 });
    expect(drag[2]).toMatchObject({ returnGivenUpPp: 9, extraCost: 3000 });
  });
});
