import { describe, expect, it } from "vitest";
import { evaluateCoverageTrendAlert, formatCoverageWindow } from "@/lib/coverage-trend-alert";
import type { CoverageSeries } from "@/lib/fee-coverage-trend";

function series(pcts: (number | null)[]): CoverageSeries {
  const points = pcts.map((p, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    coveragePct: p,
    invoiced: p == null ? 0 : Math.round(p / 10),
    total: p == null ? 0 : 10,
  }));
  return {
    portfolioId: "p1",
    label: "P1",
    points,
    latestPct: pcts[pcts.length - 1] ?? null,
    changePct: null,
    direction: "unknown",
  };
}

const flat = (v: number, n: number) => Array.from({ length: n }, () => v);

describe("evaluateCoverageTrendAlert", () => {
  it("stays quiet on healthy, steady coverage", () => {
    const a = evaluateCoverageTrendAlert(series(flat(95, 21)));
    expect(a.shouldAlert).toBe(false);
    expect(a.recentPct).toBe(95);
  });

  it("alerts when the last 7 days sit below the floor", () => {
    const a = evaluateCoverageTrendAlert(series([...flat(95, 14), ...flat(50, 7)]));
    expect(a.shouldAlert).toBe(true);
    expect(a.reason).toBe("below_floor");
    expect(a.severity).toBe("warning");
    expect(a.recentPct).toBe(50);
  });

  it("alerts on two consecutive deteriorating windows even above the floor", () => {
    const a = evaluateCoverageTrendAlert(
      series([...flat(99, 7), ...flat(90, 7), ...flat(80, 7)]),
    );
    expect(a.shouldAlert).toBe(true);
    expect(a.reason).toBe("deteriorating");
    expect(a.earlierPct).toBe(99);
    expect(a.priorPct).toBe(90);
    expect(a.recentPct).toBe(80);
  });

  it("does not alert on a single bad window followed by recovery", () => {
    const a = evaluateCoverageTrendAlert(
      series([...flat(99, 7), ...flat(85, 7), ...flat(97, 7)]),
    );
    expect(a.shouldAlert).toBe(false);
  });

  it("ignores small wobbles inside the noise band", () => {
    const a = evaluateCoverageTrendAlert(
      series([...flat(95, 7), ...flat(93, 7), ...flat(91, 7)]),
    );
    expect(a.shouldAlert).toBe(false);
  });

  it("is quiet when there is nothing gradeable in the recent window", () => {
    const a = evaluateCoverageTrendAlert(series([...flat(95, 14), null, null, null, null, null, null, null]));
    expect(a.shouldAlert).toBe(false);
    expect(a.recentPct).toBeNull();
  });

  it("needs at least three graded days before judging a window", () => {
    const a = evaluateCoverageTrendAlert(series([null, null, null, null, null, 40, 40]));
    expect(a.shouldAlert).toBe(false);
  });

  it("flags a low floor without history as below_floor only", () => {
    const a = evaluateCoverageTrendAlert(series(flat(40, 7)));
    expect(a.shouldAlert).toBe(true);
    expect(a.reason).toBe("below_floor");
  });

  it("respects custom thresholds", () => {
    const a = evaluateCoverageTrendAlert(series(flat(75, 21)), { floorPct: 90 });
    expect(a.shouldAlert).toBe(true);
    expect(a.reason).toBe("below_floor");
  });
});

describe("coverage window summaries", () => {
  it("reports the dates and graded-day counts of the last two windows", () => {
    const a = evaluateCoverageTrendAlert(
      series([...flat(99, 7), ...flat(90, 7), ...flat(80, 7)]),
    );
    const [recent, prior] = a.windows;
    expect(recent.index).toBe(0);
    expect(recent.startDate).toBe("2026-07-15");
    expect(recent.endDate).toBe("2026-07-21");
    expect(recent.coveragePct).toBe(80);
    expect(recent.gradedDays).toBe(7);
    expect(prior.startDate).toBe("2026-07-08");
    expect(prior.endDate).toBe("2026-07-14");
    expect(prior.coveragePct).toBe(90);
  });

  it("formats a window as a readable date range", () => {
    const [recent] = evaluateCoverageTrendAlert(series(flat(40, 14))).windows;
    expect(formatCoverageWindow(recent)).toBe("08 Jul – 14 Jul");
  });

  it("still returns two windows when history is short", () => {
    const a = evaluateCoverageTrendAlert(series(flat(40, 7)));
    expect(a.windows).toHaveLength(2);
    expect(a.windows[1].coveragePct).toBeNull();
  });
});

describe("severity ladder", () => {
  const flatN = (v: number, n: number) => Array.from({ length: n }, () => v);

  it("grades a shallow shortfall as warning with the gap in points", () => {
    const a = evaluateCoverageTrendAlert(series([...flatN(95, 14), ...flatN(60, 7)]));
    expect(a.severity).toBe("warning");
    expect(a.gapPct).toBe(10);
    expect(a.title).toBe("Broker charge coverage below floor");
  });

  it("grades a deep shortfall as critical", () => {
    const a = evaluateCoverageTrendAlert(series([...flatN(95, 14), ...flatN(30, 7)]));
    expect(a.severity).toBe("critical");
    expect(a.gapPct).toBe(40);
    expect(a.title).toMatch(/critically low/);
    expect(a.body).toMatch(/40 points below the floor/);
  });

  it("grades below-floor-and-still-falling as critical even when shallow", () => {
    const a = evaluateCoverageTrendAlert(
      series([...flatN(80, 7), ...flatN(72, 7), ...flatN(64, 7)]),
    );
    expect(a.reason).toBe("both");
    expect(a.severity).toBe("critical");
    expect(a.body).toMatch(/still falling/);
  });

  it("keeps a gentle above-floor slide at info", () => {
    const a = evaluateCoverageTrendAlert(series([...flatN(99, 7), ...flatN(90, 7), ...flatN(85, 7)]));
    expect(a.shouldAlert).toBe(true);
    expect(a.severity).toBe("info");
    expect(a.gapPct).toBeNull();
  });

  it("escalates a steep above-floor slide to warning", () => {
    const a = evaluateCoverageTrendAlert(series([...flatN(99, 7), ...flatN(88, 7), ...flatN(75, 7)]));
    expect(a.severity).toBe("warning");
  });

  it("respects a custom critical gap threshold", () => {
    const a = evaluateCoverageTrendAlert(series([...flatN(95, 14), ...flatN(60, 7)]), {
      criticalGapPct: 5,
    });
    expect(a.severity).toBe("critical");
  });
});
