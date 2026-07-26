import { describe, it, expect } from "vitest";
import {
  runPhaseBacktest,
  attributePhases,
  ALL_PHASES_ON,
  ALL_PHASES_OFF,
  type SymbolSeries,
  type SignalFn,
} from "@/lib/backtest/phase-runner";

function makeSeries(symbol: string, prices: number[], earnings: string[] = []): SymbolSeries {
  const bars = prices.map((p, i) => {
    const d = new Date(2024, 0, i + 1);
    return {
      date: d.toISOString().slice(0, 10),
      high: p * 1.01,
      low: p * 0.99,
      close: p,
    };
  });
  return { symbol, bars, earnings };
}

const upTrend = Array.from({ length: 60 }, (_, i) => 100 + i);
const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);

// Buy on day 5, hold otherwise.
const buyOnceThenHold: SignalFn = (ctx, sym) => {
  const day = new Date(ctx.date).getDate();
  if (sym === "AAA" && day === 5) return "buy";
  if (sym === "BBB" && day === 6) return "buy";
  return "hold";
};

describe("phase-runner", () => {
  it("produces monotonically-dated equity curve and matching final equity", () => {
    const res = runPhaseBacktest(
      [makeSeries("AAA", upTrend)],
      buyOnceThenHold,
      ALL_PHASES_OFF,
      { initialCash: 10_000, targetWeightPerBuy: 0.5, clusterCap: 1, baseFeeBps: 0, baseSlippageBps: 0, slicingSlippageBps: 0, cape: null, regime: null },
    );
    expect(res.equity.length).toBe(60);
    for (let i = 1; i < res.equity.length; i++) {
      expect(new Date(res.equity[i].date).getTime())
        .toBeGreaterThan(new Date(res.equity[i - 1].date).getTime());
    }
    expect(res.metrics.finalEquity).toBeCloseTo(res.equity[res.equity.length - 1].equity, 6);
    expect(res.metrics.totalReturn).toBeGreaterThan(0); // uptrend
  });

  it("earnings blackout blocks buys near print", () => {
    const earningsDate = new Date(2024, 0, 5).toISOString().slice(0, 10);
    const withEvent = runPhaseBacktest(
      [makeSeries("AAA", upTrend, [earningsDate])],
      buyOnceThenHold,
      { ...ALL_PHASES_OFF, earnings: true },
    );
    const withoutEvent = runPhaseBacktest(
      [makeSeries("AAA", upTrend)],
      buyOnceThenHold,
      ALL_PHASES_OFF,
    );
    const buysWith = withEvent.trades.filter((t) => t.side === "buy").length;
    const buysWithout = withoutEvent.trades.filter((t) => t.side === "buy").length;
    expect(buysWith).toBeLessThan(buysWithout);
  });

  it("trailing stop generates a sell after a big drop", () => {
    const shock = [...Array(20).fill(0).map((_, i) => 100 + i), ...Array(10).fill(80)];
    const alwaysBuyDay3: SignalFn = (ctx) =>
      new Date(ctx.date).getDate() === 3 ? "buy" : "hold";
    const res = runPhaseBacktest(
      [makeSeries("AAA", shock)],
      alwaysBuyDay3,
      { ...ALL_PHASES_OFF, trailing: true },
      { initialCash: 10_000, targetWeightPerBuy: 0.9, clusterCap: 1, baseFeeBps: 0, baseSlippageBps: 0, slicingSlippageBps: 0, cape: null, regime: null },
    );
    const stopSells = res.trades.filter((t) => t.side === "sell" && t.reason.includes("trailing"));
    expect(stopSells.length).toBeGreaterThanOrEqual(1);
  });

  it("cluster cap limits combined weight of correlated symbols", () => {
    const a = makeSeries("AAA", upTrend);
    const b = makeSeries("BBB", upTrend.map((p) => p * 1.01)); // perfectly correlated
    const buyBoth: SignalFn = (ctx) =>
      new Date(ctx.date).getDate() === 5 ? "buy" : "hold";
    const capped = runPhaseBacktest([a, b], buyBoth, { ...ALL_PHASES_OFF, cluster: true },
      { ...({ initialCash: 10_000, targetWeightPerBuy: 0.4, clusterCap: 0.5, baseFeeBps: 0, baseSlippageBps: 0, slicingSlippageBps: 0, cape: null, regime: null }) });
    const uncapped = runPhaseBacktest([a, b], buyBoth, ALL_PHASES_OFF,
      { initialCash: 10_000, targetWeightPerBuy: 0.4, clusterCap: 1, baseFeeBps: 0, baseSlippageBps: 0, slicingSlippageBps: 0, cape: null, regime: null });
    const cappedBuys = capped.trades.filter((t) => t.side === "buy").reduce((s, t) => s + t.qty * t.price, 0);
    const uncappedBuys = uncapped.trades.filter((t) => t.side === "buy").reduce((s, t) => s + t.qty * t.price, 0);
    expect(cappedBuys).toBeLessThan(uncappedBuys);
  });

  it("attributePhases returns a contribution entry for every phase", () => {
    const out = attributePhases(
      [makeSeries("AAA", noisy), makeSeries("BBB", upTrend)],
      buyOnceThenHold,
    );
    expect(Object.keys(out.contributions).sort()).toEqual(
      ["cluster", "earnings", "hedge", "slicing", "trailing"],
    );
    for (const c of Object.values(out.contributions)) {
      expect(Number.isFinite(c.cagrDelta)).toBe(true);
      expect(Number.isFinite(c.ddDelta)).toBe(true);
      expect(Number.isFinite(c.winRateDelta)).toBe(true);
    }
    expect(out.full.metrics.finalEquity).toBeGreaterThan(0);
    expect(out.baseline.metrics.finalEquity).toBeGreaterThan(0);
  });

  it("slicing flag lowers per-trade cost bps", () => {
    const buyDay3: SignalFn = (ctx) =>
      new Date(ctx.date).getDate() === 3 ? "buy" : "hold";
    const sliced = runPhaseBacktest([makeSeries("AAA", upTrend)], buyDay3,
      { ...ALL_PHASES_OFF, slicing: true });
    const raw = runPhaseBacktest([makeSeries("AAA", upTrend)], buyDay3, ALL_PHASES_OFF);
    const slicedBps = sliced.trades[0]?.costBps ?? 0;
    const rawBps = raw.trades[0]?.costBps ?? 0;
    expect(slicedBps).toBeLessThan(rawBps);
  });
});

describe("phase-runner metrics", () => {
  it("CAGR is 0 for flat equity, MDD is 0", () => {
    const flat = Array(30).fill(100);
    const res = runPhaseBacktest([makeSeries("AAA", flat)], () => "hold", ALL_PHASES_OFF);
    expect(res.metrics.cagr).toBeCloseTo(0, 6);
    expect(res.metrics.maxDrawdown).toBeCloseTo(0, 6);
    expect(res.metrics.winRate).toBe(0);
  });
});
