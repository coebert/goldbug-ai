import { describe, it, expect } from "vitest";
import {
  computeCommission,
  commissionBreakevenNotional,
  SCALING_COMMISSION_MODEL,
} from "../commission-model";
import { simulateBrokerExecution } from "../broker-simulator";

describe("computeCommission — scaling with notional", () => {
  it("applies the min floor on tiny LSE tickets", () => {
    const c = computeCommission({ notional: 200, symbol: "VOD.L" });
    expect(c.commission).toBe(3);
    expect(c.minFloorApplied).toBe(true);
    expect(c.bps).toBeCloseTo(150, 6);
  });

  it("uses the ad-valorem rate once notional clears the floor", () => {
    const c = computeCommission({ notional: 4_000, symbol: "VOD.L" });
    expect(c.commission).toBeCloseTo(3.2, 10);
    expect(c.minFloorApplied).toBe(false);
  });

  it("steps the rate down as notional grows", () => {
    const bpsAt = (n: number) => computeCommission({ notional: n, symbol: "VOD.L" }).tier.bps;
    expect(bpsAt(1_000)).toBe(8);
    expect(bpsAt(10_000)).toBe(6);
    expect(bpsAt(30_000)).toBe(4);
    expect(bpsAt(200_000)).toBe(3);
  });

  it("effective bps is monotonically non-increasing in notional", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const n of [100, 500, 1_000, 5_000, 25_000, 100_000, 500_000]) {
      const { bps } = computeCommission({ notional: n, symbol: "VOD.L" });
      expect(bps).toBeLessThanOrEqual(prev + 1e-9);
      prev = bps;
    }
  });

  it("caps the commission on very large tickets", () => {
    const c = computeCommission({ notional: 5_000_000, symbol: "VOD.L" });
    expect(c.capApplied).toBe(true);
    expect(c.commission).toBe(120);
  });
});

describe("computeCommission — per-unit and venue variation", () => {
  it("charges US listings per share, not per notional", () => {
    const c = computeCommission({ notional: 5_000, quantity: 100, symbol: "AAPL" });
    expect(c.perUnit).toBeCloseTo(2, 10);
    expect(c.adValorem).toBe(0);
    expect(c.commission).toBeCloseTo(2, 10);
  });

  it("same notional costs more when split across more shares", () => {
    const few = computeCommission({ notional: 10_000, quantity: 40, symbol: "AAPL" });
    const many = computeCommission({ notional: 10_000, quantity: 2_000, symbol: "AAPL" });
    expect(many.commission).toBeGreaterThan(few.commission);
  });

  it("differs across venues for identical tickets", () => {
    const lse = computeCommission({ notional: 20_000, quantity: 100, symbol: "VOD.L" });
    const six = computeCommission({ notional: 20_000, quantity: 100, symbol: "NESN.SW" });
    expect(six.commission).toBeGreaterThan(lse.commission);
    expect(lse.venue).toBe("LSE");
    expect(six.venue).toBe("SIX");
  });

  it("uses the crypto override when asset class is crypto", () => {
    const c = computeCommission({ notional: 5_000, symbol: "BTC-USD", assetClass: "crypto" });
    expect(c.venue).toBe("CRYPTO");
    expect(c.commission).toBeCloseTo(12.5, 10);
  });

  it("falls back to the legacy Saxo schedule for unmodelled currencies", () => {
    const c = computeCommission({ notional: 100_000, symbol: "7203.T" });
    expect(c.currency).toBe("JPY");
    expect(c.commission).toBeCloseTo(150, 10);
  });
});

describe("computeCommission — volume discounts", () => {
  it("discounts the bps component at higher monthly volume", () => {
    const classic = computeCommission({ notional: 50_000, symbol: "VOD.L" });
    const vip = computeCommission({ notional: 50_000, symbol: "VOD.L", monthlyVolume: 2_000_000 });
    expect(vip.volumeMultiplier).toBe(0.7);
    expect(vip.commission).toBeCloseTo(classic.commission * 0.7, 8);
  });

  it("never discounts below the floor", () => {
    const c = computeCommission({ notional: 100, symbol: "VOD.L", monthlyVolume: 5_000_000 });
    expect(c.commission).toBe(3);
  });
});

describe("commissionBreakevenNotional", () => {
  it("is the notional where the rate overtakes the floor", () => {
    const be = commissionBreakevenNotional({ symbol: "VOD.L" });
    expect(be).toBeGreaterThan(0);
    const below = computeCommission({ notional: be * 0.5, symbol: "VOD.L" });
    expect(below.minFloorApplied).toBe(true);
  });

  it("is infinite for pure per-share venues", () => {
    expect(commissionBreakevenNotional({ symbol: "AAPL" })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("broker simulator integration", () => {
  const frictions = { commission: { model: SCALING_COMMISSION_MODEL } };

  it("charges the modelled commission on a BUY and never borrows", () => {
    const res = simulateBrokerExecution(
      { cash: 10_000, holdings: [] },
      [{ id: "d1", symbol: "VOD.L", side: "BUY", quantity: 100, price: 20 }],
      { frictions },
    );
    const snap = res.snapshots[0]!;
    expect(snap.fee).toBeCloseTo(3, 10); // 2,000 notional → floor
    expect(snap.cash).toBeCloseTo(10_000 - 2_000 - 3, 8);
    expect(snap.cash).toBeGreaterThanOrEqual(0);
  });

  it("keeps cash non-negative when buying the whole book", () => {
    const res = simulateBrokerExecution(
      { cash: 1_000, holdings: [] },
      [{ id: "d1", symbol: "AAPL", side: "BUY", quantity: 1_000, price: 10 }],
      { frictions },
    );
    const snap = res.snapshots[0]!;
    expect(snap.cash).toBeGreaterThanOrEqual(0);
    expect(snap.partial).toBe(true);
    expect(snap.fillQuantity * snap.fillPrice + snap.fee).toBeLessThanOrEqual(1_000 + 1e-9);
  });

  it("is deterministic across repeated runs", () => {
    const run = () =>
      simulateBrokerExecution(
        { cash: 50_000, holdings: [] },
        [
          { id: "d1", symbol: "VOD.L", side: "BUY", quantity: 500, price: 20 },
          { id: "d2", symbol: "VOD.L", side: "SELL", quantity: 500, price: 21 },
        ],
        { frictions },
      );
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
