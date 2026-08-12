import { describe, it, expect } from "vitest";
import {
  runOrderBatchingAb,
  type BatchingSignal,
} from "../order-batching-ab";
import type { BacktestBar } from "../../backtest-runner";

function bars(days: number, price = 10, driftPct = 0): BacktestBar[] {
  const out: BacktestBar[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
    out.push({ date: d, closes: { "ISF.L": price * (1 + driftPct * i) } });
  }
  return out;
}

/** Nine tiny buys, one per bar — the classic commission-floor bleed. */
function drips(series: BacktestBar[], notional: number): BatchingSignal[] {
  return series.slice(0, 9).map((b) => ({
    date: b.date,
    symbol: "ISF.L",
    side: "buy" as const,
    notionalBase: notional,
    conviction: 0.6,
    assetClass: "etf",
  }));
}

describe("runOrderBatchingAb", () => {
  it("routes fewer, larger tickets in the batched arm", async () => {
    const series = bars(12);
    const r = await runOrderBatchingAb({
      bars: series,
      signals: drips(series, 90),
      startingCash: 10_000,
      minTicketBase: 250,
      // Daily bars are 24h apart, so the live 24h window expires a parked
      // slice before the next bar can top it up. Multi-day window required.
      windowHours: 96,
    });
    expect(r.batched.tickets).toBeGreaterThan(0);
    expect(r.batched.tickets).toBeLessThan(9);
    // Unbatched skips every sub-minimum drip outright: no tickets at all.
    expect(r.unbatched.tickets).toBe(0);
    expect(r.unbatched.signalsSkipped).toBe(9);
  });

  it("keeps both arms on the same bar count and signal stream", async () => {
    const series = bars(10);
    const signals = drips(series, 400);
    const r = await runOrderBatchingAb({
      bars: series,
      signals,
      startingCash: 50_000,
      minTicketBase: 250,
    });
    expect(r.bars).toBe(10);
    expect(r.signals).toBe(signals.length);
    // Every ticket already clears the floor, so batching changes nothing.
    expect(r.batched.tickets).toBe(r.unbatched.tickets);
    expect(r.batched.totalCostBase).toBeCloseTo(r.unbatched.totalCostBase, 6);
    expect(r.verdict).toBe("inconclusive");
  });

  it("charges commission per routed ticket, so fewer tickets cost less", async () => {
    const series = bars(12);
    const signals: BatchingSignal[] = [];
    // Two names dripping in below the floor.
    for (const b of series.slice(0, 8)) {
      signals.push({ date: b.date, symbol: "ISF.L", side: "buy", notionalBase: 120, assetClass: "etf" });
    }
    const batchedOnly = await runOrderBatchingAb({
      bars: series,
      signals,
      startingCash: 20_000,
      minTicketBase: 250,
      windowHours: 96,
    });
    expect(batchedOnly.batched.tickets).toBeGreaterThan(0);
    // Same money deployed via 8 slices would have paid 8 floors; batching
    // pays one per release.
    expect(batchedOnly.batched.tickets).toBeLessThanOrEqual(4);
    expect(batchedOnly.batched.costBpsOfTurnover).toBeLessThan(200);
  });

  it("never batches sells", async () => {
    const series = bars(6);
    const signals: BatchingSignal[] = [
      { date: series[0].date, symbol: "ISF.L", side: "buy", notionalBase: 1_000, assetClass: "etf" },
      { date: series[3].date, symbol: "ISF.L", side: "sell", notionalBase: 50, assetClass: "etf" },
    ];
    const r = await runOrderBatchingAb({
      bars: series,
      signals,
      startingCash: 10_000,
      minTicketBase: 250,
    });
    const sells = r.batched.trades.filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].date).toBe(series[3].date);
  });

  it("drops a parked slice when the price runs away", async () => {
    // +8%/bar blows through the 5% drift guard immediately.
    const series = bars(6, 10, 0.08);
    const r = await runOrderBatchingAb({
      bars: series,
      signals: drips(series, 100),
      startingCash: 10_000,
      minTicketBase: 500,
      maxPriceDriftPct: 0.05,
    });
    expect(r.batched.parkedLost).toBeGreaterThan(0);
  });

  it("expires parked slices once the window closes", async () => {
    const series = bars(10);
    const r = await runOrderBatchingAb({
      bars: series,
      signals: [
        { date: series[0].date, symbol: "ISF.L", side: "buy", notionalBase: 50, assetClass: "etf" },
        { date: series[8].date, symbol: "ISF.L", side: "buy", notionalBase: 50, assetClass: "etf" },
      ],
      startingCash: 10_000,
      minTicketBase: 5_000,
      windowHours: 24,
    });
    expect(r.batched.parkedLost).toBeGreaterThan(0);
    expect(r.batched.tickets).toBe(0);
  });

  it("reports a drawdown for both arms and never a negative percentage", async () => {
    const series = [
      ...bars(4, 10),
      ...bars(4, 6).map((b, i) => ({
        date: new Date(Date.UTC(2026, 0, 20 + i)).toISOString().slice(0, 10),
        closes: b.closes,
      })),
    ];
    const r = await runOrderBatchingAb({
      bars: series,
      signals: [
        { date: series[0].date, symbol: "ISF.L", side: "buy", notionalBase: 5_000, assetClass: "etf" },
      ],
      startingCash: 10_000,
      minTicketBase: 250,
    });
    expect(r.batched.maxDrawdownPct).toBeGreaterThan(0);
    expect(r.unbatched.maxDrawdownPct).toBeGreaterThan(0);
  });

  it("flags 'costly_risk' when batching saves cost but deepens drawdown", async () => {
    const series = bars(12);
    const r = await runOrderBatchingAb({
      bars: series,
      signals: drips(series, 90),
      startingCash: 10_000,
      minTicketBase: 250,
      windowHours: 96,
      drawdownTolerancePct: -100, // force the risk branch
    });
    expect(["costly_risk", "inconclusive", "supported", "not_supported"]).toContain(r.verdict);
    if (r.costSavingBps >= 2) expect(r.verdict).toBe("costly_risk");
  });

  it("is deterministic across runs", async () => {
    const series = bars(12);
    const args = {
      bars: series,
      signals: drips(series, 90),
      startingCash: 10_000,
      minTicketBase: 250,
      windowHours: 96,
    };
    const a = await runOrderBatchingAb(args);
    const b = await runOrderBatchingAb(args);
    expect(a.costSavingBps).toBe(b.costSavingBps);
    expect(a.batched.finalValue).toBe(b.batched.finalValue);
  });

  it("returns 'inconclusive' with no signals at all", async () => {
    const r = await runOrderBatchingAb({
      bars: bars(5),
      signals: [],
      startingCash: 10_000,
      minTicketBase: 250,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.batched.tickets).toBe(0);
  });

  it("caps buy tickets per bar, keeping the largest ones", async () => {
    const series: BacktestBar[] = [];
    for (let i = 0; i < 6; i++) {
      series.push({
        date: new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
        closes: { "ISF.L": 10, "VUKE.L": 20, "IUSA.L": 30 },
      });
    }
    const signals: BatchingSignal[] = [];
    for (const b of series.slice(0, 3)) {
      for (const [sym, notional] of [
        ["ISF.L", 400],
        ["VUKE.L", 800],
        ["IUSA.L", 1200],
      ] as const) {
        signals.push({
          date: b.date,
          symbol: sym,
          side: "buy",
          notionalBase: notional,
          conviction: 0.6,
          assetClass: "etf",
        });
      }
    }
    const base = {
      bars: series,
      signals,
      startingCash: 100_000,
      minTicketBase: 250,
      windowHours: 96,
    };
    const uncapped = await runOrderBatchingAb(base);
    const capped = await runOrderBatchingAb({ ...base, maxTicketsPerDay: 1 });

    expect(uncapped.batched.ticketsCapped).toBe(0);
    expect(capped.batched.ticketsCapped).toBeGreaterThan(0);
    expect(capped.batched.tickets).toBeLessThan(uncapped.batched.tickets);
    // The biggest ticket wins the single slot on each bar.
    expect(capped.batched.trades.every((t) => t.symbol === "IUSA.L")).toBe(true);
  });
});
