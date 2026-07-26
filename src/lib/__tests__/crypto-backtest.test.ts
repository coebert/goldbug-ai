// Unit tests for the crypto playbook historical backtest engine.
// Uses synthetic price paths so the assertions are deterministic and
// exercise: sleeve caps, regime derivation, and drawdown / contribution math.

import { describe, it, expect } from "vitest";
import {
  runCryptoPlaybookBacktest,
  deriveCryptoRegimeFromBtc,
  CRYPTO_BACKTEST_SYMBOLS,
  _sumContribution,
} from "../crypto-backtest.server";
import { CRYPTO_SYMBOLS } from "../crypto-groups";
import type { Candle } from "../market-data.server";

function makeCandles(prices: number[], startYear = 2023, startMonth = 1): Candle[] {
  const out: Candle[] = [];
  const d = new Date(Date.UTC(startYear, startMonth - 1, 1));
  for (const p of prices) {
    // Skip weekends to look vaguely like trading days.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: p, high: p * 1.005, low: p * 0.995, close: p, volume: 100_000,
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function uptrend(len: number, start = 100, step = 0.3) {
  return Array.from({ length: len }, (_, i) => start + i * step + (i % 2 === 0 ? -0.4 : 0.4));
}
function downtrend(len: number, start = 300, step = -0.5) {
  return Array.from({ length: len }, (_, i) => Math.max(1, start + i * step));
}

describe("CRYPTO_BACKTEST_SYMBOLS", () => {
  it("covers exactly the six approved ETPs", () => {
    expect(new Set(CRYPTO_BACKTEST_SYMBOLS.map((s) => s.symbol)))
      .toEqual(new Set(CRYPTO_SYMBOLS));
    expect(CRYPTO_BACKTEST_SYMBOLS).toHaveLength(6);
  });
});

describe("deriveCryptoRegimeFromBtc", () => {
  it("returns a bullish label when price is well above SMAs and dd small", () => {
    const label = deriveCryptoRegimeFromBtc(uptrend(260));
    expect(["bull_quiet", "bull_volatile"]).toContain(label);
  });
  it("returns bear / crisis when in a sustained downtrend", () => {
    const label = deriveCryptoRegimeFromBtc(downtrend(260));
    expect(["bear", "crisis"]).toContain(label);
  });
});

describe("runCryptoPlaybookBacktest", () => {
  const symbols = CRYPTO_BACKTEST_SYMBOLS.map((s) => ({
    symbol: s.symbol,
    group: s.group,
    candles: makeCandles(uptrend(260)),
  }));
  const from = symbols[0].candles[60].date;
  const to = symbols[0].candles[symbols[0].candles.length - 1].date;

  it("returns a well-formed report with an equity curve and sensible bounds", () => {
    const r = runCryptoPlaybookBacktest({
      from, to,
      startingCash: 10_000,
      riskLevel: "balanced",
      symbols,
    });
    expect(r.daysReplayed).toBeGreaterThan(0);
    expect(r.equityCurve).toHaveLength(r.daysReplayed);
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(r.maxDrawdownPct).toBeLessThanOrEqual(1);
    // Sleeve cap is enforced by construction — sleeve % should never exceed cap+ε.
    for (const p of r.equityCurve) {
      expect(p.sleeve_pct).toBeLessThanOrEqual(0.10 + 1e-6); // balanced cap = 10%
      expect(p.sleeve_pct).toBeGreaterThanOrEqual(0);
      expect(p.equity).toBeGreaterThan(0);
    }
    // Bucket day count sums to days replayed.
    const sum = r.bucketDayCount.risk_on + r.bucketDayCount.caution + r.bucketDayCount.risk_off;
    expect(sum).toBe(r.daysReplayed);
  });

  it("respects the conservative sleeve cap (5%)", () => {
    const r = runCryptoPlaybookBacktest({
      from, to,
      startingCash: 10_000,
      riskLevel: "conservative",
      symbols,
    });
    for (const p of r.equityCurve) {
      expect(p.sleeve_pct).toBeLessThanOrEqual(0.05 + 1e-6);
    }
  });

  it("in a sustained downtrend never opens new positions and equity ≈ starting cash", () => {
    const bearSymbols = CRYPTO_BACKTEST_SYMBOLS.map((s) => ({
      symbol: s.symbol,
      group: s.group,
      candles: makeCandles(downtrend(260)),
    }));
    const r = runCryptoPlaybookBacktest({
      from: bearSymbols[0].candles[60].date,
      to: bearSymbols[0].candles[bearSymbols[0].candles.length - 1].date,
      startingCash: 10_000,
      riskLevel: "aggressive",
      symbols: bearSymbols,
    });
    // No opens → no realised PnL and MV stays at 0 throughout.
    expect(r.trades).toBe(0);
    for (const p of r.equityCurve) {
      expect(p.crypto_mv).toBe(0);
      expect(p.equity).toBeCloseTo(10_000, 6);
    }
    expect(r.finalEquity).toBeCloseTo(10_000, 6);
    expect(r.maxDrawdownPct).toBe(0);
  });

  it("attributes contribution shares that sum to ≈ 100% when equity moves", () => {
    const r = runCryptoPlaybookBacktest({
      from, to,
      startingCash: 10_000,
      riskLevel: "aggressive",
      symbols,
    });
    if (Math.abs(r.finalEquity - r.startingCash) > 1) {
      const total = _sumContribution(r);
      expect(total).toBeGreaterThan(0.9);
      expect(total).toBeLessThan(1.1);
    }
  });
});
