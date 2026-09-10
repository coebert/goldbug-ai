import { describe, expect, it } from "vitest";
import {
  measuredFloorParts,
  minNotionalForMeasuredFloor,
  scaleMeasuredRoundTripBps,
} from "../measured-cost-floor";
import { assessNetEdge } from "../net-edge-gate";

describe("measured cost floor scaling", () => {
  it("splits out the fixed commission part of a measured ratio", () => {
    const parts = measuredFloorParts({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 90,
      measuredAtNotional: 250,
    });
    expect(parts.fixedCost).toBeGreaterThan(0);
    expect(parts.variableBps).toBeLessThan(90);
  });

  it("charges a bigger ticket less than the flat measured rate", () => {
    const small = scaleMeasuredRoundTripBps({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 90,
      measuredAtNotional: 250,
      notional: 250,
    });
    const big = scaleMeasuredRoundTripBps({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 90,
      measuredAtNotional: 250,
      notional: 1500,
    });
    expect(small).toBeCloseTo(90, 1);
    expect(big).toBeLessThan(small);
  });

  it("charges an undersized ticket more, capped", () => {
    const tiny = scaleMeasuredRoundTripBps({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 90,
      measuredAtNotional: 250,
      notional: 50,
    });
    expect(tiny).toBeGreaterThan(90);
    expect(tiny).toBeLessThanOrEqual(270);
  });

  it("names the notional that fits a budget, or infinity when hopeless", () => {
    const ok = minNotionalForMeasuredFloor({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 90,
      measuredAtNotional: 250,
      budgetBps: 80,
    });
    expect(Number.isFinite(ok)).toBe(true);
    expect(ok).toBeGreaterThan(0);
    const hopeless = minNotionalForMeasuredFloor({
      symbol: "VWRL:xlon",
      measuredRoundTripBps: 900,
      measuredAtNotional: 250,
      budgetBps: 10,
    });
    expect(hopeless).toBe(Infinity);
  });
});

describe("net edge gate with size-aware measured floor", () => {
  const base = {
    symbol: "VWRL:xlon",
    side: "buy" as const,
    price: 100,
    assetClass: "etf",
    conviction: 0.6,
    atrPct: 0.012,
    horizonDays: 10,
    measuredRoundTripBps: 90,
  };

  it("lets a viable-sized ticket through where a small one fails", () => {
    const small = assessNetEdge({ ...base, quantity: 3 });
    const large = assessNetEdge({ ...base, quantity: 30 });
    expect(large.roundTripBps).toBeLessThan(small.roundTripBps);
  });

  it("still blocks when the size-invariant costs swamp the edge", () => {
    const weak = assessNetEdge({
      ...base,
      quantity: 100,
      conviction: 0.05,
      atrPct: 0.002,
      measuredRoundTripBps: 400,
    });
    expect(weak.pass).toBe(false);
  });

  it("never gates a sell", () => {
    expect(assessNetEdge({ ...base, side: "sell", quantity: 1 }).pass).toBe(true);
  });
});
