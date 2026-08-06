import { describe, expect, it } from "vitest";
import type { FoldMetrics, WalkForwardSummary } from "../walk-forward";
import { summariseWalkForward } from "../walk-forward";
import {
  assessHoldout,
  buildFoldsWithHoldout,
  splitHoldout,
  withHoldout,
  type HoldoutSegmentResult,
} from "../walk-forward-holdout";

const metrics = (over: Partial<FoldMetrics> = {}): FoldMetrics => ({
  totalReturnPct: 3,
  cagrPct: 12,
  maxDrawdownPct: -6,
  sharpe: 1,
  volatilityPct: 10,
  days: 60,
  ...over,
});

const seg = (index: number, over: Partial<FoldMetrics> = {}, bench?: FoldMetrics): HoldoutSegmentResult => ({
  index,
  window: { from: `2025-0${index + 1}-01`, to: `2025-0${index + 1}-28` },
  metrics: metrics(over),
  ...(bench ? { benchmark: bench } : {}),
});

const wf = (oosSharpe: number, oosCagrPct = 12) =>
  ({ oosSharpe, oosCagrPct }) as Pick<WalkForwardSummary, "oosSharpe" | "oosCagrPct">;

describe("splitHoldout", () => {
  it("reserves the tail and tiles it with rolling segments", () => {
    const s = splitHoldout({ from: "2020-01-01", to: "2024-12-31", holdoutDays: 270, segmentDays: 90 });
    expect(s.holdout).toEqual({ from: "2024-04-06", to: "2024-12-31" });
    expect(s.trainable).toEqual({ from: "2020-01-01", to: "2024-04-05" });
    expect(s.segments).toHaveLength(3);
    expect(s.segments[0]!.from).toBe("2024-04-06");
    expect(s.segments[2]!.to).toBe("2024-12-31");
  });

  it("keeps segments contiguous and non-overlapping", () => {
    const s = splitHoldout({ from: "2018-01-01", to: "2024-12-31", holdoutDays: 365, segmentDays: 100 });
    for (let i = 1; i < s.segments.length; i++) {
      const prevEnd = new Date(`${s.segments[i - 1]!.to}T00:00:00Z`).getTime();
      const start = new Date(`${s.segments[i]!.from}T00:00:00Z`).getTime();
      expect(start - prevEnd).toBe(86_400_000);
    }
    expect(s.segments[s.segments.length - 1]!.to).toBe("2024-12-31");
  });

  it("defaults to three segments", () => {
    const s = splitHoldout({ from: "2019-01-01", to: "2024-12-31", holdoutDays: 300 });
    expect(s.segments).toHaveLength(3);
  });

  it("refuses to carve a holdout when too little history would remain", () => {
    const s = splitHoldout({ from: "2024-01-01", to: "2024-12-31", holdoutDays: 300 });
    expect(s.holdout).toBeNull();
    expect(s.trainable).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    expect(s.note).toMatch(/Need/);
  });

  it("handles no holdout requested and empty ranges", () => {
    expect(splitHoldout({ from: "2020-01-01", to: "2024-01-01", holdoutDays: 0 }).holdout).toBeNull();
    expect(splitHoldout({ from: "2024-01-01", to: "2024-01-01", holdoutDays: 90 }).holdout).toBeNull();
  });
});

describe("buildFoldsWithHoldout", () => {
  it("never lets a fold touch the holdout", () => {
    const { folds, split } = buildFoldsWithHoldout({
      from: "2020-01-01",
      to: "2024-12-31",
      trainDays: 365,
      testDays: 90,
      holdoutDays: 270,
    });
    expect(folds.length).toBeGreaterThan(0);
    const cutoff = split.holdout!.from;
    for (const f of folds) {
      expect(f.test.to < cutoff).toBe(true);
      expect(f.train.to < cutoff).toBe(true);
    }
  });

  it("produces fewer folds than the same sweep without a holdout", () => {
    const base = buildFoldsWithHoldout({
      from: "2020-01-01",
      to: "2024-12-31",
      trainDays: 365,
      testDays: 90,
      holdoutDays: 0,
    });
    const held = buildFoldsWithHoldout({
      from: "2020-01-01",
      to: "2024-12-31",
      trainDays: 365,
      testDays: 90,
      holdoutDays: 365,
    });
    expect(held.folds.length).toBeLessThan(base.folds.length);
  });
});

