import { describe, it, expect } from "vitest";
import { runAiBacktest, AI_BACKTEST_WARMUP_BARS } from "../ai-backtest";
import { buildPriceTape } from "../risk-sim-matrix";
import type { BacktestBar } from "../backtest-runner";

const UNIVERSE = [
  { symbol: "MEGA", start: 40, drift: 0.14, vol: 0.24, cycleAmp: 0.4, cycleBars: 90 },
  { symbol: "CYCL", start: 18, drift: 0.09, vol: 0.34, cycleAmp: 0.9, cycleBars: 55 },
  { symbol: "DEFN", start: 25, drift: 0.05, vol: 0.16, cycleAmp: 0.2, cycleBars: 140 },
];

const TAPE: BacktestBar[] = buildPriceTape(UNIVERSE, 260, 20260803);

describe("runAiBacktest", () => {
  it("starts from £1000 and produces one equity point per bar", async () => {
    const r = await runAiBacktest(TAPE);
    expect(r.startingCash).toBe(1000);
    expect(r.equityCurve).toHaveLength(TAPE.length);
    expect(r.equityCurve[0].totalValue).toBeCloseTo(1000, 6);
    expect(r.equityCurve[0].returnPct).toBeCloseTo(0, 9);
    for (const p of r.equityCurve) {
      expect(Number.isFinite(p.totalValue)).toBe(true);
      expect(p.totalValue).toBeCloseTo(p.cash + p.holdingsValue, 6);
      expect(p.returnPct).toBeCloseTo((p.totalValue / 1000 - 1) * 100, 9);
    }
  });

  it("executes buys and sells and logs each fill with a reason", async () => {
    const r = await runAiBacktest(TAPE);
    expect(r.tradeLog.length).toBeGreaterThan(0);
    expect(r.summary.buys).toBeGreaterThan(0);
    for (const t of r.tradeLog) {
      expect(t.quantity).toBeGreaterThan(0);
      expect(t.price).toBeGreaterThan(0);
      expect(t.notional).toBeCloseTo(t.quantity * t.price, 6);
      expect(t.reason).not.toBe("");
      expect(["buy", "sell"]).toContain(t.side);
      expect(t.cashAfter).toBeGreaterThanOrEqual(-1e-9);
    }
    // Sequence is dense and chronological.
    expect(r.tradeLog.map((t) => t.seq)).toEqual(
      r.tradeLog.map((_, i) => i + 1),
    );
    const dates = r.tradeLog.map((t) => t.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("never trades during the warm-up window", async () => {
    const r = await runAiBacktest(TAPE);
    for (const t of r.tradeLog) {
      expect(t.barIndex).toBeGreaterThanOrEqual(AI_BACKTEST_WARMUP_BARS);
    }
    for (const p of r.equityCurve.slice(0, AI_BACKTEST_WARMUP_BARS)) {
      expect(p.totalValue).toBeCloseTo(1000, 6);
    }
  });

  it("never borrows or shorts", async () => {
    const r = await runAiBacktest(TAPE, { feePerTrade: 1.5 });
    for (const p of r.equityCurve) expect(p.cash).toBeGreaterThanOrEqual(-1e-9);
    for (const h of r.finalHoldings) expect(h.quantity).toBeGreaterThan(0);
  });

  it("is deterministic for the same tape", async () => {
    const a = await runAiBacktest(TAPE, { riskLevel: "balanced" });
    const b = await runAiBacktest(TAPE, { riskLevel: "balanced" });
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it("summary agrees with the equity curve and trade log", async () => {
    const r = await runAiBacktest(TAPE, { feePerTrade: 0.5 });
    expect(r.summary.endingEquity).toBeCloseTo(r.equityCurve.at(-1)!.totalValue, 6);
    expect(r.summary.buys + r.summary.sells).toBe(r.tradeLog.length);
    expect(r.summary.feesPaid).toBeCloseTo(
      r.tradeLog.reduce((a, t) => a + t.fee, 0),
      6,
    );
    expect(r.summary.bars).toBe(TAPE.length);
    expect(r.summary.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(Number.isFinite(r.summary.sharpe)).toBe(true);
    expect(Number.isFinite(r.summary.cagrPct)).toBe(true);
  });

  it("fractional sizing lets a small £1000 pot trade expensive names", async () => {
    const pricey = buildPriceTape(
      UNIVERSE.map((u) => ({ ...u, start: u.start * 40 })),
      200,
      777,
    );
    const frac = await runAiBacktest(pricey, { fractionalShares: true });
    const whole = await runAiBacktest(pricey, { fractionalShares: false });
    expect(frac.tradeLog.length).toBeGreaterThan(0);
    expect(whole.tradeLog.length).toBeLessThanOrEqual(frac.tradeLog.length);
  });

  it("charges frictions inside the pot without going negative", async () => {
    const r = await runAiBacktest(TAPE, {
      feePerTrade: 1,
      frictions: { commissionBps: 100, minCommission: 5, buyTaxBps: 50, slippageBps: 100 },
    });
    for (const p of r.equityCurve) expect(p.cash).toBeGreaterThanOrEqual(-1e-9);
    expect(r.summary.feesPaid).toBeGreaterThan(0);
  });

  it("handles an empty tape", async () => {
    const r = await runAiBacktest([]);
    expect(r.equityCurve).toEqual([]);
    expect(r.tradeLog).toEqual([]);
    expect(r.summary.endingEquity).toBe(1000);
  });

  it("respects the risk level sleeve (aggressive opens at least as many names)", async () => {
    const cons = await runAiBacktest(TAPE, { riskLevel: "conservative" });
    const aggr = await runAiBacktest(TAPE, { riskLevel: "aggressive" });
    expect(aggr.summary.buys).toBeGreaterThanOrEqual(cons.summary.buys);
  });
});
