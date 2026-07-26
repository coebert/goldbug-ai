// Cross-symbol × non-GBP quote-currency parity.
//
// Neither the Phase 6 backtest runner nor the paper executor performs FX
// conversion internally — both consume a single numeric price series and
// track cash/NAV in those same units. That means the *contract* between
// them is: whatever FX handling the caller applies upstream must produce
// identical portfolio-currency price series for both paths. This test pins
// that contract explicitly for non-GBP-quoted hedge instruments.
//
// For each (portfolioCurrency, hedgeSymbol) pair we:
//   1. Build a native-quote price series (e.g. GLD in USD, SGLN.L in GBp,
//      BTCE.DE in EUR).
//   2. Apply a daily FX rate to convert into the portfolio's accounting
//      currency (USD, EUR, JPY, CHF).
//   3. Feed the *converted* series to both the backtest runner and the
//      executor replay, and assert:
//        • trade-for-trade parity (date, side, qty, price)
//        • terminal-NAV parity in portfolio currency
//        • NAV reconstructed from native-price × qty × fx matches
//          runner.finalEquity, proving the upstream FX contract is the
//          only thing that matters — swap the FX table and both paths
//          move together.
//
// Non-parity would mean the two paths interpret the same converted price
// stream differently, which would silently corrupt live P&L whenever a
// portfolio's accounting currency differs from the hedge instrument's
// native quote currency.
import { describe, it, expect } from "vitest";
import {
  runPhaseBacktest,
  ALL_PHASES_OFF,
  DEFAULT_CONFIG,
  type SymbolSeries,
  type SignalFn,
  type Trade,
  type RunnerConfig,
} from "@/lib/backtest/phase-runner";
import { applyTailHedgeToPaperPortfolio } from "@/lib/hedging/tail-hedge-executor.server";
import { computeTailHedge } from "@/lib/hedging/tail-hedge";
import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];
const BUFFER = 0.01;
const noSignal: SignalFn = () => "hold";

type Day = { date: string; nativePrice: number; fx: number }; // fx = native → portfolio

function convert(days: Day[]): Array<{ date: string; price: number }> {
  return days.map((d) => ({ date: d.date, price: d.nativePrice * d.fx }));
}

function makeSeries(sym: string, days: Array<{ date: string; price: number }>): SymbolSeries {
  return {
    symbol: sym,
    bars: days.map((d) => ({ date: d.date, high: d.price, low: d.price, close: d.price })),
    earnings: [],
  };
}

function cfg(hedgeSymbol: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    ...DEFAULT_CONFIG,
    baseFeeBps: 0,
    baseSlippageBps: 0,
    slicingSlippageBps: 0,
    hedgeSymbol,
    hedgeCashBufferPct: BUFFER,
    cape: 40,
    regime: "risk_on",
    ...overrides,
  };
}

function replayExecutor(
  days: Array<{ date: string; price: number }>,
  c: RunnerConfig,
  portfolioCurrency: string,
) {
  let cash = c.initialCash;
  const holdings = new Map<string, Holding>();
  const trades: Trade[] = [];
  for (const day of days) {
    const price = day.price;
    const held = Number(holdings.get(c.hedgeSymbol!)?.quantity ?? 0);
    const nav = cash + held * price;
    const decision = computeTailHedge({
      nav, cape: c.cape, regime: c.regime, currentHedgeNotional: held * price,
    });
    const priceMap = price > 0 ? new Map([[c.hedgeSymbol!, price]]) : new Map<string, number>();
    const r = applyTailHedgeToPaperPortfolio({
      portfolioId: "00000000-0000-0000-0000-000000000000",
      portfolioCurrency,
      isLivePortfolio: false,
      hedgeSymbol: c.hedgeSymbol!,
      cashBufferPct: BUFFER,
      decision, holdingsByS: holdings, workingCash: cash, priceMap,
    });
    cash = r.workingCash;
    if (r.applied && r.trade) {
      trades.push({
        date: day.date, symbol: c.hedgeSymbol!, side: r.trade.side,
        qty: r.trade.quantity, price, costBps: 0, reason: r.trade.reason,
      });
    }
  }
  const finalQty = Number(holdings.get(c.hedgeSymbol!)?.quantity ?? 0);
  const lastPrice = days[days.length - 1].price;
  return { trades, finalCash: cash, finalQty, terminalNav: cash + finalQty * lastPrice };
}

type Case = { portfolioCurrency: string; hedgeSymbol: string; label: string };
const CASES: Case[] = [
  { portfolioCurrency: "USD", hedgeSymbol: "GLD",     label: "USD portfolio × USD-quoted GLD (fx = 1)" },
  { portfolioCurrency: "EUR", hedgeSymbol: "GLD",     label: "EUR portfolio × USD-quoted GLD (USD→EUR)" },
  { portfolioCurrency: "EUR", hedgeSymbol: "BTCE.DE", label: "EUR portfolio × EUR-quoted BTCE.DE (fx = 1)" },
  { portfolioCurrency: "JPY", hedgeSymbol: "IAU",     label: "JPY portfolio × USD-quoted IAU (USD→JPY)" },
  { portfolioCurrency: "CHF", hedgeSymbol: "SGLN.L",  label: "CHF portfolio × GBp-quoted SGLN.L (GBp→CHF)" },
];

