import { describe, it, expect } from "vitest";
import { atrTakeProfitPct, takeProfitPrice, stopLossPrice } from "@/lib/exits/atr-take-profit";
import { atrScaledStopPct } from "@/lib/exits/atr-scaled-stop";

const base = {
  takeProfitEnabled: true,
  fixedTakeProfitPct: 0.25,
  atrPct: 0.02,
  atrMult: 4,
  floorPct: 0.06,
  capPct: 0.4,
  atrScalingEnabled: true,
};

describe("atrTakeProfitPct", () => {
  it("sizes the target at k×ATR when the layer is on", () => {
    const r = atrTakeProfitPct(base);
    expect(r.effectiveTakeProfitPct).toBeCloseTo(0.08, 12);
    expect(r.scaled).toBe(true);
    expect(r.note).toContain("4×ATR");
  });

  it("lifts a noise-level target to the floor", () => {
    const r = atrTakeProfitPct({ ...base, atrPct: 0.005 }); // 4×0.5% = 2%
    expect(r.effectiveTakeProfitPct).toBeCloseTo(0.06, 12);
    expect(r.note).toContain("floor");
  });

  it("caps an unreachable target on a wild name", () => {
    const r = atrTakeProfitPct({ ...base, atrPct: 0.2 }); // 4×20% = 80%
    expect(r.effectiveTakeProfitPct).toBeCloseTo(0.4, 12);
    expect(r.rawAtrTakeProfitPct).toBeCloseTo(0.8, 12);
    expect(r.note).toContain("capped");
  });

  it("falls back to the fixed target when ATR is unknown or scaling is off", () => {
    expect(atrTakeProfitPct({ ...base, atrPct: 0 }).effectiveTakeProfitPct).toBeCloseTo(0.25, 12);
    expect(atrTakeProfitPct({ ...base, atrScalingEnabled: false }).effectiveTakeProfitPct).toBeCloseTo(0.25, 12);
    expect(atrTakeProfitPct({ ...base, atrMult: 0 }).scaled).toBe(false);
  });

  it("is fully optional — disabling it removes the exit entirely", () => {
    const r = atrTakeProfitPct({ ...base, takeProfitEnabled: false });
    expect(r.effectiveTakeProfitPct).toBe(0);
    expect(r.note).toContain("winners run");
  });

  it("reports no target when neither a fixed nor an ATR target exists", () => {
    const r = atrTakeProfitPct({ ...base, fixedTakeProfitPct: 0, atrPct: 0 });
    expect(r.effectiveTakeProfitPct).toBe(0);
    expect(r.note).toContain("no take-profit");
  });

  it("survives NaN and negative inputs without producing a poisoned target", () => {
    const r = atrTakeProfitPct({
      ...base,
      atrPct: Number.NaN,
      atrMult: -3,
      floorPct: Number.NaN,
      capPct: Number.NaN,
    });
    expect(Number.isFinite(r.effectiveTakeProfitPct)).toBe(true);
    expect(r.effectiveTakeProfitPct).toBeCloseTo(0.25, 12);
  });

  it("keeps the floor below the cap even when they are configured inverted", () => {
    const r = atrTakeProfitPct({ ...base, floorPct: 0.5, capPct: 0.1 });
    expect(r.effectiveTakeProfitPct).toBeCloseTo(0.5, 12);
  });
});

describe("exit price levels", () => {
  it("prices the volatility-adjusted stop and target off cost basis", () => {
    const stop = atrScaledStopPct({
      fixedStopPct: 0.1,
      atrPct: 0.02,
      atrMult: 2.5,
      floorPct: 0.03,
      enabled: true,
    });
    const tp = atrTakeProfitPct(base);
    expect(stopLossPrice(100, stop.effectiveStopPct)).toBeCloseTo(95, 10); // 2.5×2% = 5%
    expect(takeProfitPrice(100, tp.effectiveTakeProfitPct)).toBeCloseTo(108, 10);
  });

  it("returns null levels when the leg is disabled", () => {
    expect(takeProfitPrice(100, 0)).toBeNull();
    expect(stopLossPrice(0, 0.1)).toBeNull();
  });

  it("keeps the target above the stop for every plausible ATR", () => {
    for (let atrPct = 0.002; atrPct <= 0.25; atrPct += 0.002) {
      const stop = atrScaledStopPct({
        fixedStopPct: 0.1,
        atrPct,
        atrMult: 2.5,
        floorPct: 0.03,
        enabled: true,
      });
      const tp = atrTakeProfitPct({ ...base, atrPct });
      expect(takeProfitPrice(100, tp.effectiveTakeProfitPct)!).toBeGreaterThan(
        stopLossPrice(100, stop.effectiveStopPct)!,
      );
    }
  });
});
