import { describe, expect, it } from "vitest";

import { divergenceTradeDetail, rsiTradeDetail } from "../trade-detail";
import type { RsiTrade } from "../rsi-backtest";
import type { DivergenceTrade } from "../rsi-divergence-backtest";

const rsiTrade: RsiTrade = {
  entryDate: "2026-01-05",
  entryPrice: 100,
  exitDate: "2026-01-15",
  exitPrice: 110,
  netReturn: 0.096,
  bars: 8,
  open: false,
};

const bearish: DivergenceTrade = {
  kind: "bearish",
  pivotDate: "2026-02-01",
  entryDate: "2026-02-04",
  entryPrice: 200,
  exitDate: "2026-02-12",
  exitPrice: 210,
  bars: 6,
  outcome: "failed",
  netReturn: -0.054,
  mfe: 0.01,
  mae: 0.05,
  invalidation: 208,
};

describe("rsiTradeDetail", () => {
  it("recomputes gross return from the executed prices", () => {
    const d = rsiTradeDetail(rsiTrade);
    expect(d.grossReturn).toBeCloseTo(0.1, 6);
    expect(d.netReturn).toBe(0.096);
    expect(d.frictionCost).toBeCloseTo(0.004, 6);
    expect(d.direction).toBe("long");
    expect(d.invalidationStatus).toBe("not_applicable");
  });

  it("flags trades still open at the window end", () => {
    const d = rsiTradeDetail({ ...rsiTrade, open: true });
    expect(d.open).toBe(true);
    expect(d.outcome).toMatch(/open/i);
  });
});

describe("divergenceTradeDetail", () => {
  it("treats bearish setups as shorts and inverts gross return", () => {
    const d = divergenceTradeDetail(bearish);
    expect(d.direction).toBe("short");
    expect(d.grossReturn).toBeCloseTo(-0.05, 6);
    expect(d.frictionCost).toBeCloseTo(0.004, 6);
  });

  it("reports invalidation status and level", () => {
    expect(divergenceTradeDetail(bearish).invalidationStatus).toBe("broken");
    expect(divergenceTradeDetail(bearish).invalidationLevel).toBe(208);
    expect(divergenceTradeDetail({ ...bearish, outcome: "reversal" }).invalidationStatus).toBe(
      "held",
    );
  });

  it("carries the excursion pair through", () => {
    const d = divergenceTradeDetail(bearish);
    expect(d.mfe).toBe(0.01);
    expect(d.mae).toBe(0.05);
  });
});
