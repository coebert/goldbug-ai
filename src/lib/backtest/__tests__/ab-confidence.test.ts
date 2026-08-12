import { describe, it, expect } from "vitest";
import { computeAbConfidence, type ArmSeries } from "../ab-confidence";

function curve(days: number, dailyPct: number, start = 10_000) {
  const out: Array<{ date: string; totalValue: number }> = [];
  let v = start;
  for (let i = 0; i < days; i++) {
    out.push({
      date: new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
      totalValue: v,
    });
    v *= 1 + dailyPct;
  }
  return out;
}

function arm(days: number, dailyPct: number, costPerDay: number): ArmSeries {
  const equityCurve = curve(days, dailyPct);
  return {
    equityCurve,
    trades: equityCurve.map((p) => ({ date: p.date, cost: costPerDay })),
  };
}

describe("computeAbConfidence", () => {
  it("flags a persistent saving when batching is cheaper on every bar", () => {
    const r = computeAbConfidence({
      batched: arm(120, 0.0005, 1),
      unbatched: arm(120, 0.0005, 5),
      startingValue: 10_000,
      iterations: 300,
    });
    expect(r.costSavingBps.observed).toBeGreaterThan(0);
    expect(r.costSavingBps.lower).toBeGreaterThan(0);
    expect(r.probCheaperAndNoWorse).toBeGreaterThan(0.8);
    expect(r.verdict).toBe("persistent");
  });

  it("reports not_supported when batching is reliably dearer", () => {
    const r = computeAbConfidence({
      batched: arm(120, 0.0005, 6),
      unbatched: arm(120, 0.0005, 1),
      startingValue: 10_000,
      iterations: 300,
    });
    expect(r.costSavingBps.upper).toBeLessThan(0);
    expect(r.verdict).toBe("not_supported");
  });

  it("marks a cheaper-but-riskier arm when drawdown deteriorates", () => {
    const batched = arm(120, 0.001, 1);
    // Punch a deep hole into the batched path only.
    for (let i = 30; i < 90; i++) batched.equityCurve[i]!.totalValue *= 0.55;
    const r = computeAbConfidence({
      batched,
      unbatched: arm(120, 0.001, 8),
      startingValue: 10_000,
      iterations: 300,
    });
    expect(r.costSavingBps.lower).toBeGreaterThan(0);
    expect(r.drawdownDeltaPct.observed).toBeGreaterThan(0);
    expect(r.verdict).toBe("cheaper_but_riskier");
  });

  it("is inconclusive when the two arms are identical", () => {
    const r = computeAbConfidence({
      batched: arm(120, 0.0004, 3),
      unbatched: arm(120, 0.0004, 3),
      startingValue: 10_000,
      iterations: 300,
    });
    expect(r.costSavingBps.observed).toBeCloseTo(0, 6);
    expect(r.verdict).toBe("inconclusive");
  });

  it("is deterministic for the same seed and bails out on short samples", () => {
    const mk = () =>
      computeAbConfidence({
        batched: arm(80, 0.0006, 2),
        unbatched: arm(80, 0.0003, 4),
        startingValue: 10_000,
        iterations: 250,
        seed: 42,
      });
    expect(mk().costSavingBps.lower).toBe(mk().costSavingBps.lower);

    const tiny = computeAbConfidence({
      batched: arm(4, 0.001, 1),
      unbatched: arm(4, 0.001, 3),
      startingValue: 10_000,
    });
    expect(tiny.iterations).toBe(0);
    expect(tiny.verdict).toBe("inconclusive");
  });
});
