// Extra parity coverage between the Phase 6 backtest runner and the real
// tail-hedge executor: price gaps, missing quotes, and rounding boundaries.
//
// For every day we walk both paths with identical inputs and assert:
//   1. Fill parity — same (side, qty, price) or both no-op.
//   2. Deferral parity — when neither side fills, the executor's reason
//      falls into the same "why" bucket the runner's guards would take.
//
// This locks the two implementations together against the specific failure
// modes real markets throw at Phase 6: overnight gaps, holidays / halts
// with no quote, and share-boundary sizing where a single bp of cost or a
// penny of price changes whether the trade is affordable at all.
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
import { sizeHedgeBuy, sizeHedgeSell } from "@/lib/hedging/tail-hedge-sizing";

import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

const HEDGE = "GLD";
const BUFFER = 0.01;
const noSignal: SignalFn = () => "hold";

type DayInput = { date: string; price: number | null }; // null = quote missing

function buildSeries(days: DayInput[]): SymbolSeries {
  return {
    symbol: HEDGE,
    bars: days
      .filter((d): d is { date: string; price: number } => d.price !== null)
      .map((d) => ({ date: d.date, high: d.price, low: d.price, close: d.price })),
    earnings: [],
  };
}

// Second symbol that carries every date so unionDates() still ticks the
// runner on days where GLD has no quote — mirrors reality where a market
// holiday for gold doesn't stop the rest of the world from trading.
function calendarSpineSeries(days: DayInput[]): SymbolSeries {
  return {
    symbol: "__SPINE__",
    bars: days.map((d) => ({ date: d.date, high: 1, low: 1, close: 1 })),
    earnings: [],
  };
}

type DeferralBucket =
  | "hold"
  | "sub_threshold"
  | "no_price"
  | "insufficient_cash"
  | "no_position_to_unwind";

function classifyExecutorReason(reason: string): DeferralBucket {
  if (reason.startsWith("hold:")) return "hold";
  if (reason.startsWith("no price for")) return "no_price";
  if (reason.startsWith("insufficient cash for 1 share")) return "insufficient_cash";
  if (reason.startsWith("no ") && reason.endsWith(" to unwind")) return "no_position_to_unwind";
  if (reason === "computed sell qty is zero") return "no_position_to_unwind";
  throw new Error(`unknown executor deferral reason: ${reason}`);
}

// Independent day-walk through the real executor, mirroring the runner's
// price semantics (carry-forward last close when a bar is missing). Records
// the same "would runner have skipped and why" bucket so parity checks can
// compare deferral classifications and not just filled trades.
function replayViaExecutor(
  days: DayInput[],
  cfg: RunnerConfig,
): {
  trades: Trade[];
  perDay: Array<{
    date: string;
    filled: boolean;
    trade?: Trade;
    bucket?: DeferralBucket;
    price: number;
    nav: number;
    heldBefore: number;
  }>;
  finalCash: number;
  finalQty: number;
} {
  let cash = cfg.initialCash;
  const holdings = new Map<string, Holding>();
  const trades: Trade[] = [];
  const perDay: ReturnType<typeof replayViaExecutor>["perDay"] = [];
  let lastKnownPrice = 0; // runner's initial hedgePrevClose

  for (const day of days) {
    const price = day.price ?? lastKnownPrice; // carry-forward, matches runner
    const held = Number(holdings.get(HEDGE)?.quantity ?? 0);
    const nav = cash + held * price;

    const decision = computeTailHedge({
      nav,
      cape: cfg.cape,
      regime: cfg.regime,
      currentHedgeNotional: held * price,
    });

    // Only call the executor with a valid price; when the runner would
    // skip on price<=0 we emulate the same "no_price" deferral here.
    const priceMap = price > 0 ? new Map([[HEDGE, price]]) : new Map<string, number>();
    const r = applyTailHedgeToPaperPortfolio({
      portfolioId: "00000000-0000-0000-0000-000000000000",
      portfolioCurrency: "USD",
      isLivePortfolio: false,
      hedgeSymbol: HEDGE,
      cashBufferPct: BUFFER,
      decision,
      holdingsByS: holdings,
      workingCash: cash,
      priceMap,
    });
    cash = r.workingCash;

    if (r.applied && r.trade) {
      const t: Trade = {
        date: day.date,
        symbol: HEDGE,
        side: r.trade.side,
        qty: r.trade.quantity,
        price,
        costBps: 0,
        reason: r.trade.reason,
      };
      trades.push(t);
      perDay.push({ date: day.date, filled: true, trade: t, price, nav, heldBefore: held });
    } else {
      // Sub-threshold hides inside the "hold: within X% NAV threshold"
      // reason string; separate it so parity with the runner's `>= 1`
      // guard is meaningful when both trigger for the same day.
      let bucket = classifyExecutorReason(r.reason);
      if (bucket === "hold" && Math.abs(decision.deltaNotional) > 0 &&
          Math.abs(decision.deltaNotional) < 1) {
        bucket = "sub_threshold";
      }
      perDay.push({ date: day.date, filled: false, bucket, price, nav, heldBefore: held });
    }

    if (day.price !== null) lastKnownPrice = day.price;
  }

  const finalQty = Number(holdings.get(HEDGE)?.quantity ?? 0);
  return { trades, perDay, finalCash: cash, finalQty };
}

