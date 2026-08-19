import { describe, expect, it } from "vitest";

import { buildSignalWeightHistory, type SignalWeightRow } from "@/lib/signal-weight-history";

const row = (
  as_of: string,
  model_kind: string,
  effective_weight: number,
  multiplier = 1,
): SignalWeightRow => ({
  as_of,
  model_kind,
  base_weight: effective_weight / multiplier,
  multiplier,
  effective_weight,
  regime: "calm",
  reason: null,
});

describe("buildSignalWeightHistory", () => {
  it("normalises daily weights into shares", () => {
    const h = buildSignalWeightHistory(
      "p",
      [row("2026-08-01", "trend", 3), row("2026-08-01", "carry", 1)],
      30,
    );
    expect(h.points).toHaveLength(1);
    expect(h.points[0]!.shares.trend).toBeCloseTo(0.75);
    expect(h.points[0]!.shares.carry).toBeCloseTo(0.25);
    expect(h.topDriver).toBe("trend");
  });

  it("tracks drift between first and last day and average adaptation", () => {
    const h = buildSignalWeightHistory(
      "p",
      [
        row("2026-08-01", "trend", 1),
        row("2026-08-01", "carry", 3),
        row("2026-08-02", "trend", 3, 1.4),
        row("2026-08-02", "carry", 1, 0.6),
      ],
      30,
    );
    const trend = h.summary.find((s) => s.kind === "trend")!;
    expect(trend.firstShare).toBeCloseTo(0.25);
    expect(trend.lastShare).toBeCloseTo(0.75);
    expect(trend.deltaShare).toBeCloseTo(0.5);
    expect(trend.lastMultiplier).toBeCloseTo(1.4);
    expect(trend.adaptation).toBeCloseTo(0.2); // (|1-1| + |1.4-1|)/2
    expect(trend.days).toBe(2);
  });

  it("clips to the requested window and keeps the latest row per day/kind", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`2026-08-${String(i + 1).padStart(2, "0")}`, "trend", 1),
    );
    rows.push(row("2026-08-10", "trend", 5));
    const h = buildSignalWeightHistory("p", rows, 5);
    expect(h.points).toHaveLength(5);
    expect(h.points[0]!.date).toBe("2026-08-06");
    expect(h.points[4]!.weights.trend).toBe(5);
  });

  it("survives zero total weight and empty input", () => {
    expect(buildSignalWeightHistory("p", [], 30).points).toHaveLength(0);
    const h = buildSignalWeightHistory("p", [row("2026-08-01", "trend", 0)], 30);
    expect(h.points[0]!.shares.trend).toBe(0);
    expect(Number.isNaN(h.summary[0]!.avgShare)).toBe(false);
  });
});
