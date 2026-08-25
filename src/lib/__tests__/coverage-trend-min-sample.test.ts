import { describe, expect, it } from "vitest";
import { evaluateCoverageTrendAlert } from "@/lib/coverage-trend-alert";
import type { CoverageSeries } from "@/lib/fee-coverage-trend";

function series(days: Array<{ invoiced: number; total: number }>): CoverageSeries {
  const points = days.map((d, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    invoiced: d.invoiced,
    total: d.total,
    coveragePct: d.total > 0 ? Math.round((d.invoiced / d.total) * 1000) / 10 : null,
  }));
  return {
    portfolioId: "p1",
    label: "My Portfolio",
    points,
    latestPct: points[points.length - 1]?.coveragePct ?? null,
    changePct: 0,
    direction: "flat",
  };
}

describe("coverage trend alert — minimum sample", () => {
  it("stays quiet when a single pending fill drags the window to 0%", () => {
    const s = series(Array.from({ length: 21 }, () => ({ invoiced: 0, total: 1 })));
    const alert = evaluateCoverageTrendAlert(s, { windowDays: 7 });
    expect(alert.shouldAlert).toBe(false);
    expect(alert.severity).toBe("info");
    expect(alert.body).toContain("1 gradeable fill");
  });

  it("still alerts critically once the tape is thick enough", () => {
    const s = series(Array.from({ length: 21 }, () => ({ invoiced: 0, total: 12 })));
    const alert = evaluateCoverageTrendAlert(s, { windowDays: 7 });
    expect(alert.shouldAlert).toBe(true);
    expect(alert.severity).toBe("critical");
  });
});
