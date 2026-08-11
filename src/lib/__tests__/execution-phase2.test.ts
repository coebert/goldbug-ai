import { describe, it, expect } from "vitest";
import { planMarketableLimit } from "../marketable-limit";
import { planProtectiveStop } from "../protective-stops";

describe("planMarketableLimit", () => {
  it("prices a buy above and a sell below the reference", () => {
    const buy = planMarketableLimit({ side: "buy", referencePrice: 100 })!;
    const sell = planMarketableLimit({ side: "sell", referencePrice: 100 })!;
    expect(buy.limitPrice).toBeGreaterThan(100);
    expect(sell.limitPrice).toBeLessThan(100);
    expect(buy.slackBps).toBeGreaterThan(0);
  });

  it("clamps slack between the floor and the cap", () => {
    const tight = planMarketableLimit({ side: "buy", referencePrice: 100, minSlackBps: 20, maxSlackBps: 25 })!;
    expect(tight.slackBps).toBeGreaterThanOrEqual(20);
    expect(tight.slackBps).toBeLessThanOrEqual(25);

    const capped = planMarketableLimit({
      side: "buy",
      referencePrice: 100,
      atrPct: 0.5,
      crossHalfSpreads: 20,
      maxSlackBps: 40,
    })!;
    expect(capped.slackBps).toBe(40);
    expect(capped.limitPrice).toBeCloseTo(100.4, 6);
  });

  it("rounds to the tick in the marketable direction", () => {
    const buy = planMarketableLimit({ side: "buy", referencePrice: 100, tickSize: 0.5 })!;
    const sell = planMarketableLimit({ side: "sell", referencePrice: 100, tickSize: 0.5 })!;
    expect(buy.limitPrice % 0.5).toBeCloseTo(0, 9);
    expect(sell.limitPrice % 0.5).toBeCloseTo(0, 9);
    expect(buy.limitPrice).toBeGreaterThanOrEqual(100);
    expect(sell.limitPrice).toBeLessThanOrEqual(100);
  });

  it("rejects an unusable reference price", () => {
    expect(planMarketableLimit({ side: "buy", referencePrice: 0 })).toBeNull();
    expect(planMarketableLimit({ side: "buy", referencePrice: Number.NaN })).toBeNull();
  });
});

describe("planProtectiveStop", () => {
  it("puts a sell stop below a long entry", () => {
    const stop = planProtectiveStop({ side: "buy", fillPrice: 200, atrPct: 0.02 })!;
    expect(stop.side).toBe("sell");
    expect(stop.stopPrice).toBeLessThan(200);
    expect(stop.stopPct).toBeCloseTo(0.05, 9);
  });

  it("puts a buy stop above a short entry", () => {
    const stop = planProtectiveStop({ side: "sell", fillPrice: 200, atrPct: 0.02 })!;
    expect(stop.side).toBe("buy");
    expect(stop.stopPrice).toBeGreaterThan(200);
  });

  it("clamps the distance to the min/max band", () => {
    const calm = planProtectiveStop({ side: "buy", fillPrice: 100, atrPct: 0.001 })!;
    expect(calm.stopPct).toBeCloseTo(0.03, 9);
    const wild = planProtectiveStop({ side: "buy", fillPrice: 100, atrPct: 0.4 })!;
    expect(wild.stopPct).toBeCloseTo(0.15, 9);
  });

  it("falls back to a default vol estimate and rejects bad prices", () => {
    const fallback = planProtectiveStop({ side: "buy", fillPrice: 100 })!;
    expect(fallback.stopPct).toBeGreaterThan(0);
    expect(planProtectiveStop({ side: "buy", fillPrice: -1 })).toBeNull();
  });
});
