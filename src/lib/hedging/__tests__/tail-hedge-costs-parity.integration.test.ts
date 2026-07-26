// Cost-inclusive parity: bid/ask spread, commissions, and slippage.
//
// The Phase 6 backtest runner inflates buy prices by `costBps` and deflates
// sell proceeds by the same amount (`baseFeeBps + baseSlippageBps`, or
// `+ slicingSlippageBps` when execution slicing is active). The paper
// executor `applyTailHedgeToPaperPortfolio` is cost-blind by design — the
// broker returns real fills for live modes, and paper-mode cost accounting
// happens one layer up in the executor pipeline.
//
// The existing zero-cost parity tests pin sizing / cap / regime logic.
// This suite pins the *contract with the cost model*: whenever the same
// bid/ask half-spread and commission/slippage bps are applied on top of
// the executor's fills, trade-for-trade quantities, prices, and NAV agree
// with the backtest runner across:
//   • commission only
//   • commission + immediate-market slippage
//   • commission + wider VWAP slippage (Phase 4 slicing on)
//   • commission + slippage + a bid/ask half-spread
//   • extreme cost regime (100bps per side) with wide spread
//   • zero-cost sanity check (regression pin against legacy tests)
//
// The `costAwareExecutorReplay` helper below mirrors the exact cost
// formulas the backtest applies (`price * (1 ± bps/10_000)`) on top of
// the paper executor's raw fills. If the executor's sizing/cap semantics
// ever drift from the backtest, both fill quantity and post-trade cash
// diverge and this suite fails.
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

function cfg(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    ...DEFAULT_CONFIG,
    baseFeeBps: 0,
    baseSlippageBps: 0,
    slicingSlippageBps: 0,
    hedgeSymbol: "GLD",
    hedgeCashBufferPct: BUFFER,
    cape: 40,
    regime: "risk_on",
    ...overrides,
  };
}

type CostModel = {
  /** Commission (bps) charged both sides. */
  feeBps: number;
  /** Immediate-market slippage (bps) charged both sides when not sliced. */
  slipBps: number;
  /** Half of bid/ask spread (bps): buys pay ask=mid+half, sells receive bid=mid-half. */
  halfSpreadBps: number;
  /** Slicing enabled → use slicingSlippageBps instead of slipBps. */
  sliced?: boolean;
  slicingSlipBps?: number;
};

function perSideBps(m: CostModel): number {
  const slip = m.sliced ? (m.slicingSlipBps ?? 0) : m.slipBps;
  return m.feeBps + slip + m.halfSpreadBps;
}

/**
 * Cost-aware executor replay. Runs the same paper executor the trading
 * engine uses, but applies the shared cost model on top of each fill so
 * quantities and cash agree with the backtest runner's cost math.
 *
 * Implementation:
 *   • decision inputs (nav, currentHedgeNotional) use the raw mid price,
 *     identical to the backtest's `hedgePriceOn(date)` semantics;
 *   • the executor is fed a per-side adjusted price so its
 *     `qty = spend/price` and cash movements match the backtest's
 *     `price*(1+bps/1e4)` for buys and `price*(1-bps/1e4)` for sells.
 */
function costAwareExecutorReplay(
  days: Array<{ date: string; price: number }>,
  c: RunnerConfig,
  portfolioCurrency: string,
  model: CostModel,
) {
  const bps = perSideBps(model);
  let cash = c.initialCash;
  const holdings = new Map<string, Holding>();
  const trades: Trade[] = [];
  for (const day of days) {
    const mid = day.price;
    const held = Number(holdings.get(c.hedgeSymbol!)?.quantity ?? 0);
    const nav = cash + held * mid;
    const decision = computeTailHedge({
      nav, cape: c.cape, regime: c.regime, currentHedgeNotional: held * mid,
    });
    let execPrice = mid;
    if (decision.action === "buy") execPrice = mid * (1 + bps / 10_000);
    else if (decision.action === "sell") execPrice = mid * (1 - bps / 10_000);
    const priceMap = mid > 0 ? new Map([[c.hedgeSymbol!, execPrice]]) : new Map<string, number>();
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
        qty: r.trade.quantity, price: mid, costBps: bps, reason: r.trade.reason,
      });
    }
  }
  const finalQty = Number(holdings.get(c.hedgeSymbol!)?.quantity ?? 0);
  const lastMid = days[days.length - 1].price;
  return { trades, finalCash: cash, finalQty, terminalNav: cash + finalQty * lastMid };
}

