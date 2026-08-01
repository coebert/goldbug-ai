import { describe, it, expect } from "vitest";
import {
  buildWalkForwardFolds,
  selectBestParams,
  summariseWalkForward,
  stitchOutOfSampleCurve,
  type FoldMetrics,
  type FoldOutcome,
  type WalkForwardFold,
} from "@/lib/walk-forward";

function m(over: Partial<FoldMetrics> = {}): FoldMetrics {
  return {
    totalReturnPct: 5,
    cagrPct: 10,
    maxDrawdownPct: -8,
    sharpe: 1,
    volatilityPct: 12,
    days: 126,
    ...over,
  };
}

function fold(index: number): WalkForwardFold {
  return {
    index,
    train: { from: "2020-01-01", to: "2020-12-31" },
    test: { from: "2021-01-01", to: "2021-06-30" },
  };
}

describe("buildWalkForwardFolds", () => {
  it("produces contiguous, non-overlapping test windows in rolling mode", () => {
    const folds = buildWalkForwardFolds({
      from: "2020-01-01",
      to: "2022-12-31",
      trainDays: 365,
      testDays: 180,
    });
    expect(folds.length).toBeGreaterThan(1);
    for (const f of folds) {
      // test starts the day after training ends
      expect(new Date(f.test.from).getTime() - new Date(f.train.to).getTime()).toBe(86_400_000);
      expect(f.train.to > f.train.from).toBe(true);
      expect(f.test.to > f.test.from).toBe(true);
      expect(f.test.to <= "2022-12-31").toBe(true);
    }
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].test.from > folds[i - 1].test.to).toBe(true);
      // tiling: no gap beyond a single day between consecutive test windows
      const gap =
        (new Date(folds[i].test.from).getTime() - new Date(folds[i - 1].test.to).getTime()) /
        86_400_000;
      expect(gap).toBe(1);
    }
  });

  it("never leaks test data into the training window", () => {
    const folds = buildWalkForwardFolds({
      from: "2015-01-01",
      to: "2020-12-31",
      trainDays: 500,
      testDays: 120,
    });
    for (const f of folds) expect(f.train.to < f.test.from).toBe(true);
  });

  it("grows the training window in anchored mode and keeps the same origin", () => {
    const folds = buildWalkForwardFolds({
      from: "2018-01-01",
      to: "2022-12-31",
      trainDays: 400,
      testDays: 200,
      mode: "anchored",
    });
    expect(folds.length).toBeGreaterThan(1);
    for (const f of folds) expect(f.train.from).toBe("2018-01-01");
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].train.to > folds[i - 1].train.to).toBe(true);
    }
  });

  it("respects the fold cap and rejects impossible ranges", () => {
    expect(
      buildWalkForwardFolds({ from: "2020-01-01", to: "2030-01-01", trainDays: 200, testDays: 100, maxFolds: 3 }),
    ).toHaveLength(3);
    expect(
      buildWalkForwardFolds({ from: "2020-01-01", to: "2020-03-01", trainDays: 365, testDays: 90 }),
    ).toEqual([]);
    expect(buildWalkForwardFolds({ from: "2020-01-01", to: "2019-01-01", trainDays: 10, testDays: 5 })).toEqual([]);
  });
});

describe("selectBestParams", () => {
  const grid = [
    { params: { top_k: 4 }, metrics: m({ sharpe: 0.8, totalReturnPct: 20, maxDrawdownPct: -5 }) },
    { params: { top_k: 6 }, metrics: m({ sharpe: 1.4, totalReturnPct: 12, maxDrawdownPct: -9 }) },
    { params: { top_k: 8 }, metrics: m({ sharpe: 1.4, totalReturnPct: 11, maxDrawdownPct: -4 }) },
  ];

  it("maximises the chosen objective", () => {
    expect(selectBestParams(grid, "return")?.params).toEqual({ top_k: 4 });
    expect(selectBestParams(grid, "sharpe")?.params).toEqual({ top_k: 8 }); // tie broken by drawdown
  });

  it("uses calmar when asked", () => {
    const best = selectBestParams(
      [
        { params: { a: 1 }, metrics: m({ cagrPct: 10, maxDrawdownPct: -20, sharpe: 2 }) },
        { params: { a: 2 }, metrics: m({ cagrPct: 8, maxDrawdownPct: -4, sharpe: 0.1 }) },
      ],
      "calmar",
    );
    expect(best?.params).toEqual({ a: 2 });
  });

  it("returns null with no candidates", () => {
    expect(selectBestParams([])).toBeNull();
  });
});

