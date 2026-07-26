import { describe, it, expect } from "vitest";
import { buildHedgeReport } from "@/lib/hedging/tail-hedge-report.functions";

const advisory = (over: Record<string, unknown> = {}) => ({
  action: "buy" as const,
  targetPctNav: 0.05,
  targetNotional: 500,
  deltaNotional: 500,
  reason: "risk-off",
  regime: "risk_off" as const,
  ...over,
});

describe("buildHedgeReport", () => {
  it("returns an empty shell when no decisions carry tail_hedge blocks", () => {
    const r = buildHedgeReport("pid", [
      { created_at: "2026-01-01T00:00:00Z", raw: { other: true } },
    ]);
    expect(r.totals.decisions).toBe(0);
    expect(r.series).toEqual([]);
    expect(r.trades).toEqual([]);
    expect(r.phaseAttribution).toEqual([]);
  });

  it("aggregates fills, fees, slippage, and deferrals across decisions", () => {
    const rows = [
      {
        created_at: "2026-01-01T00:00:00Z",
        raw: {
          tail_hedge: advisory(),
          tail_hedge_execution: { applied: true, reason: "buy", symbol: "GLD", qty: 3, notional: 500 },
          tail_hedge_reconciliation: {
            slippage: { notionalDiff: 0, pctOfAdvised: 0, kind: "none" },
            deferralReason: null,
            observed: { qty: 3, price: 166.67, notional: 500, driftVsTarget: 0 },
          },
        },
      },
      {
        created_at: "2026-01-02T00:00:00Z",
        raw: {
          tail_hedge: advisory({ action: "sell", deltaNotional: -200, targetNotional: 300 }),
          tail_hedge_execution: { applied: true, reason: "sell", symbol: "GLD", qty: 1.2, notional: 200 },
          tail_hedge_reconciliation: {
            slippage: { notionalDiff: 0, pctOfAdvised: 0, kind: "none" },
            deferralReason: null,
            observed: { qty: 1.8, price: 166.67, notional: 300, driftVsTarget: 0 },
          },
        },
      },
      {
        created_at: "2026-01-03T00:00:00Z",
        raw: {
          tail_hedge: advisory({ deltaNotional: 400, targetNotional: 700 }),
          tail_hedge_execution: { applied: false, reason: "insufficient cash", symbol: "GLD", qty: 0, notional: 0 },
          tail_hedge_reconciliation: {
            slippage: { notionalDiff: 400, pctOfAdvised: 1, kind: "unfilled" },
            deferralReason: "insufficient_cash",
            observed: { qty: 1.8, price: 166.67, notional: 300, driftVsTarget: -400 },
          },
          phase_attribution: {
            phase6_tail_hedge: { cagrDelta: 0.012, ddDelta: 0.03, winRateDelta: 0.01 },
            phase3_atr_stop: { cagrDelta: 0.004, ddDelta: 0.02, winRateDelta: 0.005 },
          },
        },
      },
    ];

    const r = buildHedgeReport("pid", rows);
    expect(r.totals.decisions).toBe(3);
    expect(r.totals.applied).toBe(2);
    expect(r.totals.deferred).toBe(1);
    expect(r.totals.buyCount).toBe(1);
    expect(r.totals.sellCount).toBe(1);
    expect(r.totals.grossNotional).toBeCloseTo(700, 6);
    expect(r.totals.netNotional).toBeCloseTo(300, 6); // +500 buy − 200 sell
    expect(r.totals.estFees).toBeCloseTo(0.7, 6);      // 700 * 0.001
    expect(r.totals.estSlippage).toBeCloseTo(0.7, 6);
    expect(r.totals.unfilledAdvisedNotional).toBeCloseTo(400, 6);
    expect(r.totals.deferralBreakdown).toEqual({ insufficient_cash: 1 });
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]).toMatchObject({ action: "buy", symbol: "GLD", notional: 500 });
    expect(r.series[2].observedNotional).toBe(300);
    expect(r.phaseAttribution).toHaveLength(2);
    expect(r.phaseAttribution.find((p) => p.phase === "phase6_tail_hedge")).toMatchObject({
      cagrDelta: 0.012, ddDelta: 0.03,
    });
    expect(r.from).toBe("2026-01-01T00:00:00Z");
    expect(r.to).toBe("2026-01-03T00:00:00Z");
  });

  it("ignores hold advisories in deferred count but still records them in the series", () => {
    const r = buildHedgeReport("pid", [
      {
        created_at: "2026-01-01T00:00:00Z",
        raw: {
          tail_hedge: advisory({ action: "hold", deltaNotional: 0, targetNotional: 0 }),
          tail_hedge_execution: { applied: false, reason: "hold", symbol: null, qty: 0, notional: 0 },
          tail_hedge_reconciliation: {
            slippage: { notionalDiff: 0, pctOfAdvised: 0, kind: "none" },
            deferralReason: "hold",
            observed: { qty: 0, price: null, notional: 0, driftVsTarget: 0 },
          },
        },
      },
    ]);
    expect(r.totals.decisions).toBe(1);
    expect(r.totals.applied).toBe(0);
    expect(r.totals.deferred).toBe(0);
    expect(r.totals.deferralBreakdown).toEqual({ hold: 1 });
    expect(r.trades).toEqual([]);
  });
});
