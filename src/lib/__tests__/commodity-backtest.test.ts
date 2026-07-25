import { describe, it, expect } from "vitest";
import {
  runCommodityRejectionBacktest,
  COMMODITY_BACKTEST_SYMBOLS,
} from "@/lib/commodity-backtest.server";
import { DEFAULT_RISK_CONFIG } from "@/lib/universe.server";
import type { Candle } from "@/lib/market-data.server";

// Build a synthetic rising-trend candle series that will consistently trigger
// the buy signal (px > SMA20 > SMA50, RSI in 30-70, positive momentum).
function trendCandles(days: number, opts: { adv?: number; volatility?: number } = {}): Candle[] {
  const out: Candle[] = [];
  const adv = opts.adv ?? 5_000_000;
  const vol = opts.volatility ?? 0.005;
  let px = 100;
  for (let i = 0; i < days; i++) {
    // Slight upward drift + tiny wobble so RSI settles ~55-65.
    const drift = 0.001;
    const wobble = Math.sin(i / 3) * vol;
    px = px * (1 + drift + wobble);
    const date = new Date(Date.UTC(2022, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    out.push({
      date,
      open: px,
      high: px * (1 + vol),
      low: px * (1 - vol),
      close: px,
      volume: adv / px,
    });
  }
  return out;
}

describe("runCommodityRejectionBacktest", () => {
  const symbols = COMMODITY_BACKTEST_SYMBOLS.map((s) => ({
    ...s,
    candles: trendCandles(250),
  }));
  const from = symbols[0].candles[60].date;
  const to = symbols[0].candles[symbols[0].candles.length - 1].date;

  it("produces per-symbol and per-group rollups covering the requested groups", () => {
    const report = runCommodityRejectionBacktest({
      from,
      to,
      startingCash: 10_000,
      riskLevel: "balanced",
      riskConfig: DEFAULT_RISK_CONFIG,
      symbols,
    });
    const groups = new Set(report.byGroup.map((g) => g.group));
    expect(groups).toEqual(new Set(["Gold", "Silver", "Oil", "Gas", "Copper"]));
    expect(report.totalProposals).toBeGreaterThan(0);
    expect(report.accepted + report.rejected).toBe(report.totalProposals);
  });

  it("rejects buys when ADV is below the configured floor", () => {
    const illiquid = symbols.map((s) => ({
      ...s,
      candles: trendCandles(250, { adv: 10_000 }), // way below 250k default
    }));
    const report = runCommodityRejectionBacktest({
      from,
      to,
      startingCash: 10_000,
      riskLevel: "balanced",
      riskConfig: DEFAULT_RISK_CONFIG,
      symbols: illiquid,
    });
    expect(report.rejectionCounts.illiquid_adv).toBeGreaterThan(0);
    expect(report.accepted).toBe(0);
  });

  it("rejects gold buys once the per-group cap is exhausted", () => {
    // Very small group cap → first accept fills it; every subsequent gold
    // signal must be rejected with reason=group_cap.
    const report = runCommodityRejectionBacktest({
      from,
      to,
      startingCash: 100_000,
      riskLevel: "aggressive", // per_symbol cap 0.25
      riskConfig: {
        ...DEFAULT_RISK_CONFIG,
        commodity_group_limits: { Gold: 0.05 },
        commodity_min_adv_usd: 0,
        commodity_max_atr_pct: 0,
      },
      symbols,
    });
    const gold = report.bySymbol.find((s) => s.group === "Gold")!;
    expect(gold.rejected).toBeGreaterThan(0);
    expect(gold.rejectionCounts.group_cap).toBeGreaterThan(0);
  });
});
