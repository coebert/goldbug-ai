// End-to-end integration test: run a full Phase 6 backtest across a multi-day
// advisory timeline that exercises buys, holds, and unwinds, then replay the
// same day-by-day advisories through the real live/paper executor
// (`applyTailHedgeToPaperPortfolio`) and assert the persisted hedge fills
// match trade-for-trade.
//
// This is the strongest cross-check we can run without a live broker: it
// proves that the Phase 6 attribution reported by the backtest is what the
// real executor would actually produce for the same advisory stream, so
// future edits to either sizing formula (cash buffer, no-borrow cap, price
// handling, threshold, regime multipliers) can't silently drift them apart.
import { describe, it, expect } from "vitest";
import {
  runPhaseBacktest,
  ALL_PHASES_OFF,
  DEFAULT_CONFIG,
  type SymbolSeries,
  type SignalFn,
  type Trade,
} from "@/lib/backtest/phase-runner";
import { applyTailHedgeToPaperPortfolio } from "@/lib/hedging/tail-hedge-executor.server";
import { computeTailHedge } from "@/lib/hedging/tail-hedge";
import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

const HEDGE_SYMBOL = "GLD";
const BUFFER = 0.01;

const noSignal: SignalFn = () => "hold";

// Multi-day gold path: ramps up (should push currentHedgeNotional over target
// and trigger unwinds), pauses (holds), then dips (rebalances back up).
const goldPath = [
  100, 105, 112, 130, 160, 200, 220, 240, 250, 260,
  260, 260, 250, 235, 220, 210, 200, 190, 180, 175,
];

function goldSeries(): SymbolSeries {
  return {
    symbol: HEDGE_SYMBOL,
    bars: goldPath.map((p, i) => {
      const d = new Date(2024, 0, i + 1);
      return { date: d.toISOString().slice(0, 10), high: p, low: p, close: p };
    }),
    earnings: [],
  };
}

// Zero-cost so the backtest's fee/slippage bps don't shift sizing away from
// the executor (which has no fee model). Under this config both sides use
// the same formulas: spend = min(delta, cash*(1-buf)); qty = spend/price;
// sell_qty = min(held, |delta|/price).
const cfg = {
  ...DEFAULT_CONFIG,
  initialCash: 100_000,
  baseFeeBps: 0,
  baseSlippageBps: 0,
  slicingSlippageBps: 0,
  cape: 40,
  regime: "risk_on" as const,
  hedgeSymbol: HEDGE_SYMBOL,
  hedgeCashBufferPct: BUFFER,
};

const baseExecArgs = {
  portfolioId: "00000000-0000-0000-0000-000000000000",
  portfolioCurrency: "USD" as const,
  isLivePortfolio: false as const,
  hedgeSymbol: HEDGE_SYMBOL,
  cashBufferPct: BUFFER,
};

// Independent day-by-day replay through the real executor.
function replayViaExecutor(): { trades: Trade[]; finalCash: number; finalQty: number } {
  const series = goldSeries();
  let cash = cfg.initialCash;
  const holdings = new Map<string, Holding>();
  const trades: Trade[] = [];

  for (const bar of series.bars) {
    const price = bar.close;
    const held = Number(holdings.get(HEDGE_SYMBOL)?.quantity ?? 0);
    const nav = cash + held * price;

    const decision = computeTailHedge({
      nav,
      cape: cfg.cape,
      regime: cfg.regime,
      currentHedgeNotional: held * price,
    });

    const before = { cash, held };
    const r = applyTailHedgeToPaperPortfolio({
      ...baseExecArgs,
      decision,
      holdingsByS: holdings,
      workingCash: cash,
      priceMap: new Map([[HEDGE_SYMBOL, price]]),
    });
    cash = r.workingCash;

    if (r.applied && r.trade) {
      trades.push({
        date: bar.date,
        symbol: HEDGE_SYMBOL,
        side: r.trade.side,
        qty: r.trade.quantity,
        price,
        costBps: 0,
        reason: r.trade.reason,
      });
      // Sanity: executor never breaches no-borrow / no-short.
      if (r.trade.side === "buy") {
        expect(before.cash * (1 - BUFFER) + 1e-6).toBeGreaterThanOrEqual(r.trade.quantity * price);
      } else {
        expect(before.held + 1e-9).toBeGreaterThanOrEqual(r.trade.quantity);
      }
    }
  }

  const finalQty = Number(holdings.get(HEDGE_SYMBOL)?.quantity ?? 0);
  return { trades, finalCash: cash, finalQty };
}

describe("Phase 6 backtest ↔ executor: full-timeline integration", () => {
  it("persisted hedge fills mirror the real executor's trade log across buys, holds, and unwinds", () => {
    const bt = runPhaseBacktest(
      [goldSeries()],
      noSignal,
      { ...ALL_PHASES_OFF, hedge: true },
      cfg,
    );

    const btHedgeTrades = bt.trades.filter((t) => t.symbol === HEDGE_SYMBOL);
    const ex = replayViaExecutor();

    // The timeline should actually exercise both sides — otherwise this test
    // is trivially satisfied and would fail to guard against drift.
    expect(btHedgeTrades.some((t) => t.side === "buy")).toBe(true);
    expect(btHedgeTrades.some((t) => t.side === "sell")).toBe(true);

    // Trade-for-trade equality: date, side, price, qty.
    expect(btHedgeTrades.length).toBe(ex.trades.length);
    for (let i = 0; i < btHedgeTrades.length; i++) {
      const a = btHedgeTrades[i];
      const b = ex.trades[i];
      expect(a.date, `date @${i}`).toBe(b.date);
      expect(a.side, `side @${i}`).toBe(b.side);
      expect(a.price, `price @${i}`).toBeCloseTo(b.price, 8);
      expect(a.qty, `qty @${i}`).toBeCloseTo(b.qty, 8);
    }

    // Terminal state parity: cash + hedge market value must agree, and
    // therefore the equity curve endpoint must equal the executor NAV.
    const lastPrice = goldPath[goldPath.length - 1];
    const executorNav = ex.finalCash + ex.finalQty * lastPrice;
    expect(bt.metrics.finalEquity).toBeCloseTo(executorNav, 6);
  });

  it("cumulative signed hedge notional matches between the backtest and the executor replay", () => {
    const bt = runPhaseBacktest(
      [goldSeries()],
      noSignal,
      { ...ALL_PHASES_OFF, hedge: true },
      cfg,
    );
    const ex = replayViaExecutor();

    const sumSigned = (ts: Trade[]) =>
      ts.reduce((acc, t) => acc + (t.side === "buy" ? 1 : -1) * t.qty * t.price, 0);

    const btSigned = sumSigned(bt.trades.filter((t) => t.symbol === HEDGE_SYMBOL));
    const exSigned = sumSigned(ex.trades);
    expect(btSigned).toBeCloseTo(exSigned, 6);
  });
});
