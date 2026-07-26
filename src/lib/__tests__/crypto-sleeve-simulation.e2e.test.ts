// End-to-end simulation test for the crypto sleeve.
//
// Drives the pure `runCryptoPlaybookBacktest` engine (same resolver used
// live) across a multi-timestep synthetic price series and asserts the
// portfolio-level invariants that matter for real money:
//
//   1. Sleeve exposure never exceeds the risk-level cap (5/10/15%) on any
//      single day, in any regime, at any point in the run.
//   2. In a risk_on regime the sleeve actually opens positions (proving
//      the buy leg fires — not just that caps are respected by doing
//      nothing).
//   3. When BTC crashes hard enough to flip the derived regime to
//      risk_off (crisis / bear), every crypto position exits within a
//      handful of ticks and the sleeve returns to ~0% (X6).
//   4. Cash never goes negative — no accidental leverage from oversized buys.
//   5. Contribution attribution stays coherent (no unexplained equity
//      delta leaking outside the six tracked ETPs).

import { describe, it, expect } from "vitest";
import {
  runCryptoPlaybookBacktest,
  deriveCryptoRegimeFromBtc,
  CRYPTO_BACKTEST_SYMBOLS,
  _sumContribution,
  type CryptoBacktestSymbol,
} from "../crypto-backtest.server";
import { cryptoSleeveCapPct, bucketRegime } from "../crypto-strategy.server";
import type { Candle } from "../market-data.server";

// --- Synthetic price generator ------------------------------------------

