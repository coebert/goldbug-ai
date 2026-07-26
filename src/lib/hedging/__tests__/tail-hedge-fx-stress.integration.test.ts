// Stress parity: extreme FX swings + weekend/holiday quote gaps.
//
// Extends the non-GBP FX parity contract by pushing the upstream FX table
// into pathological shapes the executor and backtest runner must still
// agree on trade-for-trade and NAV-for-NAV:
//
//   1. Currency crisis: sudden 50% devaluation mid-window (native prices
//      unchanged, FX collapses one day) — the converted series spikes/dips
//      violently. Both systems must classify buys/unwinds identically.
//   2. Weekend / holiday gaps: skipped calendar days (Sat/Sun + a bank
//      holiday) with no bar emitted, followed by a large open on the next
//      session. Neither system should synthesize phantom fills across the
//      gap; the first post-gap bar drives any hedge action.
//   3. Whipsaw FX: rate flips ±20% day-over-day for a week — parity must
//      survive rapid direction changes without drift.
//   4. Missing FX quote day: the FX table skips a date; caller carries the
//      previous rate forward. Both paths consume the caller-provided series
//      and must remain in lockstep.
//
// The engines are unit-agnostic — this test pins the invariant that any
// FX handling applied *before* the price series enters the engines
// propagates identically through both.
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

function assertParity(
  hedgeSymbol: string,
  converted: Array<{ date: string; price: number }>,
  portfolioCurrency: string,
  initialCash: number,
) {
  const c = cfg(hedgeSymbol, { initialCash });
  const bt = runPhaseBacktest(
    [
      makeSeries(hedgeSymbol, converted),
      makeSeries("__SPINE__", converted.map((d) => ({ date: d.date, price: 1 }))),
    ],
    noSignal,
    { ...ALL_PHASES_OFF, hedge: true },
    c,
  );
  const btHedge = bt.trades.filter((t) => t.symbol === hedgeSymbol);
  const ex = replayExecutor(converted, c, portfolioCurrency);

  expect(btHedge.length).toBe(ex.trades.length);
  for (let i = 0; i < btHedge.length; i++) {
    const a = btHedge[i], b = ex.trades[i];
    expect(a.date).toBe(b.date);
    expect(a.side).toBe(b.side);
    expect(a.price).toBeCloseTo(b.price, 8);
    expect(a.qty).toBeCloseTo(b.qty, 8);
  }
  expect(bt.metrics.finalEquity).toBeCloseTo(ex.terminalNav, 6);
  return { btHedge, ex, bt };
}

describe("Phase 6 stress: extreme FX swings and calendar gaps", () => {
  it("survives a 50% currency devaluation mid-window (native flat, FX collapses)", () => {
    // Native USD prices flat, then a controlled drift; FX EUR/USD collapses
    // on day 4 (e.g. 0.92 → 0.46), then partially recovers.
    const nativePrices = [100, 100, 105, 105, 200, 180, 150, 140];
    const fx =            [0.92, 0.92, 0.92, 0.46, 0.50, 0.55, 0.60, 0.62];
    const dates = nativePrices.map((_, i) => `2024-05-${String(i + 1).padStart(2, "0")}`);
    const converted = dates.map((date, i) => ({ date, price: nativePrices[i] * fx[i] }));
    const { btHedge } = assertParity("GLD", converted, "EUR", 10_000);
    expect(btHedge.length).toBeGreaterThan(0);
  });

  it("weekend + bank-holiday gap: no phantom fills, next session drives action", () => {
    // Trading days only — Fri, then skip Sat/Sun and Mon (holiday),
    // resume Tue with a large gap-open. Both systems consume the emitted
    // bars as-is; neither should invent a fill on the missing calendar.
    const days = [
      { date: "2024-05-24", price: 100 * 0.92 }, // Fri
      // Sat 2024-05-25, Sun 2024-05-26, Mon 2024-05-27 (Memorial Day) — omitted
      { date: "2024-05-28", price: 260 * 0.90 }, // Tue gap-open
      { date: "2024-05-29", price: 250 * 0.905 },
      { date: "2024-05-30", price: 180 * 0.91 }, // regime unwind
      { date: "2024-05-31", price: 170 * 0.915 },
    ];
    const { btHedge } = assertParity("GLD", days, "EUR", 10_000);
    // No trade dated inside the gap.
    for (const t of btHedge) {
      expect(["2024-05-25", "2024-05-26", "2024-05-27"]).not.toContain(t.date);
    }
  });

  it("whipsaw FX (±20% daily flips) keeps both systems in lockstep", () => {
    const nativePrices = [100, 102, 98, 105, 95, 200, 180, 160];
    const fx =            [1.00, 1.20, 0.96, 1.15, 0.92, 1.10, 0.88, 1.05];
    const dates = nativePrices.map((_, i) => `2024-06-${String(i + 1).padStart(2, "0")}`);
    const converted = dates.map((date, i) => ({ date, price: nativePrices[i] * fx[i] }));
    assertParity("GLD", converted, "EUR", 10_000);
  });

  it("missing FX quote day (caller carries prior rate forward) still matches", () => {
    // Simulate a caller-side FX outage: rate for day 4 is unavailable, so
    // caller reuses day 3's rate. Engines see a smooth series either way.
    const nativePrices = [100, 105, 110, 500, 480, 200, 175];
    const rawFx: (number | null)[] = [0.92, 0.925, 0.93, null, 0.918, 0.9, 0.905];
    let last = rawFx[0]!;
    const fx = rawFx.map((r) => (r == null ? last : (last = r)));
    const dates = nativePrices.map((_, i) => `2024-07-${String(i + 1).padStart(2, "0")}`);
    const converted = dates.map((date, i) => ({ date, price: nativePrices[i] * fx[i] }));
    const { btHedge } = assertParity("GLD", converted, "EUR", 10_000);
    expect(btHedge.length).toBeGreaterThan(0);
  });

  it("crisis + gap combo across a non-USD hedge (SGLN.L, GBp→CHF)", () => {
    // Weekend gap AND a 40% GBp→CHF collapse on the reopen day, on a
    // GBp-quoted hedge held in a CHF portfolio.
    const days = [
      { date: "2024-08-16", price: 500 * 0.011 },  // Fri
      // Sat/Sun omitted
      { date: "2024-08-19", price: 520 * 0.0066 }, // Mon: crisis + gap-open
      { date: "2024-08-20", price: 900 * 0.0068 }, // spike
      { date: "2024-08-21", price: 600 * 0.0070 },
      { date: "2024-08-22", price: 400 * 0.0072 }, // unwind
    ];
    assertParity("SGLN.L", days, "CHF", 10_000);
  });
});