// Independent bucket derivation from raw day state, matching the runner's
// implicit guards (see phase-runner.ts around the Phase 6 block). Used to
// prove the executor's classification agrees with the runner's silent skip
// on every deferral day.
function runnerExpectedBucket(
  price: number,
  cash: number,
  held: number,
  cfg: RunnerConfig,
): DeferralBucket | "fill" {
  const nav = cash + held * price;
  const dec = computeTailHedge({
    nav,
    cape: cfg.cape,
    regime: cfg.regime,
    currentHedgeNotional: held * price,
  });
  if (dec.action === "hold") return "hold";
  if (price <= 0) return "no_price";
  if (Math.abs(dec.deltaNotional) < 1) return "sub_threshold";
  // Both paths size through the shared rule (tail-hedge-sizing), so the
  // expectation derives from it too rather than re-deriving the maths.
  if (dec.action === "buy") {
    const sized = sizeHedgeBuy({
      deltaNotional: dec.deltaNotional,
      cash,
      price,
      bufferPct: cfg.hedgeCashBufferPct ?? BUFFER,
      wholeShares: false,
    });
    return sized.ok ? "fill" : "insufficient_cash";
  }
  const sized = sizeHedgeSell({
    deltaNotional: dec.deltaNotional, heldQty: held, price, wholeShares: false,
  });
  return sized.ok ? "fill" : "no_position_to_unwind";
}


function zeroCostCfg(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    ...DEFAULT_CONFIG,
    baseFeeBps: 0,
    baseSlippageBps: 0,
    slicingSlippageBps: 0,
    hedgeSymbol: HEDGE,
    hedgeCashBufferPct: BUFFER,
    cape: 40,
    regime: "risk_on",
    ...overrides,
  };
}

function assertParity(
  days: DayInput[],
  cfg: RunnerConfig,
  expect_: {
    minFills?: number;
    requiredBuckets?: DeferralBucket[]; // buckets that MUST appear on defer days
  } = {},
) {
  const series: SymbolSeries[] = [buildSeries(days), calendarSpineSeries(days)];
  const bt = runPhaseBacktest(series, noSignal, { ...ALL_PHASES_OFF, hedge: true }, cfg);
  const btHedge = bt.trades.filter((t) => t.symbol === HEDGE);
  const ex = replayViaExecutor(days, cfg);

  // Fill parity: same trades in same order.
  expect(btHedge.length).toBe(ex.trades.length);
  for (let i = 0; i < btHedge.length; i++) {
    const a = btHedge[i];
    const b = ex.trades[i];
    expect(a.date, `date @${i}`).toBe(b.date);
    expect(a.side, `side @${i}`).toBe(b.side);
    expect(a.price, `price @${i}`).toBeCloseTo(b.price, 8);
    expect(a.qty, `qty @${i}`).toBeCloseTo(b.qty, 8);
  }

  // Deferral parity: on every non-fill day, executor's bucket must match
  // the bucket derived from the runner's own guard set.
  const filledDates = new Set(btHedge.map((t) => t.date));
  const seenBuckets = new Set<DeferralBucket>();
  for (const d of ex.perDay) {
    if (d.filled) continue;
    expect(filledDates.has(d.date), `runner unexpectedly filled ${d.date}`).toBe(false);
    const expected = runnerExpectedBucket(d.price, d.nav - d.heldBefore * d.price, d.heldBefore, cfg);
    expect(expected, `runner would have filled ${d.date}, executor deferred`).not.toBe("fill");
    expect(d.bucket, `bucket mismatch @${d.date}`).toBe(expected);
    if (d.bucket) seenBuckets.add(d.bucket);
  }

  if (expect_.minFills !== undefined) {
    expect(btHedge.length).toBeGreaterThanOrEqual(expect_.minFills);
  }
  for (const b of expect_.requiredBuckets ?? []) {
    expect(seenBuckets.has(b), `expected to observe bucket "${b}"`).toBe(true);
  }

  // Terminal state parity.
  const lastPrice = [...days].reverse().find((d) => d.price !== null)!.price!;
  expect(bt.metrics.finalEquity).toBeCloseTo(ex.finalCash + ex.finalQty * lastPrice, 6);
}