describe("summariseWalkForward", () => {
  function outcome(over: {
    is?: Partial<FoldMetrics>;
    oos?: Partial<FoldMetrics>;
    bench?: Partial<FoldMetrics> | null;
    params?: unknown;
    index?: number;
  }): FoldOutcome<unknown> {
    return {
      fold: fold(over.index ?? 0),
      params: over.params ?? { top_k: 6 },
      inSample: m(over.is),
      outOfSample: m(over.oos),
      benchmark: over.bench === null ? null : m(over.bench ?? {}),
    };
  }

  it("compounds out-of-sample fold returns", () => {
    const s = summariseWalkForward([
      outcome({ oos: { totalReturnPct: 10 }, index: 0 }),
      outcome({ oos: { totalReturnPct: 10 }, index: 1 }),
      outcome({ oos: { totalReturnPct: 10 }, index: 2 }),
    ]);
    expect(s.oosTotalReturnPct).toBeCloseTo(33.1, 1);
    expect(s.foldHitRate).toBe(1);
    expect(s.folds).toBe(3);
  });

  it("flags over-fitting when in-sample Sharpe collapses out of sample", () => {
    const s = summariseWalkForward([
      outcome({ is: { sharpe: 2.5 }, oos: { sharpe: 0.1, totalReturnPct: 1 }, index: 0 }),
      outcome({ is: { sharpe: 2.5 }, oos: { sharpe: 0.1, totalReturnPct: 1 }, index: 1 }),
      outcome({ is: { sharpe: 2.5 }, oos: { sharpe: 0.1, totalReturnPct: 1 }, index: 2 }),
    ]);
    expect(s.degradation).toBeCloseTo(2.4, 1);
    expect(s.verdict).toBe("no-go");
    expect(s.reasons.join(" ")).toMatch(/over-fitting/i);
  });

  it("rates a consistent, benchmark-beating strategy as go", () => {
    const s = summariseWalkForward([
      outcome({ is: { sharpe: 1.2 }, oos: { sharpe: 1.1, totalReturnPct: 6, maxDrawdownPct: -7 }, index: 0 }),
      outcome({ is: { sharpe: 1.1 }, oos: { sharpe: 1.0, totalReturnPct: 5, maxDrawdownPct: -6 }, index: 1 }),
      outcome({ is: { sharpe: 1.3 }, oos: { sharpe: 1.2, totalReturnPct: 7, maxDrawdownPct: -5 }, index: 2 }),
    ]);
    expect(s.verdict).toBe("go");
    expect(s.excessReturnPct).not.toBeNull();
    expect(s.paramStability).toBe(1);
  });

  it("penalises unstable parameter selection", () => {
    const s = summariseWalkForward([
      outcome({ params: { top_k: 4 }, index: 0 }),
      outcome({ params: { top_k: 6 }, index: 1 }),
      outcome({ params: { top_k: 8 }, index: 2 }),
    ]);
    expect(s.paramStability).toBeCloseTo(1 / 3, 2);
    expect(s.reasons.join(" ")).toMatch(/Parameters changed/);
    expect(s.verdict).not.toBe("go");
  });

  it("returns a no-go with zero folds", () => {
    const s = summariseWalkForward([]);
    expect(s.verdict).toBe("no-go");
    expect(s.folds).toBe(0);
    expect(s.benchmarkReturnPct).toBeNull();
  });

  it("omits benchmark comparison when any fold lacks one", () => {
    const s = summariseWalkForward([
      outcome({ index: 0 }),
      outcome({ index: 1, bench: null }),
    ]);
    expect(s.benchmarkReturnPct).toBeNull();
    expect(s.excessReturnPct).toBeNull();
  });
});

describe("stitchOutOfSampleCurve", () => {
  it("chains folds so each starts where the previous one ended", () => {
    const pts = stitchOutOfSampleCurve(
      [
        {
          index: 1,
          curve: [
            { date: "2021-01-01", value: 200 },
            { date: "2021-02-01", value: 220 },
          ],
        },
        {
          index: 0,
          curve: [
            { date: "2020-01-01", value: 100 },
            { date: "2020-06-01", value: 110 },
          ],
        },
      ],
      1000,
    );
    expect(pts.map((p) => p.date)).toEqual(["2020-01-01", "2020-06-01", "2021-01-01", "2021-02-01"]);
    expect(pts[0].value).toBe(1000);
    expect(pts[1].value).toBeCloseTo(1100, 2);
    // Second fold rebases onto 1100 and adds its own +10%.
    expect(pts[2].value).toBeCloseTo(1100, 2);
    expect(pts[3].value).toBeCloseTo(1210, 2);
  });

  it("skips empty or degenerate folds", () => {
    const pts = stitchOutOfSampleCurve(
      [
        { index: 0, curve: [] },
        { index: 1, curve: [{ date: "2020-01-01", value: 0 }] },
        { index: 2, curve: [{ date: "2020-02-01", value: 50 }, { date: "2020-03-01", value: 55 }] },
      ],
      500,
    );
    expect(pts).toHaveLength(2);
    expect(pts[0].value).toBe(500);
    expect(pts[1].value).toBeCloseTo(550, 2);
  });
});
