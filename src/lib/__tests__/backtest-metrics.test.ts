import { describe, expect, it } from "vitest";
import {
  computeBacktestMetrics,
  computeMaxDrawdown,
  computeSharpe,
  realizedPnlPerRoundTrip,
  dailyReturns,
} from "@/lib/backtest-metrics";

const eq = (rows: Array<[string, number]>) =>
  rows.map(([snapshot_date, total_value]) => ({ snapshot_date, total_value }));

describe("computeMaxDrawdown", () => {
  it("returns 0 on a flat/rising curve", () => {
    const dd = computeMaxDrawdown(eq([["d1", 100], ["d2", 110], ["d3", 120]]));
    expect(dd.pct).toBe(0);
    expect(dd.peakDate).toBeNull();
    expect(dd.troughDate).toBeNull();
  });

  it("captures a single peak → trough as a negative pct with correct dates", () => {
    const dd = computeMaxDrawdown(
      eq([["d1", 100], ["d2", 120], ["d3", 90], ["d4", 96]]),
    );
    // peak 120 → trough 90 = -25%
    expect(dd.pct).toBeCloseTo(-25, 10);
    expect(dd.peakDate).toBe("d2");
    expect(dd.troughDate).toBe("d3");
  });

  it("picks the deepest drawdown when there are multiple peaks", () => {
    const dd = computeMaxDrawdown(
      eq([
        ["d1", 100],
        ["d2", 110], // peak A
        ["d3", 99],  // -10% from A
        ["d4", 130], // new peak B
        ["d5", 91],  // -30% from B — deeper
        ["d6", 100],
      ]),
    );
    expect(dd.pct).toBeCloseTo(-30, 10);
    expect(dd.peakDate).toBe("d4");
    expect(dd.troughDate).toBe("d5");
  });
});

describe("dailyReturns + Sharpe + volatility", () => {
  it("produces N−1 returns for N points", () => {
    expect(dailyReturns(eq([["a", 100], ["b", 110], ["c", 99]]))).toHaveLength(2);
  });

  it("Sharpe is 0 for a perfectly flat curve (zero variance)", () => {
    expect(computeSharpe(dailyReturns(eq([["a", 100], ["b", 100], ["c", 100]]))))
      .toBe(0);
  });

  it("Sharpe scales linearly with mean when variance is fixed (rough sanity)", () => {
    // Alternating ±1% and alternating +2%/-1% — larger positive mean →
    // larger positive Sharpe.
    const smallMean = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const bigMean = [0.02, -0.01, 0.02, -0.01, 0.02, -0.01, 0.02, -0.01];
    const sSmall = computeSharpe(smallMean);
    const sBig = computeSharpe(bigMean);
    expect(sBig).toBeGreaterThan(sSmall);
    // smallMean has mean 0 → Sharpe 0 exactly.
    expect(sSmall).toBe(0);
  });
});

describe("realizedPnlPerRoundTrip (FIFO)", () => {
  it("returns [] when there are only buys", () => {
    expect(
      realizedPnlPerRoundTrip([
        { trade_date: "d1", side: "buy", symbol: "A", quantity: 10, price: 5 },
      ]),
    ).toEqual([]);
  });

  it("matches a single buy/sell round-trip and returns realized PnL", () => {
    // Bought 10 @ 5, sold 10 @ 8 → +30.
    const r = realizedPnlPerRoundTrip([
      { trade_date: "d1", side: "buy", symbol: "A", quantity: 10, price: 5 },
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 10, price: 8 },
    ]);
    expect(r).toEqual([30]);
  });

  it("FIFO across partial sells with different lot prices", () => {
    // Two buy lots: 5 @ 10, then 5 @ 20. Sell 7 @ 25.
    // FIFO consumes lot1 (5 @ 10) + 2 of lot2 (@ 20).
    // realized = (25-10)*5 + (25-20)*2 = 75 + 10 = 85.
    const r = realizedPnlPerRoundTrip([
      { trade_date: "d1", side: "buy", symbol: "A", quantity: 5, price: 10 },
      { trade_date: "d2", side: "buy", symbol: "A", quantity: 5, price: 20 },
      { trade_date: "d3", side: "sell", symbol: "A", quantity: 7, price: 25 },
    ]);
    expect(r).toEqual([85]);
  });

  it("ignores the unmatched short-tail of a sell when no open lots remain", () => {
    // Buy 5, sell 10 → only 5 matched. Contract: skip the unmatched
    // 5 (no cost basis) — don't synthesise a fake win/loss.
    const r = realizedPnlPerRoundTrip([
      { trade_date: "d1", side: "buy", symbol: "A", quantity: 5, price: 10 },
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 10, price: 12 },
    ]);
    expect(r).toEqual([(12 - 10) * 5]);
  });

  it("keeps symbols independent (does not cross-consume lots)", () => {
    const r = realizedPnlPerRoundTrip([
      { trade_date: "d1", side: "buy", symbol: "A", quantity: 5, price: 10 },
      { trade_date: "d1", side: "buy", symbol: "B", quantity: 5, price: 100 },
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 5, price: 12 }, // +10
      { trade_date: "d2", side: "sell", symbol: "B", quantity: 5, price: 90 }, // -50
    ]);
    expect(r).toEqual([10, -50]);
  });

  it("orders by trade_date then executed_at to keep FIFO deterministic", () => {
    // Feed in reverse array order — result must still be FIFO by date.
    const r = realizedPnlPerRoundTrip([
      { trade_date: "d3", side: "sell", symbol: "A", quantity: 5, price: 15, executed_at: "10:00" },
      { trade_date: "d1", side: "buy",  symbol: "A", quantity: 5, price: 5,  executed_at: "09:00" },
      { trade_date: "d2", side: "buy",  symbol: "A", quantity: 5, price: 10, executed_at: "09:00" },
    ]);
    expect(r).toEqual([(15 - 5) * 5]); // FIFO consumes the d1 lot @ 5
  });
});

