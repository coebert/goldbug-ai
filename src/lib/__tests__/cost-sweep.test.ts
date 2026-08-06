import { describe, expect, it } from "vitest";
import {
  buildCostScenarios,
  cellScore,
  findBreakevenScale,
  formatBreakeven,
  roundTripCostBps,
  scaleFrictions,
  ticketValue,
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

function cell(scale: number, ret: number, bench = 10): SweepCell {
  return {
    ticket: TICKET,
    scenario: { label: `${scale}`, scale, frictions: scaleFrictions(BASE, scale) },
    style: "swing",
    riskLevel: "balanced",
    totalReturnPct: ret,
    benchmarkReturnPct: bench,
    trades: 100,
    feeDragPct: 10,
    sharpe: 0.1,
    maxDrawdownPct: -10,
  };
}

describe("scaleFrictions", () => {
  it("scales every cost term proportionally", () => {
    expect(scaleFrictions(BASE, 0.5)).toEqual({
      commissionBps: 4,
      minCommission: 1.5,
      buyTaxBps: 0,
      slippageBps: 2.5,
      impactPerUnit: 0.0001,
    });
  });

  it("zero scale is frictionless", () => {
    const f = scaleFrictions(BASE, 0);
    expect(f.commissionBps).toBe(0);
    expect(f.minCommission).toBe(0);
    expect(f.slippageBps).toBe(0);
  });

  it("rejects negative scales", () => {
    expect(() => scaleFrictions(BASE, -1)).toThrow();
  });

  it("omits terms the base model does not define", () => {
    expect(scaleFrictions({ commissionBps: 10 }, 2)).toEqual({ commissionBps: 20 });
  });
});

describe("roundTripCostBps", () => {
  it("is dominated by the fixed minimum on small tickets", () => {
    // £300 ticket: bps commission = £0.24, so the £3 minimum binds.
    const bps = roundTripCostBps(BASE, 300);
    expect(bps).toBeCloseTo((2 * 3 + 2 * 0.15) / 300 * 10_000, 6);
    expect(bps).toBeGreaterThan(200);
  });

  it("falls towards the bps rate as tickets grow", () => {
    const small = roundTripCostBps(BASE, 300);
    const large = roundTripCostBps(BASE, 20_000);
    expect(large).toBeLessThan(small);
    expect(large).toBeCloseTo(2 * 8 + 2 * 5, 6); // minimum no longer binds
  });

  it("adds stamp duty on the buy side only", () => {
    const withTax = roundTripCostBps({ ...BASE, buyTaxBps: 50 }, 20_000);
    expect(withTax).toBeCloseTo(2 * 8 + 2 * 5 + 50, 6);
  });

  it("guards a zero ticket", () => {
    expect(roundTripCostBps(BASE, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("buildCostScenarios", () => {
  it("labels the baseline and derives each scaled model", () => {
    const s = buildCostScenarios(BASE, [0, 0.5, 1]);
    expect(s.map((x) => x.label)).toEqual(["0% cost", "50% cost", "baseline"]);
    expect(s[1]!.frictions.commissionBps).toBe(4);
  });
});

describe("cellScore", () => {
  it("uses absolute return for the zero target", () => {
    expect(cellScore(cell(1, -5, 12), "zero")).toBe(-5);
  });
  it("uses excess return for the benchmark target", () => {
    expect(cellScore(cell(1, 5, 12), "benchmark")).toBe(-7);
  });
});

describe("findBreakevenScale", () => {
  const series = [cell(0, 20), cell(0.25, 10), cell(0.5, -10), cell(1, -30)];

  it("interpolates the crossing between bracketing scales", () => {
    const r = findBreakevenScale(series);
    expect(r.verdict).toBe("interpolated");
    // 10 → -10 across 0.25 → 0.5 ⇒ midpoint 0.375
    expect(r.scale).toBeCloseTo(0.375, 10);
  });

  it("reports bps when a base model and ticket are supplied", () => {
    const r = findBreakevenScale(series, {
      baseFrictions: BASE,
      ticketValue: ticketValue(10_300, TICKET),
    });
    expect(r.roundTripBps).toBeGreaterThan(0);
    expect(r.roundTripBps).toBeLessThan(roundTripCostBps(BASE, ticketValue(10_300, TICKET)));
  });

  it("takes the first (most conservative) crossing", () => {
    const noisy = [cell(0, 20), cell(0.25, -1), cell(0.5, 3), cell(1, -30)];
    expect(findBreakevenScale(noisy).scale).toBeCloseTo(0.25 * (20 / 21), 10);
  });

  it("returns 'never' when no cost level is profitable", () => {
    const r = findBreakevenScale([cell(0, -1), cell(1, -20)]);
    expect(r).toEqual({ scale: null, verdict: "never", roundTripBps: null });
  });

  it("returns 'always' when even full cost is profitable", () => {
    const r = findBreakevenScale([cell(0, 30), cell(1, 12)]);
    expect(r.verdict).toBe("always");
    expect(r.scale).toBe(1);
  });

  it("handles an empty series", () => {
    expect(findBreakevenScale([]).verdict).toBe("never");
  });

  it("is order independent", () => {
    const shuffled = [series[3]!, series[0]!, series[2]!, series[1]!];
    expect(findBreakevenScale(shuffled).scale).toBeCloseTo(0.375, 10);
  });

  it("can solve against the buy-and-hold benchmark instead of zero", () => {
    const vsBench = [cell(0, 20, 10), cell(1, 5, 10)];
    const r = findBreakevenScale(vsBench, { target: "benchmark" });
    expect(r.verdict).toBe("interpolated");
    expect(r.scale).toBeCloseTo(10 / 15, 10);
  });
});

describe("ticketValue / formatBreakeven", () => {
  it("derives notional from the sleeve weight", () => {
    expect(ticketValue(10_300, TICKET)).toBeCloseTo(1854, 6);
  });

  it("formats each verdict", () => {
    expect(formatBreakeven({ scale: null, verdict: "never", roundTripBps: null })).toMatch(/never/);
    expect(formatBreakeven({ scale: 1, verdict: "always", roundTripBps: null })).toMatch(/all swept/);
    expect(formatBreakeven({ scale: 0.4, verdict: "interpolated", roundTripBps: 55 })).toBe(
      "breakeven at 40% of baseline cost (~55 bps round trip)",
    );
  });
});
