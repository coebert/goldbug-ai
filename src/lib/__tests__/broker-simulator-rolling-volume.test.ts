import { describe, expect, it } from "vitest";
import {
  simulateBrokerExecution,
  type SimDecision,
  type SimState,
} from "../broker-simulator";

const state: SimState = { cash: 1_000_000, holdings: [] };
const buy = (qty: number, extra: Partial<SimDecision> = {}): SimDecision => ({
  id: "d1", symbol: "AAA", side: "BUY", quantity: qty, price: 10, ...extra,
});

describe("broker-simulator rolling-volume liquidity", () => {
  it("caps fill at the mean of the trailing rolling window (per-symbol)", () => {
    // window=3 over [1000, 2000, 3000] -> mean 2000; participation 0.5 -> 1000
    const res = simulateBrokerExecution(state, [buy(5000)], {
      liquidity: {
        volumeHistory: { AAA: [10, 20, 1000, 2000, 3000] },
        rollingWindow: 3,
        maxParticipationRate: 0.5,
      },
    });
    expect(res.rejections).toEqual([]);
    expect(res.snapshots[0].fillQuantity).toBe(1000);
    expect(res.snapshots[0].truncationReason).toBe("liquidity");
    expect(res.snapshots[0].partial).toBe(true);
  });

  it("per-decision availableVolume overrides per-symbol volumeHistory", () => {
    const res = simulateBrokerExecution(state, [buy(5000, { availableVolume: 250 })], {
      liquidity: {
        volumeHistory: { AAA: [10_000, 10_000, 10_000] },
        rollingWindow: 3,
      },
    });
    expect(res.snapshots[0].fillQuantity).toBe(250);
  });

  it("per-decision volumeHistory overrides per-symbol availableVolume", () => {
    const res = simulateBrokerExecution(
      state,
      [buy(5000, { volumeHistory: [100, 300, 500] })],
      {
        liquidity: {
          availableVolume: { AAA: 9999 },
          rollingWindow: 3, // mean(100,300,500)=300
        },
      },
    );
    expect(res.snapshots[0].fillQuantity).toBe(300);
  });

  it("falls through to per-symbol tier when per-decision history is empty/invalid", () => {
    const res = simulateBrokerExecution(
      state,
      [buy(5000, { volumeHistory: [NaN, -1] })],
      { liquidity: { availableVolume: { AAA: 400 } } },
    );
    expect(res.snapshots[0].fillQuantity).toBe(400);
  });

  it("median aggregator is robust to a single fat bar", () => {
    const res = simulateBrokerExecution(state, [buy(5000)], {
      liquidity: {
        volumeHistory: { AAA: [100, 200, 300, 400, 100_000] },
        rollingWindow: 5,
        volumeAggregator: "median",
      },
    });
    expect(res.snapshots[0].fillQuantity).toBe(300);
  });

  it("min aggregator picks the worst bar in the window", () => {
    const res = simulateBrokerExecution(state, [buy(5000)], {
      liquidity: {
        volumeHistory: { AAA: [900, 800, 50, 700] },
        rollingWindow: 4,
        volumeAggregator: "min",
      },
    });
    expect(res.snapshots[0].fillQuantity).toBe(50);
  });

  it("omitting rollingWindow uses the entire supplied history", () => {
    // mean(100,200,300,400) = 250
    const res = simulateBrokerExecution(state, [buy(5000)], {
      liquidity: { volumeHistory: { AAA: [100, 200, 300, 400] } },
    });
    expect(res.snapshots[0].fillQuantity).toBe(250);
  });

  it("window larger than history uses whatever is available", () => {
    // mean(200,400)=300, window=10 -> still 300
    const res = simulateBrokerExecution(state, [buy(5000)], {
      liquidity: { volumeHistory: { AAA: [200, 400] }, rollingWindow: 10 },
    });
    expect(res.snapshots[0].fillQuantity).toBe(300);
  });

  it("empty / all-invalid history is treated as unconstrained", () => {
    const res = simulateBrokerExecution(state, [buy(100)], {
      liquidity: { volumeHistory: { AAA: [] }, rollingWindow: 3 },
    });
    expect(res.snapshots[0].fillQuantity).toBe(100);
    expect(res.snapshots[0].truncationReason).toBeNull();
  });

  it("rolling mean of zero => no_liquidity rejection", () => {
    const res = simulateBrokerExecution(state, [buy(100)], {
      liquidity: { volumeHistory: { AAA: [0, 0, 0] }, rollingWindow: 3 },
    });
    expect(res.snapshots).toEqual([]);
    expect(res.rejections[0]?.reason).toBe("no_liquidity");
  });

  it("time-slicing continues to work against a rolling-volume cap", () => {
    // 3-bar mean = 300; each slice fills 300, so 1000 units -> 4 snapshots
    // (300,300,300,100).
    const res = simulateBrokerExecution(
      state,
      [buy(1000)],
      {
        liquidity: {
          volumeHistory: { AAA: [300, 300, 300] },
          rollingWindow: 3,
        },
        timeSliceUnfilled: true,
        timeSliceMaxAttempts: 5,
      },
    );
    const fills = res.snapshots.map((s) => s.fillQuantity);
    expect(fills).toEqual([300, 300, 300, 100]);
    expect(fills.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(res.snapshots.at(-1)!.truncationReason).toBeNull();
  });
});