describe("computeBacktestMetrics (integration)", () => {
  it("empty equity → all zeros / nulls, never throws", () => {
    const m = computeBacktestMetrics([], [], 1000);
    expect(m.days).toBe(0);
    expect(m.totalReturnPct).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.winRatePct).toBeNull();
  });

  it("computes headline metrics from a mixed win/loss backtest", () => {
    const equity = eq([
      ["d1", 1000],
      ["d2", 1050], // +5%
      ["d3", 980],  // ~-6.67%
      ["d4", 1100], // +12.24%
      ["d5", 1090], // -0.91%
    ]);
    const trades = [
      { trade_date: "d1", side: "buy",  symbol: "A", quantity: 10, price: 50 } as const, // cost 500
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 10, price: 55 } as const, // +50 win
      { trade_date: "d3", side: "buy",  symbol: "B", quantity: 10, price: 40 } as const, // cost 400
      { trade_date: "d4", side: "sell", symbol: "B", quantity: 10, price: 36 } as const, // -40 loss
      { trade_date: "d4", side: "buy",  symbol: "C", quantity: 5,  price: 20 } as const, // cost 100
      { trade_date: "d5", side: "sell", symbol: "C", quantity: 5,  price: 24 } as const, // +20 win
    ];
    const m = computeBacktestMetrics(equity, trades, 1000);

    expect(m.days).toBe(5);
    expect(m.totalReturnPct).toBeCloseTo(9, 10); // (1090-1000)/1000
    expect(m.trades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRatePct).toBeCloseTo((2 / 3) * 100, 10);
    expect(m.avgWin).toBeCloseTo((50 + 20) / 2, 10);
    expect(m.avgLoss).toBe(-40);
    expect(m.grossRealizedPnl).toBe(50 - 40 + 20); // 30

    // Max drawdown = 1050 → 980 = -6.6667% (deeper than d4→d5's -0.91%).
    expect(m.maxDrawdownPct).toBeCloseTo(((980 - 1050) / 1050) * 100, 10);
    expect(m.maxDrawdownPeakDate).toBe("d2");
    expect(m.maxDrawdownTroughDate).toBe("d3");

    // Sharpe should be a finite non-null number for this curve.
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(Number.isFinite(m.volatilityPct)).toBe(true);
  });

  it("all-winning backtest: winRatePct = 100 and avgLoss = null", () => {
    const equity = eq([["d1", 1000], ["d2", 1100]]);
    const trades = [
      { trade_date: "d1", side: "buy",  symbol: "A", quantity: 10, price: 50 } as const,
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 10, price: 60 } as const,
    ];
    const m = computeBacktestMetrics(equity, trades, 1000);
    expect(m.winRatePct).toBe(100);
    expect(m.avgLoss).toBeNull();
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(0);
  });

  it("break-even round-trip (PnL = 0) does not count as a win OR a loss", () => {
    // realized pnl exactly 0 → excluded from wins and losses buckets,
    // and NOT counted toward trades (roundTrips filter drops zero pnl
    // when computing winRate). Contract: locks the current behaviour.
    const equity = eq([["d1", 1000], ["d2", 1000]]);
    const trades = [
      { trade_date: "d1", side: "buy",  symbol: "A", quantity: 10, price: 50 } as const,
      { trade_date: "d2", side: "sell", symbol: "A", quantity: 10, price: 50 } as const,
    ];
    const m = computeBacktestMetrics(equity, trades, 1000);
    // The round-trip IS counted (1 total), but wins & losses are 0.
    expect(m.trades).toBe(1);
    expect(m.wins).toBe(0);
    expect(m.losses).toBe(0);
    expect(m.winRatePct).toBe(0);
  });
});