describe("Phase 6 backtest ↔ executor: edge-case parity", () => {
  it("large overnight gap up forces both paths to unwind identical share counts", () => {
    // Ramp small, then a violent gap up on day 4 (100 → 500), then decay.
    const days: DayInput[] = [
      { date: "2024-01-01", price: 100 },
      { date: "2024-01-02", price: 102 },
      { date: "2024-01-03", price: 105 },
      { date: "2024-01-04", price: 500 }, // gap
      { date: "2024-01-05", price: 480 },
      { date: "2024-01-06", price: 200 }, // gap down (unwind reverses)
      { date: "2024-01-07", price: 180 },
      { date: "2024-01-08", price: 150 },
    ];
    assertParity(days, zeroCostCfg(), { minFills: 3 });
  });

  it("missing quote days (carry-forward last close) still fill identically", () => {
    const days: DayInput[] = [
      { date: "2024-01-01", price: 100 },
      { date: "2024-01-02", price: null },     // holiday
      { date: "2024-01-03", price: null },     // holiday
      { date: "2024-01-04", price: 300 },      // gap-up on reopen
      { date: "2024-01-05", price: null },     // halt
      { date: "2024-01-06", price: 120 },      // gap-down on resume
    ];
    assertParity(days, zeroCostCfg(), { minFills: 2 });
  });

  it("no quote on the first day defers with the same 'no_price' bucket in both paths", () => {
    const days: DayInput[] = [
      { date: "2024-01-01", price: null }, // no prior close → hedgePrevClose = 0
      { date: "2024-01-02", price: null }, // still no price
      { date: "2024-01-03", price: 100 },  // finally a quote → both buy
      { date: "2024-01-04", price: 110 },
    ];
    assertParity(days, zeroCostCfg(), {
      minFills: 1,
      requiredBuckets: ["no_price"],
    });
  });

  it("tiny cash + expensive hedge defers with the same 'insufficient_cash' bucket", () => {
    // NAV=50, cape=40 risk_on → target=1.50, delta ≈ 1.50, but price=10:
    // spend = min(1.50, 50*(1-0.01)) = 1.50 < 10 → both defer.
    const cfg = zeroCostCfg({ initialCash: 50 });
    const days: DayInput[] = [
      { date: "2024-01-01", price: 10 },
      { date: "2024-01-02", price: 10 },
      { date: "2024-01-03", price: 10 },
    ];
    assertParity(days, cfg, { requiredBuckets: ["insufficient_cash"] });
  });

  it("sub-threshold delta after a small rebalance is a shared no-op ('sub_threshold' or 'hold')", () => {
    // Cape at floor → 1% NAV target with baseline pct; tiny price wobble
    // keeps subsequent deltas under the 0.25% NAV rebalance threshold, so
    // both paths must skip once the initial buy is in.
    const cfg = zeroCostCfg({ cape: 18, regime: "risk_on" });
    const days: DayInput[] = [
      { date: "2024-01-01", price: 100 }, // initial buy: target ≈ 1000
      { date: "2024-01-02", price: 100.5 },
      { date: "2024-01-03", price: 100.6 },
      { date: "2024-01-04", price: 100.4 },
      { date: "2024-01-05", price: 100.3 },
    ];
    assertParity(days, cfg, { minFills: 1, requiredBuckets: ["hold"] });
  });

  it("share-boundary rounding: spend just above one share fills exactly one share in both paths", () => {
    // NAV=100, cape=40 risk_on → target 3% NAV = 3.0. Price=3.0 exactly.
    // spend = min(3.0, 100*(1-0.01)) = 3.0; qty = 3.0/3.0 = 1.0. Both fill 1.
    const cfg = zeroCostCfg({ initialCash: 100 });
    const days: DayInput[] = [
      { date: "2024-01-01", price: 3 },
      { date: "2024-01-02", price: 3 },
    ];
    const series: SymbolSeries[] = [buildSeries(days), calendarSpineSeries(days)];
    const bt = runPhaseBacktest(series, noSignal, { ...ALL_PHASES_OFF, hedge: true }, cfg);
    const ex = replayViaExecutor(days, cfg);
    const btHedge = bt.trades.filter((t) => t.symbol === HEDGE);
    expect(btHedge.length).toBe(1);
    expect(btHedge[0].qty).toBeCloseTo(1, 10);
    expect(ex.trades[0].qty).toBeCloseTo(1, 10);
    // Second day is now a hold (delta ≈ 0 after the trade).
    expect(btHedge.every((t) => t.date === "2024-01-01")).toBe(true);
  });

  it("share-boundary rounding: spend one bp below one share defers as insufficient in both paths", () => {
    // Force spend < price by a hair via a $0.01 price bump above target.
    // NAV=100, target=3.0, price=3.01 → spend=3.0 < 3.01 → both defer.
    const cfg = zeroCostCfg({ initialCash: 100 });
    const days: DayInput[] = [
      { date: "2024-01-01", price: 3.01 },
      { date: "2024-01-02", price: 3.01 },
    ];
    assertParity(days, cfg, { requiredBuckets: ["insufficient_cash"] });
  });
});
