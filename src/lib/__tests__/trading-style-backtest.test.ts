// Locks the swing-vs-position backtest harness: determinism, and the
// structural signatures each style must show (swing = shorter holds, more
// round-trips, tighter stop mix).
import { describe, it, expect } from "vitest";
import { parseRiskConfig } from "@/lib/universe.server";
import { buildPriceTape, DEFAULT_UNIVERSE } from "@/lib/risk-sim-matrix";
import { runStyleBacktest, atrPctFrom } from "@/lib/trading-style-backtest";

const tape = buildPriceTape(DEFAULT_UNIVERSE, 252, 20260731);
const run = (style: "position" | "swing") =>
  runStyleBacktest({
    cfg: parseRiskConfig({ trading_style: style }),
    bars: tape,
    riskLevel: "balanced",
    startingCash: 10_300,
    feePerTrade: 3,
  });

describe("trading-style backtest harness", () => {
  it("is deterministic for a fixed seed and config", async () => {
    const a = await run("swing");
    const b = await run("swing");
    expect(a.endEquity).toBe(b.endEquity);
    expect(a.trades).toBe(b.trades);
    expect(a.exitMix).toEqual(b.exitMix);
  });

  it("swing holds for fewer bars and turns over more than position", async () => {
    const pos = await run("position");
    const swing = await run("swing");
    expect(swing.avgHoldBars).toBeLessThan(pos.avgHoldBars);
    expect(swing.tradesPerYear).toBeGreaterThan(pos.tradesPerYear);
    expect(swing.feeDragPct).toBeGreaterThan(pos.feeDragPct);
  });

  it("swing's tighter stop fires more often than position's", async () => {
    const pos = await run("position");
    const swing = await run("swing");
    const share = (m: Record<string, number>) => {
      const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      return (m.stop ?? 0) / total;
    };
    expect(share(swing.exitMix)).toBeGreaterThan(share(pos.exitMix));
  });

  it("never borrows: cash stays non-negative and end cash is a sane share", async () => {
    const swing = await run("swing");
    expect(swing.finalCashPct).toBeGreaterThanOrEqual(0);
    expect(swing.finalCashPct).toBeLessThanOrEqual(100.001);
  });

  it("atrPctFrom returns a positive mean absolute daily move", () => {
    expect(atrPctFrom([100, 102, 100, 103])).toBeGreaterThan(0);
    expect(atrPctFrom([100])).toBe(0);
  });
});