// Non-trivial FX path: mild drift + one gap so parity failures would surface
// as price divergence, not just a constant scale.
const FX_PATH: Record<string, number[]> = {
  "USD→USD": [1, 1, 1, 1, 1, 1, 1, 1],
  "USD→EUR": [0.92, 0.925, 0.93, 0.918, 0.9, 0.905, 0.912, 0.92],
  "EUR→EUR": [1, 1, 1, 1, 1, 1, 1, 1],
  "USD→JPY": [150, 151, 149.5, 152, 148, 149, 150.5, 151.2],
  "GBp→CHF": [0.011, 0.0112, 0.0111, 0.01105, 0.0109, 0.0113, 0.01115, 0.01108], // pence → CHF
};

function fxKey(hedgeSymbol: string, portfolioCurrency: string): string {
  const nativeCcy =
    hedgeSymbol === "SGLN.L" ? "GBp" :
    hedgeSymbol === "BTCE.DE" ? "EUR" :
    "USD";
  return `${nativeCcy}→${portfolioCurrency === nativeCcy ? nativeCcy : portfolioCurrency}`;
}

describe("Phase 6 backtest ↔ executor: parity across non-GBP portfolio currencies with FX conversion", () => {
  describe.each(CASES)("$label", ({ portfolioCurrency, hedgeSymbol }) => {
    // 8-day series shaped to trigger at least one buy, one hold, one unwind.
    const nativePrices = [100, 102, 105, 500, 480, 200, 180, 150];
    const key = fxKey(hedgeSymbol, portfolioCurrency);
    const fxSeries = FX_PATH[key];
    const days: Day[] = nativePrices.map((p, i) => ({
      date: `2024-02-0${i + 1}`,
      nativePrice: p,
      fx: fxSeries[i],
    }));
    const converted = convert(days);
    const c = cfg(hedgeSymbol, {
      initialCash:
        portfolioCurrency === "JPY" ? 1_500_000 :
        portfolioCurrency === "CHF" ? 10_000 :
        10_000,
    });

    it("produces identical fills after FX conversion", () => {
      const bt = runPhaseBacktest(
        [makeSeries(hedgeSymbol, converted), makeSeries("__SPINE__", converted.map((d) => ({ date: d.date, price: 1 })))],
        noSignal,
        { ...ALL_PHASES_OFF, hedge: true },
        c,
      );
      const btHedge = bt.trades.filter((t) => t.symbol === hedgeSymbol);
      const ex = replayExecutor(converted, c, portfolioCurrency);

      expect(btHedge.length).toBe(ex.trades.length);
      expect(btHedge.length).toBeGreaterThan(0);
      for (let i = 0; i < btHedge.length; i++) {
        const a = btHedge[i], b = ex.trades[i];
        expect(a.date).toBe(b.date);
        expect(a.side).toBe(b.side);
        expect(a.price).toBeCloseTo(b.price, 8);
        expect(a.qty).toBeCloseTo(b.qty, 8);
      }
    });

    it("terminal NAV matches in portfolio currency, and reconstructs from native price × fx", () => {
      const bt = runPhaseBacktest(
        [makeSeries(hedgeSymbol, converted), makeSeries("__SPINE__", converted.map((d) => ({ date: d.date, price: 1 })))],
        noSignal,
        { ...ALL_PHASES_OFF, hedge: true },
        c,
      );
      const ex = replayExecutor(converted, c, portfolioCurrency);

      // Path A: both systems agree on NAV in portfolio currency.
      expect(bt.metrics.finalEquity).toBeCloseTo(ex.terminalNav, 6);

      // Path B: reconstruct NAV from executor's final qty × native last price × last fx.
      const last = days[days.length - 1];
      const reconstructed = ex.finalCash + ex.finalQty * last.nativePrice * last.fx;
      expect(reconstructed).toBeCloseTo(ex.terminalNav, 6);
      expect(reconstructed).toBeCloseTo(bt.metrics.finalEquity, 6);
    });
  });

  it("swapping the FX table shifts both systems in lockstep (no drift)", () => {
    // Same native prices, two different FX paths → both systems move together.
    const nativePrices = [100, 110, 90, 200, 180];
    const dates = nativePrices.map((_, i) => `2024-03-0${i + 1}`);
    const fxA = [0.92, 0.92, 0.92, 0.92, 0.92];
    const fxB = [1.10, 1.11, 1.09, 1.12, 1.08];
    const hedgeSymbol = "GLD";
    const c = cfg(hedgeSymbol, { initialCash: 10_000 });

    for (const fx of [fxA, fxB]) {
      const converted = dates.map((date, i) => ({ date, price: nativePrices[i] * fx[i] }));
      const bt = runPhaseBacktest(
        [makeSeries(hedgeSymbol, converted), makeSeries("__SPINE__", converted.map((d) => ({ date: d.date, price: 1 })))],
        noSignal,
        { ...ALL_PHASES_OFF, hedge: true },
        c,
      );
      const ex = replayExecutor(converted, c, "EUR");
      expect(bt.metrics.finalEquity).toBeCloseTo(ex.terminalNav, 6);
      expect(bt.trades.filter((t) => t.symbol === hedgeSymbol).length).toBe(ex.trades.length);
    }
  });
});