function assertCostParity(
  days: Array<{ date: string; price: number }>,
  model: CostModel,
  overrides: Partial<RunnerConfig> = {},
) {
  const c = cfg({
    ...overrides,
    baseFeeBps: model.feeBps + model.halfSpreadBps,
    baseSlippageBps: model.slipBps,
    slicingSlippageBps: model.slicingSlipBps ?? 0,
  });
  const flags = { ...ALL_PHASES_OFF, hedge: true, slicing: !!model.sliced };
  const bt = runPhaseBacktest(
    [
      makeSeries(c.hedgeSymbol!, days),
      makeSeries("__SPINE__", days.map((d) => ({ date: d.date, price: 1 }))),
    ],
    noSignal,
    flags,
    c,
  );
  const btHedge = bt.trades.filter((t) => t.symbol === c.hedgeSymbol);
  const ex = costAwareExecutorReplay(days, c, "GBP", model);

  expect(btHedge.length).toBe(ex.trades.length);
  expect(btHedge.length).toBeGreaterThan(0);
  for (let i = 0; i < btHedge.length; i++) {
    const a = btHedge[i], b = ex.trades[i];
    expect(a.date).toBe(b.date);
    expect(a.side).toBe(b.side);
    expect(a.price).toBeCloseTo(b.price, 8); // mid price
    expect(a.qty).toBeCloseTo(b.qty, 8);
    expect(a.costBps).toBe(b.costBps);       // shared cost model
  }
  expect(bt.metrics.finalEquity).toBeCloseTo(ex.terminalNav, 6);
  return { btHedge, ex, bt };
}

// A price path that exercises buy → hold → unwind so every cost path
// actually pays commission/slippage/spread on both sides.
const PRICE_PATH = [
  { date: "2024-09-02", price: 100 },
  { date: "2024-09-03", price: 105 },
  { date: "2024-09-04", price: 110 },
  { date: "2024-09-05", price: 500 }, // regime unwind trigger
  { date: "2024-09-06", price: 480 },
  { date: "2024-09-09", price: 200 },
  { date: "2024-09-10", price: 180 },
];

describe("Phase 6 parity: bid/ask spread + commissions + slippage", () => {
  it("commission only (10bps per side) — trade-for-trade + NAV parity", () => {
    assertCostParity(PRICE_PATH, { feeBps: 10, slipBps: 0, halfSpreadBps: 0 });
  });

  it("commission + immediate-market slippage (10 + 15 bps)", () => {
    assertCostParity(PRICE_PATH, { feeBps: 10, slipBps: 15, halfSpreadBps: 0 });
  });

  it("commission + VWAP slippage under Phase 4 slicing (10 + 4 bps sliced)", () => {
    assertCostParity(PRICE_PATH, {
      feeBps: 10, slipBps: 15, slicingSlipBps: 4, halfSpreadBps: 0, sliced: true,
    });
  });

  it("commission + slippage + bid/ask half-spread (8 + 6 + 12 bps)", () => {
    assertCostParity(PRICE_PATH, { feeBps: 8, slipBps: 6, halfSpreadBps: 12 });
  });

  it("extreme cost regime (100 bps commission + 50 bps spread) still matches", () => {
    assertCostParity(PRICE_PATH, { feeBps: 100, slipBps: 20, halfSpreadBps: 50 });
  });

  it("zero-cost sanity check (regression pin: matches legacy parity tests)", () => {
    assertCostParity(PRICE_PATH, { feeBps: 0, slipBps: 0, halfSpreadBps: 0 });
  });

  it("cost model reduces NAV monotonically vs zero-cost baseline", () => {
    const baseline = (() => {
      const c = cfg();
      const bt = runPhaseBacktest(
        [
          makeSeries(c.hedgeSymbol!, PRICE_PATH),
          makeSeries("__SPINE__", PRICE_PATH.map((d) => ({ date: d.date, price: 1 }))),
        ],
        noSignal,
        { ...ALL_PHASES_OFF, hedge: true },
        c,
      );
      return bt.metrics.finalEquity;
    })();

    const costs: CostModel[] = [
      { feeBps: 5, slipBps: 0, halfSpreadBps: 0 },
      { feeBps: 10, slipBps: 10, halfSpreadBps: 0 },
      { feeBps: 10, slipBps: 10, halfSpreadBps: 15 },
      { feeBps: 50, slipBps: 20, halfSpreadBps: 30 },
    ];
    let prev = baseline;
    for (const m of costs) {
      const { ex } = assertCostParity(PRICE_PATH, m);
      // Every extra bp of round-trip cost strictly reduces NAV.
      expect(ex.terminalNav).toBeLessThanOrEqual(prev + 1e-9);
      prev = ex.terminalNav;
    }
  });
});
