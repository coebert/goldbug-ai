import { describe, expect, it } from "vitest";
import {
  addMonths,
  planFolds,
  shiftDays,
  slicePrices,
  runNudgeWalkForward,
} from "../insider-nudge-oos";
import type { Candlelike, ReplayEvent } from "../insider-nudge-replay";

function tape(symbol: string, days: number, drift: number, seed = 1): Candlelike[] {
  const out: Candlelike[] = [];
  let px = 100;
  let a = seed;
  const start = Date.parse("2024-01-01T00:00:00Z");
  for (let i = 0; i < days; i++) {
    a = (a * 1103515245 + 12345) % 2147483648;
    const noise = (a / 2147483648 - 0.5) * 0.02;
    px = Math.max(1, px * (1 + drift + noise));
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      close: Number(px.toFixed(4)),
    });
  }
  void symbol;
  return out;
}

describe("date helpers", () => {
  it("adds months and shifts days", () => {
    expect(addMonths("2024-01-31", 1)).toBe("2024-03-02");
    expect(addMonths("2024-01-15", 3)).toBe("2024-04-15");
    expect(shiftDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("slices tapes inclusively and drops empty symbols", () => {
    const prices = new Map<string, Candlelike[]>([
      ["A", tape("A", 40, 0.001)],
      ["B", [{ date: "2020-01-01", close: 10 }]],
    ]);
    const cut = slicePrices(prices, "2024-01-10", "2024-01-20");
    expect(cut.has("B")).toBe(false);
    const a = cut.get("A")!;
    expect(a[0]!.date).toBe("2024-01-10");
    expect(a[a.length - 1]!.date).toBe("2024-01-20");
  });
});

describe("planFolds", () => {
  it("produces non-overlapping test windows that roll forward", () => {
    const folds = planFolds("2024-01-01", "2025-06-30", { trainMonths: 6, testMonths: 3 });
    expect(folds.length).toBeGreaterThanOrEqual(3);
    expect(folds[0]!.trainFrom).toBe("2024-01-01");
    expect(folds[0]!.testFrom > folds[0]!.trainTo).toBe(true);
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i]!.testFrom > folds[i - 1]!.testTo).toBe(true);
      expect(folds[i]!.trainFrom > folds[i - 1]!.trainFrom).toBe(true);
    }
    expect(folds[folds.length - 1]!.testTo <= "2025-06-30").toBe(true);
  });

  it("returns nothing when there is not enough tape", () => {
    expect(planFolds("2024-01-01", "2024-04-01", { trainMonths: 9, testMonths: 3 })).toHaveLength(0);
  });
});

describe("runNudgeWalkForward", () => {
  const prices = new Map<string, Candlelike[]>([
    ["AAA.L", tape("AAA.L", 620, 0.0008, 7)],
    ["BBB.L", tape("BBB.L", 620, 0.0003, 99)],
  ]);
  const events: ReplayEvent[] = [
    {
      symbol: "AAA.L",
      date: "2024-06-10",
      direction: "sell",
      flavour: "discretionary",
      role: "ceo",
      value: 2_000_000,
    },
    {
      symbol: "BBB.L",
      date: "2025-01-14",
      direction: "sell",
      flavour: "discretionary",
      role: "cfo",
      value: 900_000,
    },
  ];

  it("evaluates only out-of-sample windows and reports per-fold picks", () => {
    const r = runNudgeWalkForward({
      prices,
      events,
      options: { trainMonths: 6, testMonths: 3, scaleGrid: [0, 1, 2] },
    });
    expect(r.folds.length).toBeGreaterThanOrEqual(2);
    for (const f of r.folds) {
      expect([0, 1, 2]).toContain(f.chosenScale);
      expect(f.testFrom > f.trainTo).toBe(true);
    }
    // Stitched curve stays inside the evaluation windows.
    const inWindow = r.baseline.curve.every((p) =>
      r.folds.some((f) => p.date >= f.testFrom && p.date <= f.testTo),
    );
    expect(inWindow).toBe(true);
    expect(r.baseline.curve.length).toBe(r.nudged.curve.length);
    expect(r.foldWinRate).toBeGreaterThanOrEqual(0);
    expect(r.foldWinRate).toBeLessThanOrEqual(1);
    expect(["helps", "neutral", "hurts", "insufficient"]).toContain(r.verdict);
    expect(r.summary).toContain("out-of-sample");
  });

  it("is deterministic for the same inputs", () => {
    const opts = { trainMonths: 6, testMonths: 3, scaleGrid: [0, 1] };
    const a = runNudgeWalkForward({ prices, events, options: opts });
    const b = runNudgeWalkForward({ prices, events, options: opts });
    expect(b.nudged.totalReturnPct).toBe(a.nudged.totalReturnPct);
    expect(b.folds.map((f) => f.chosenScale)).toEqual(a.folds.map((f) => f.chosenScale));
  });

  it("collapses to the baseline when training only ever sees a zero grid", () => {
    const r = runNudgeWalkForward({
      prices,
      events,
      options: { trainMonths: 6, testMonths: 3, scaleGrid: [0] },
    });
    expect(r.nonZeroScaleFolds).toBe(0);
    expect(r.delta.returnPct).toBeCloseTo(0, 6);
  });

  it("flags insufficient history rather than inventing folds", () => {
    const short = new Map<string, Candlelike[]>([["AAA.L", tape("AAA.L", 120, 0.001)]]);
    const r = runNudgeWalkForward({ prices: short, events: [], options: { trainMonths: 9, testMonths: 3 } });
    expect(r.verdict).toBe("insufficient");
    expect(r.folds).toHaveLength(0);
    expect(r.baseline.totalReturnPct).toBe(0);
  });
});