/** Build ISO dates for a contiguous run of trading days starting at `start`. */
function dates(start: string, n: number): string[] {
  const out: string[] = [];
  const t0 = new Date(start + "T00:00:00Z").getTime();
  for (let i = 0; i < n; i++) {
    out.push(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Deterministic path: quiet uptrend, then a sharp crash, then flat.
 *  - `warmup` days of slow drift so SMA200 becomes meaningful
 *  - `bull` days rising ~40% smoothly (bull_quiet → risk_on)
 *  - `crash` days losing ~55% peak-to-trough (crisis → risk_off)
 *  - `tail` days flat so we can watch the exit resolve.
 */
function synthPath(
  seed: number,
  { warmup, bull, crash, tail }: { warmup: number; bull: number; crash: number; tail: number },
): number[] {
  const closes: number[] = [];
  let p = 100 + seed * 3;
  // Warmup: mild sideways drift.
  for (let i = 0; i < warmup; i++) {
    p *= 1 + 0.0005 * Math.sin(i / 8 + seed);
    closes.push(round(p));
  }
  // Bull: steady rise + small noise.
  for (let i = 0; i < bull; i++) {
    p *= 1 + 0.006 + 0.001 * Math.sin(i / 5 + seed);
    closes.push(round(p));
  }
  // Crash: sharp drawdown over ~30 days then continued weakness.
  for (let i = 0; i < crash; i++) {
    p *= 1 - (i < 30 ? 0.025 : 0.008) + 0.0005 * Math.sin(i / 3 + seed);
    closes.push(round(p));
  }
  // Tail: flat with tiny noise.
  for (let i = 0; i < tail; i++) {
    p *= 1 + 0.0002 * Math.sin(i / 6 + seed);
    closes.push(round(p));
  }
  return closes;
}

function round(x: number) { return Math.max(0.01, Math.round(x * 100) / 100); }

function toCandles(ds: string[], closes: number[]): Candle[] {
  return ds.map((d, i) => ({
    date: d, open: closes[i], high: closes[i] * 1.01,
    low: closes[i] * 0.99, close: closes[i], volume: 1_000_000,
  }));
}

function buildFixture(): {
  symbols: CryptoBacktestSymbol[]; from: string; to: string;
  crashStartDate: string; postCrashDate: string;
} {
  const phases = { warmup: 220, bull: 60, crash: 60, tail: 40 };
  const total = phases.warmup + phases.bull + phases.crash + phases.tail;
  const ds = dates("2024-01-01", total);

  const symbols: CryptoBacktestSymbol[] = CRYPTO_BACKTEST_SYMBOLS.map((s, i) => ({
    symbol: s.symbol,
    group: s.group,
    candles: toCandles(ds, synthPath(i, phases)),
  }));

  // Backtest window: from just after warmup so SMA200 is defined, through the end.
  const from = ds[phases.warmup];
  const to = ds[total - 1];
  const crashStartDate = ds[phases.warmup + phases.bull];
  const postCrashDate = ds[phases.warmup + phases.bull + phases.crash + 10];
  return { symbols, from, to, crashStartDate, postCrashDate };
}

// --- Tests ---------------------------------------------------------------

describe("crypto sleeve e2e simulation — caps + risk-off exit across timesteps", () => {
  const fixture = buildFixture();

  it("sleeve_pct never exceeds the risk-level cap on any day, any risk level", () => {
    for (const risk of ["conservative", "balanced", "aggressive"] as const) {
      const cap = cryptoSleeveCapPct(risk);
      const r = runCryptoPlaybookBacktest({
        from: fixture.from, to: fixture.to,
        startingCash: 10_000,
        riskLevel: risk,
        symbols: fixture.symbols,
      });
      expect(r.daysReplayed).toBeGreaterThan(50);
      // 1e-6 epsilon absorbs floating-point rounding in mv/nav.
      for (const pt of r.equityCurve) {
        expect(pt.sleeve_pct).toBeLessThanOrEqual(cap + 1e-6);
        expect(pt.cash).toBeGreaterThanOrEqual(-1e-6);
      }
      // Contribution attribution stays coherent (all deltas explained by
      // the six tracked ETPs, within a small numerical band).
      if (Math.abs(r.finalEquity - r.startingCash) > 1) {
        expect(_sumContribution(r)).toBeGreaterThan(0.95);
        expect(_sumContribution(r)).toBeLessThan(1.05);
      }
    }
  });

  it("in a risk_on window the sleeve actually opens positions (buys fire)", () => {
    const r = runCryptoPlaybookBacktest({
      from: fixture.from, to: fixture.to,
      startingCash: 10_000, riskLevel: "aggressive",
      symbols: fixture.symbols,
    });
    // At least one day during the bull-run half should show meaningful
    // sleeve exposure (>1% of NAV) — otherwise the resolver never bought
    // and the caps test above would be trivially satisfied.
    const bullWindow = r.equityCurve.filter((p) => p.date < fixture.crashStartDate);
    const maxSleeveBull = Math.max(0, ...bullWindow.map((p) => p.sleeve_pct));
    expect(maxSleeveBull).toBeGreaterThan(0.01);
    expect(r.trades).toBeGreaterThan(0);
  });

  it("risk-off exit: once BTC crashes, sleeve returns to ~0% within a few ticks", () => {
    // Independently verify our fixture actually flips to risk_off — if it
    // didn't, the exit assertion below would be meaningless.
    const btc = fixture.symbols.find((s) => s.group === "BTC")!;
    const btcCloses = btc.candles.map((c) => c.close);
    const finalRegime = deriveCryptoRegimeFromBtc(btcCloses);
    expect(bucketRegime(finalRegime)).toBe("risk_off");

    const r = runCryptoPlaybookBacktest({
      from: fixture.from, to: fixture.to,
      startingCash: 10_000, riskLevel: "aggressive",
      symbols: fixture.symbols,
    });

    const postCrash = r.equityCurve.filter((p) => p.date >= fixture.postCrashDate);
    expect(postCrash.length).toBeGreaterThan(5);
    // After a handful of ticks in risk_off, sleeve should be flushed.
    for (const pt of postCrash) {
      expect(pt.regime).toBe("risk_off");
      expect(pt.sleeve_pct).toBeLessThan(0.005);
      expect(pt.crypto_mv).toBeLessThan(1); // basically all sold
    }
    // And at least one exit trade must have fired.
    expect(r.trades).toBeGreaterThan(0);
  });

  it("cap ordering holds: aggressive sleeve peak >= balanced >= conservative", () => {
    const peak = (level: "conservative" | "balanced" | "aggressive") => {
      const r = runCryptoPlaybookBacktest({
        from: fixture.from, to: fixture.to,
        startingCash: 10_000, riskLevel: level,
        symbols: fixture.symbols,
      });
      return Math.max(0, ...r.equityCurve.map((p) => p.sleeve_pct));
    };
    const c = peak("conservative"), b = peak("balanced"), a = peak("aggressive");
    // Not strict — bull run may saturate all three below their cap — but
    // the risk-tiered ordering must never invert.
    expect(a).toBeGreaterThanOrEqual(b - 1e-6);
    expect(b).toBeGreaterThanOrEqual(c - 1e-6);
    expect(a).toBeLessThanOrEqual(cryptoSleeveCapPct("aggressive") + 1e-6);
    expect(b).toBeLessThanOrEqual(cryptoSleeveCapPct("balanced") + 1e-6);
    expect(c).toBeLessThanOrEqual(cryptoSleeveCapPct("conservative") + 1e-6);
  });
});
