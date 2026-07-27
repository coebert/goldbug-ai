import { describe, it, expect } from "vitest";
import {
  estimateSaxoCommission,
  inferSaxoCurrency,
  saxoBreakevenNotional,
  SAXO_FEE_SCHEDULE,
} from "@/lib/saxo-fees";

describe("saxo-fees — currency inference", () => {
  it.each([
    ["VOD.L", "GBP"],
    ["AAPL", "USD"],
    ["BTC-USD", "USD"],
    ["GBPUSD=X", "USD"],
    ["BTCE.DE", "EUR"],
    ["ABTC.SW", "CHF"],
    ["7203.T", "JPY"],
    ["0700.HK", "HKD"],
    ["BHP.AX", "AUD"],
  ])("infers %s -> %s", (sym, ccy) => {
    expect(inferSaxoCurrency(sym)).toBe(ccy);
  });
});

describe("saxo-fees — commission math", () => {
  it("applies the min-commission floor on small UK trades", () => {
    // £100 notional * 8bps = £0.08, floor is £3 → 300bps/side, 600bps round-trip.
    const est = estimateSaxoCommission({ notional: 100, symbol: "VOD.L" });
    expect(est.commission).toBe(3);
    expect(est.minFloorApplied).toBe(true);
    expect(est.perSideBps).toBeCloseTo(300, 1);
    expect(est.roundTripBps).toBeCloseTo(600, 1);
  });

  it("switches to bps rate above the breakeven notional", () => {
    // GBP breakeven = 3 / 0.0008 = £3750. At £10000 bps dominates.
    const est = estimateSaxoCommission({ notional: 10_000, symbol: "ISF.L" });
    expect(est.minFloorApplied).toBe(false);
    expect(est.commission).toBeCloseTo(8, 6);
    expect(est.perSideBps).toBeCloseTo(8, 3);
  });

  it("uses per-venue rates for USD/EUR/CHF listings", () => {
    expect(estimateSaxoCommission({ notional: 100_000, symbol: "AAPL" }).perSideBps)
      .toBeCloseTo(SAXO_FEE_SCHEDULE.USD.rate * 10_000, 3);
    expect(estimateSaxoCommission({ notional: 100_000, symbol: "ABTC.SW" }).perSideBps)
      .toBeCloseTo(SAXO_FEE_SCHEDULE.CHF.rate * 10_000, 3);
    expect(estimateSaxoCommission({ notional: 100_000, symbol: "BTCE.DE" }).perSideBps)
      .toBeCloseTo(SAXO_FEE_SCHEDULE.EUR.rate * 10_000, 3);
  });

  it("falls back to a conservative default for unknown venues", () => {
    const est = estimateSaxoCommission({ notional: 5_000, currency: "XYZ" });
    expect(est.tier.venue).toBe("default");
    expect(est.commission).toBeGreaterThanOrEqual(3);
  });

  it("reports the breakeven notional per currency", () => {
    expect(saxoBreakevenNotional("GBP")).toBeCloseTo(3 / 0.0008, 6);
    expect(saxoBreakevenNotional("USD")).toBeCloseTo(1 / 0.0008, 6);
  });

  it("zero/negative notional returns floor commission and infinite bps", () => {
    const est = estimateSaxoCommission({ notional: 0, symbol: "VOD.L" });
    expect(est.commission).toBe(3);
    expect(est.perSideBps).toBe(Number.POSITIVE_INFINITY);
    expect(est.roundTripBps).toBe(Number.POSITIVE_INFINITY);
  });
});
