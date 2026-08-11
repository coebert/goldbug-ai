// Locks the per-symbol execution calibration: estimator selection, the
// venue floor that stops a degenerate estimate making trading look free,
// and the monotonic size-dependence of the resulting cost.
import { describe, it, expect } from "vitest";
import {
  calibrateSymbolExecution,
  corwinSchultzSpread,
  rollSpread,
  executionCostFor,
  floorHalfSpreadBps,
  type CalibBar,
} from "@/lib/execution-calibration-from-bars";

/** Deterministic bars with a controllable proportional spread in the H/L range. */
function bars(n: number, opts: { spread?: number; vol?: number; volume?: number | null }): CalibBar[] {
  const spread = opts.spread ?? 0.002;
  const vol = opts.vol ?? 0.01;
  const out: CalibBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px *= 1 + Math.sin(i / 5) * vol;
    const range = px * (spread / 2 + vol / 2);
    out.push({
      date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      close: px,
      high: px + range,
      low: px - range,
      volume: opts.volume === undefined ? 1_000_000 : opts.volume,
    });
  }
  return out;
}

describe("execution calibration from bars", () => {
  it("prefers Corwin-Schultz when highs and lows exist", () => {
    const c = calibrateSymbolExecution({ symbol: "AAPL", bars: bars(300, {}), currency: "USD" });
    expect(c.spreadSource).toBe("corwin_schultz");
    expect(c.halfSpreadBps).toBeGreaterThan(0);
    expect(c.sampleBars).toBe(252);
  });

  it("falls back to Roll, then to the class floor, as inputs get thinner", () => {
    const noHl = bars(300, {}).map(({ date, close, volume }) => ({ date, close, volume }));
    const roll = calibrateSymbolExecution({ symbol: "AAPL", bars: noHl, currency: "USD" });
    expect(["roll", "class_floor"]).toContain(roll.spreadSource);

    const tiny = calibrateSymbolExecution({
      symbol: "AAPL",
      bars: noHl.slice(0, 31),
      currency: "USD",
    });
    expect(tiny.spreadSource).toBe("class_floor");
    expect(tiny.halfSpreadBps).toBe(floorHalfSpreadBps("stock", "USD"));
  });

  it("never estimates below the venue floor, and LSE floors above US", () => {
    const flat: CalibBar[] = bars(300, { spread: 0, vol: 0.0001 });
    const us = calibrateSymbolExecution({ symbol: "AAPL", bars: flat, currency: "USD" });
    const uk = calibrateSymbolExecution({ symbol: "ISF.L", bars: flat, currency: "GBP" });
    expect(us.halfSpreadBps).toBeGreaterThanOrEqual(us.floorHalfSpreadBps);
    expect(uk.floorHalfSpreadBps).toBeGreaterThan(us.floorHalfSpreadBps);
  });

  it("wider high/low ranges calibrate to a wider spread", () => {
    const tight = calibrateSymbolExecution({ symbol: "A", bars: bars(300, { spread: 0.001 }), currency: "USD" });
    const wide = calibrateSymbolExecution({ symbol: "A", bars: bars(300, { spread: 0.05 }), currency: "USD" });
    expect(wide.halfSpreadBps).toBeGreaterThan(tight.halfSpreadBps);
  });

  it("returns null from the estimators when the sample cannot support them", () => {
    expect(corwinSchultzSpread([])).toBeNull();
    expect(rollSpread(bars(10, {}))).toBeNull();
  });

  it("prices cost with a commission floor that dominates small tickets", () => {
    const c = calibrateSymbolExecution({ symbol: "AAPL", bars: bars(300, {}), currency: "USD" });
    const small = executionCostFor(c, 100);
    const big = executionCostFor(c, 10_000);
    // Same commission floor spread over 100x the notional → far cheaper in bps.
    expect(small.totalBps).toBeGreaterThan(big.totalBps);
    // …but the absolute cost still rises with size.
    expect(big.total).toBeGreaterThan(small.total);
    expect(small.commission).toBeGreaterThan(0);
  });

  it("charges more impact in a thin name than a liquid one", () => {
    const liquid = calibrateSymbolExecution({ symbol: "A", bars: bars(300, { volume: 50_000_000 }), currency: "USD" });
    const thin = calibrateSymbolExecution({ symbol: "B", bars: bars(300, { volume: 500 }), currency: "USD" });
    expect(executionCostFor(thin, 50_000).impact).toBeGreaterThan(
      executionCostFor(liquid, 50_000).impact,
    );
  });

  it("scales linearly in the stress multiplier and is zero at zero notional", () => {
    const c = calibrateSymbolExecution({ symbol: "AAPL", bars: bars(300, {}), currency: "USD" });
    const one = executionCostFor(c, 5000, "normal", 1);
    const three = executionCostFor(c, 5000, "normal", 3);
    expect(three.spread + three.impact).toBeCloseTo(3 * (one.spread + one.impact), 6);
    expect(three.commission).toBeCloseTo(one.commission, 9);
    expect(executionCostFor(c, 0).total).toBe(0);
  });

  it("is deterministic", () => {
    const b = bars(300, {});
    expect(JSON.stringify(calibrateSymbolExecution({ symbol: "X", bars: b, currency: "USD" }))).toBe(
      JSON.stringify(calibrateSymbolExecution({ symbol: "X", bars: b, currency: "USD" })),
    );
  });
});