describe("assessHoldout", () => {
  it("confirms a stable holdout", () => {
    const a = assessHoldout([seg(0), seg(1), seg(2)], wf(1));
    expect(a.verdict).toBe("confirmed");
    expect(a.segments).toBe(3);
    expect(a.segmentHitRate).toBe(1);
    expect(a.retention).toBeCloseTo(1, 6);
    expect(a.sharpeDecay).toBeCloseTo(0, 6);
    expect(a.sentence).toMatch(/confirmed/);
  });

  it("flags decay when the holdout keeps less than half the Sharpe", () => {
    const a = assessHoldout([seg(0, { sharpe: 0.4 }), seg(1, { sharpe: 0.4 }), seg(2, { sharpe: 0.4 })], wf(1.5));
    expect(a.verdict).toBe("weakened");
    expect(a.retention!).toBeLessThan(0.5);
    expect(a.reasons.join(" ")).toMatch(/decayed/);
  });

  it("breaks on a negative-Sharpe holdout", () => {
    const a = assessHoldout(
      [seg(0, { sharpe: -0.5, totalReturnPct: -4 }), seg(1, { sharpe: -0.3, totalReturnPct: -2 })],
      wf(1.2),
    );
    expect(a.verdict).toBe("broken");
    expect(a.sentence).toMatch(/Do not deploy/);
  });

  it("breaks on a deep holdout drawdown", () => {
    const a = assessHoldout([seg(0, { maxDrawdownPct: -40 }), seg(1)], wf(1));
    expect(a.verdict).toBe("broken");
    expect(a.maxDrawdownPct).toBe(-40);
  });

  it("compounds returns and measures dispersion", () => {
    const a = assessHoldout([seg(0, { totalReturnPct: 10 }), seg(1, { totalReturnPct: 10 })], wf(1));
    expect(a.totalReturnPct).toBeCloseTo(21, 6);
    const b = assessHoldout([seg(0, { sharpe: 2.5 }), seg(1, { sharpe: -0.5 })], wf(1));
    expect(b.sharpeDispersion).toBeGreaterThan(1);
  });

  it("compares against a benchmark when every segment has one", () => {
    const bench = metrics({ totalReturnPct: 8 });
    const a = assessHoldout([seg(0, {}, bench), seg(1, {}, bench)], wf(1));
    expect(a.benchmarkReturnPct).toBeCloseTo(16.64, 2);
    expect(a.excessReturnPct!).toBeLessThan(0);
    expect(a.verdict).toBe("weakened");
    const noBench = assessHoldout([seg(0), seg(1)], wf(1));
    expect(noBench.benchmarkReturnPct).toBeNull();
    expect(noBench.excessReturnPct).toBeNull();
  });

  it("reports insufficient data below the segment minimum", () => {
    expect(assessHoldout([], wf(1)).verdict).toBe("insufficient");
    const one = assessHoldout([seg(0)], wf(1));
    expect(one.verdict).toBe("insufficient");
    expect(one.segments).toBe(1);
  });

  it("works without a walk-forward baseline", () => {
    const a = assessHoldout([seg(0), seg(1)], null);
    expect(a.retention).toBeNull();
    expect(a.sharpeDecay).toBe(0);
    expect(a.verdict).toBe("confirmed");
  });
});

describe("withHoldout", () => {
  const goodSummary = (): WalkForwardSummary =>
    summariseWalkForward(
      Array.from({ length: 4 }, (_, i) => ({
        fold: {
          index: i,
          train: { from: "2020-01-01", to: "2020-12-31" },
          test: { from: "2021-01-01", to: "2021-03-31" },
        },
        params: { a: 1 },
        inSample: metrics({ sharpe: 1.2 }),
        outOfSample: metrics({ sharpe: 1.1 }),
      })),
    );

  it("keeps a go verdict when the holdout confirms", () => {
    const s = goodSummary();
    expect(s.verdict).toBe("go");
    const out = withHoldout(s, assessHoldout([seg(0, { sharpe: 1.1 }), seg(1, { sharpe: 1.1 })], wf(1.1)));
    expect(out.verdict).toBe("go");
    expect(out.holdout.verdict).toBe("confirmed");
  });

  it("downgrades go to caution when the holdout weakens", () => {
    const out = withHoldout(
      goodSummary(),
      assessHoldout([seg(0, { sharpe: 0.45 }), seg(1, { sharpe: 0.45 })], wf(1.1)),
    );
    expect(out.verdict).toBe("caution");
    expect(out.reasons[0]).toMatch(/weaker than walk-forward/);
  });

  it("vetoes to no-go when the holdout breaks", () => {
    const out = withHoldout(
      goodSummary(),
      assessHoldout([seg(0, { sharpe: -1, totalReturnPct: -5 }), seg(1, { sharpe: -1, totalReturnPct: -5 })], wf(1.1)),
    );
    expect(out.verdict).toBe("no-go");
    expect(out.reasons[0]).toMatch(/broke the walk-forward/);
  });

  it("leaves the verdict alone but notes an inconclusive holdout", () => {
    const s = goodSummary();
    const out = withHoldout(s, assessHoldout([], wf(1.1)));
    expect(out.verdict).toBe(s.verdict);
    expect(out.reasons.join(" ")).toMatch(/not conclusive/);
  });
});
