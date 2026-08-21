import { describe, expect, it } from "vitest";
import {
  adverseBps,
  computeReconMetrics,
  strandedQuantity,
  type ReconObservation,
} from "../recon-metrics";
import { observationFromNotification } from "../recon-metrics.server";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const DAY = 86400_000;

function obs(p: Partial<ReconObservation> & { at: string }): ReconObservation {
  return {
    code: "dropped_leg",
    severity: "critical",
    symbol: "MKS",
    side: "sell",
    intendedQuantity: 100,
    executedQuantity: 0,
    priceDeviationBps: null,
    ...p,
  };
}

describe("adverseBps", () => {
  it("only counts deviations that went against the intent", () => {
    expect(adverseBps({ side: "buy", priceDeviationBps: 120 })).toBe(120);
    expect(adverseBps({ side: "buy", priceDeviationBps: -120 })).toBe(0);
    expect(adverseBps({ side: "sell", priceDeviationBps: -80 })).toBe(80);
    expect(adverseBps({ side: "sell", priceDeviationBps: 80 })).toBe(0);
    expect(adverseBps({ side: "sell", priceDeviationBps: null })).toBe(0);
  });
});

describe("strandedQuantity", () => {
  it("counts only exits that failed to leave the book", () => {
    expect(strandedQuantity(obs({ at: "x" }))).toBe(100);
    expect(
      strandedQuantity(obs({ at: "x", code: "quantity_short", executedQuantity: 60 })),
    ).toBe(40);
    expect(strandedQuantity(obs({ at: "x", side: "buy" }))).toBe(0);
    expect(strandedQuantity(obs({ at: "x", code: "quantity_over" }))).toBe(0);
    expect(
      strandedQuantity(obs({ at: "x", code: "quantity_short", executedQuantity: 100 })),
    ).toBe(0);
  });
});

describe("computeReconMetrics", () => {
  it("buckets by day and totals dropped legs, strandings and adverse prints", () => {
    const summary = computeReconMetrics({
      nowMs: NOW,
      windowDays: 7,
      observations: [
        obs({ at: new Date(NOW - 2 * DAY).toISOString() }),
        obs({
          at: new Date(NOW - 1 * DAY).toISOString(),
          code: "quantity_short",
          severity: "warning",
          executedQuantity: 25,
        }),
        obs({
          at: new Date(NOW - 3600_000).toISOString(),
          code: "price_deviation",
          severity: "warning",
          side: "buy",
          executedQuantity: 100,
          priceDeviationBps: 300,
        }),
      ],
    });

    expect(summary.buckets).toHaveLength(7);
    expect(summary.totals.discrepancies).toBe(3);
    expect(summary.totals.droppedLegs).toBe(1);
    expect(summary.totals.strandedNearMisses).toBe(2);
    expect(summary.totals.strandedQuantity).toBe(175);
    expect(summary.totals.adversePrints).toBe(1);
    expect(summary.totals.worstAdverseBps).toBe(300);
  });

  it("ignores observations outside the window", () => {
    const summary = computeReconMetrics({
      nowMs: NOW,
      windowDays: 3,
      observations: [obs({ at: new Date(NOW - 30 * DAY).toISOString() })],
    });
    expect(summary.totals.discrepancies).toBe(0);
    expect(summary.alerts).toHaveLength(0);
  });

  it("raises a dropped-leg spike and stranded-inventory alert on the latest bucket", () => {
    const summary = computeReconMetrics({
      nowMs: NOW,
      windowDays: 7,
      observations: [
        obs({ at: new Date(NOW - 3600_000).toISOString() }),
        obs({ at: new Date(NOW - 7200_000).toISOString(), symbol: "AAPL" }),
      ],
    });
    const codes = summary.alerts.map((a) => a.code);
    expect(codes).toContain("dropped_leg_spike");
    expect(codes).toContain("stranded_inventory");
    expect(summary.trend.droppedLegsLatest).toBe(2);
  });

  it("flags adverse print drag only past the print-count and bps thresholds", () => {
    const prints = [200, 240, 180].map((bps, i) =>
      obs({
        at: new Date(NOW - (i + 1) * 3600_000).toISOString(),
        code: "price_deviation",
        severity: "warning",
        side: "buy",
        executedQuantity: 100,
        priceDeviationBps: bps,
      }),
    );
    const withDrag = computeReconMetrics({ nowMs: NOW, windowDays: 7, observations: prints });
    expect(withDrag.alerts.map((a) => a.code)).toContain("adverse_print_drag");

    const tooFew = computeReconMetrics({
      nowMs: NOW,
      windowDays: 7,
      observations: prints.slice(0, 2),
    });
    expect(tooFew.alerts.map((a) => a.code)).not.toContain("adverse_print_drag");

    const favourable = computeReconMetrics({
      nowMs: NOW,
      windowDays: 7,
      observations: prints.map((p) => ({ ...p, priceDeviationBps: -300 })),
    });
    expect(favourable.totals.adversePrints).toBe(0);
    expect(favourable.alerts.map((a) => a.code)).not.toContain("adverse_print_drag");
  });

  it("detects a regression against the earlier baseline", () => {
    const baseline = [3, 4, 5, 6].map((d) =>
      obs({
        at: new Date(NOW - d * DAY).toISOString(),
        code: "phantom_leg",
        severity: "warning",
        side: "buy",
      }),
    );
    const spike = [1, 2, 3, 4, 5].map((h) =>
      obs({
        at: new Date(NOW - h * 3600_000).toISOString(),
        code: "phantom_leg",
        severity: "warning",
        side: "buy",
      }),
    );
    const summary = computeReconMetrics({
      nowMs: NOW,
      windowDays: 7,
      observations: [...baseline, ...spike],
    });
    expect(summary.alerts.map((a) => a.code)).toContain("recon_regression");
  });

  it("stays quiet on a clean window", () => {
    const summary = computeReconMetrics({ nowMs: NOW, windowDays: 14, observations: [] });
    expect(summary.alerts).toEqual([]);
    expect(summary.totals.discrepancies).toBe(0);
  });
});

describe("observationFromNotification", () => {
  it("maps a stored trade_leg_recon notification", () => {
    const o = observationFromNotification({
      created_at: "2026-08-21T09:00:00Z",
      severity: "critical",
      details: {
        code: "quantity_short",
        symbol: "MKS.L",
        side: "sell",
        intended_quantity: 500,
        executed_quantity: 120,
        price_deviation_bps: -40,
        occurrences: 3,
      },
    });
    expect(o).toMatchObject({
      code: "quantity_short",
      side: "sell",
      intendedQuantity: 500,
      executedQuantity: 120,
      occurrences: 3,
    });
  });

  it("rejects rows that are not leg discrepancies", () => {
    expect(
      observationFromNotification({ created_at: "x", details: { code: "nonsense" } }),
    ).toBeNull();
    expect(observationFromNotification({ created_at: "x", details: null })).toBeNull();
  });
});
