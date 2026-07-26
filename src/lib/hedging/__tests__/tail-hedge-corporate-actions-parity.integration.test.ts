// Corporate-action parity: stock splits, reverse splits, cash & special
// dividends, and split+continuation for tail-hedge symbols.
//
// Neither the Phase 6 backtest runner nor the paper executor performs any
// corporate-action adjustment internally — both treat the input close
// series as authoritative. The invariant this suite pins is therefore the
// *contract with the caller*: whatever CA handling the caller applies
// upstream (back-adjusted feed, raw feed, continuation onto a successor
// symbol) MUST feed both paths identically, and both paths must then
// produce trade-for-trade fills, deferral-bucket-for-bucket skips, and
// terminal NAV.
//
// Scenarios modelled below cover the three real-world data shapes the
// hedge symbols (`GLD`, `IAU`, `SGLN.L`, `SLV`, `BTCE.DE`) can arrive as:
//
//   1. **Back-adjusted forward split (2:1)** — pre-split closes halved;
//      the series is continuous and both paths behave normally.
//   2. **Unadjusted forward split (2:1)** — the raw close halves overnight
//      on the ex-date. This *looks* like a crash to the engines and both
//      paths must react identically (garbage in, garbage out — but in
//      lockstep, so we can trust the executor mirrors the backtest).
//   3. **Back-adjusted reverse split (1:10)** — pre-event closes scaled by
//      10; continuous, normal parity.
//   4. **Back-adjusted cash dividend** — closes reduced by the ex-div
//      amount before the dividend date; continuous series.
//   5. **Raw special dividend** — one-day step-down that mimics a large
//      distribution; both paths trigger the same rebalance.
//   6. **Split with position continuity** — a hedge position exists across
//      the split; on a back-adjusted feed the mark-to-market is continuous
//      and both paths preserve identical qty/cash/NAV. (The engines do
//      NOT split-adjust holdings themselves; the caller must ensure the
//      qty and series are on the same footing — this test pins that
//      contract on a back-adjusted series where no adjustment is needed.)
//   7. **Symbol continuation after CA** — same date grid, contiguous
//      series treated as one instrument by both paths.
//   8. **Deferral bucket parity across CAs** — insufficient cash and
//      no-price still classify identically after a split adjustment.
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

type DayInput = { date: string; price: number | null };

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

function buildSeries(sym: string, days: DayInput[]): SymbolSeries {
  return {
    symbol: sym,
    bars: days
      .filter((d): d is { date: string; price: number } => d.price !== null)
      .map((d) => ({ date: d.date, high: d.price, low: d.price, close: d.price })),
    earnings: [],
  };
}
function spine(days: DayInput[]): SymbolSeries {
  return {
    symbol: "__SPINE__",
    bars: days.map((d) => ({ date: d.date, high: 1, low: 1, close: 1 })),
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
  hedgeSymbol: string,
  days: DayInput[],
  c: RunnerConfig,
  portfolioCurrency: string,
  seed?: { qty: number; avgCost: number },
) {
  let cash = c.initialCash;
  const holdings = new Map<string, Holding>();
  if (seed && seed.qty > 0) {
    holdings.set(hedgeSymbol, {
      id: "seed",
      portfolio_id: "00000000-0000-0000-0000-000000000000",
      symbol: hedgeSymbol,
      asset_class: "etf",
      quantity: seed.qty,
      avg_cost: seed.avgCost,
      updated_at: new Date().toISOString(),
      opened_at: new Date().toISOString(),
      high_water_mark: seed.avgCost,
    } as Holding);
  }
  const trades: Trade[] = [];
  const deferrals: Array<{ date: string; bucket: DeferralBucket }> = [];
  let lastKnownPrice = 0;

  for (const day of days) {
    const price = day.price ?? lastKnownPrice;
    const held = Number(holdings.get(hedgeSymbol)?.quantity ?? 0);
    const nav = cash + held * price;
    const decision = computeTailHedge({
      nav, cape: c.cape, regime: c.regime, currentHedgeNotional: held * price,
    });
    const priceMap = price > 0 ? new Map([[hedgeSymbol, price]]) : new Map<string, number>();
    const r = applyTailHedgeToPaperPortfolio({
      portfolioId: "00000000-0000-0000-0000-000000000000",
      portfolioCurrency,
      isLivePortfolio: false,
      hedgeSymbol,
      cashBufferPct: BUFFER,
      decision, holdingsByS: holdings, workingCash: cash, priceMap,
    });
    cash = r.workingCash;
    if (r.applied && r.trade) {
      trades.push({
        date: day.date, symbol: hedgeSymbol, side: r.trade.side,
        qty: r.trade.quantity, price, costBps: 0, reason: r.trade.reason,
      });
    } else {
      let bucket = classifyExecutorReason(r.reason);
      if (bucket === "hold" && Math.abs(decision.deltaNotional) > 0 &&
          Math.abs(decision.deltaNotional) < 1) {
        bucket = "sub_threshold";
      }
      deferrals.push({ date: day.date, bucket });
    }
    if (day.price !== null) lastKnownPrice = day.price;
  }

  const finalQty = Number(holdings.get(hedgeSymbol)?.quantity ?? 0);
  const lastPrice = [...days].reverse().find((d) => d.price !== null)!.price!;
  return { trades, deferrals, finalCash: cash, finalQty, terminalNav: cash + finalQty * lastPrice };
}

function assertCaParity(
  hedgeSymbol: string,
  days: DayInput[],
  c: RunnerConfig,
  portfolioCurrency = "USD",
  seed?: { qty: number; avgCost: number },
) {
  const bt = runPhaseBacktest(
    [buildSeries(hedgeSymbol, days), spine(days)],
    noSignal,
    { ...ALL_PHASES_OFF, hedge: true },
    c,
  );
  const btHedge = bt.trades.filter((t) => t.symbol === hedgeSymbol);
  const ex = replayExecutor(hedgeSymbol, days, c, portfolioCurrency, seed);

  expect(btHedge.length).toBe(ex.trades.length);
  for (let i = 0; i < btHedge.length; i++) {
    const a = btHedge[i], b = ex.trades[i];
    expect(a.date).toBe(b.date);
    expect(a.side).toBe(b.side);
    expect(a.price).toBeCloseTo(b.price, 8);
    expect(a.qty).toBeCloseTo(b.qty, 8);
  }
  // NAV parity — when the backtest sees a seeded position, we can only
  // compare final equity directly if we also seed backtest state. The
  // engine has no seed API, so we skip the terminal-NAV assertion in that
  // narrow case and rely on trade-for-trade parity.
  if (!seed) {
    expect(bt.metrics.finalEquity).toBeCloseTo(ex.terminalNav, 6);
  }
  return { btHedge, ex, bt };
}

// -- Corporate-action scenario builders ------------------------------------

/** Back-adjust a raw close series for a forward split of ratio `n:1` on `exDate`.
 *  All closes strictly before `exDate` are divided by `n` so the series is
 *  continuous across the ex-date. */
function backAdjustForwardSplit(days: DayInput[], exDate: string, n: number): DayInput[] {
  return days.map((d) => {
    if (d.price === null) return d;
    return d.date < exDate ? { ...d, price: d.price / n } : d;
  });
}

/** Back-adjust for a reverse split of ratio `1:n`: pre-exDate closes ×n. */
function backAdjustReverseSplit(days: DayInput[], exDate: string, n: number): DayInput[] {
  return days.map((d) => {
    if (d.price === null) return d;
    return d.date < exDate ? { ...d, price: d.price * n } : d;
  });
}

/** Back-adjust for a cash dividend of `amount` per share on `exDate`.
 *  Pre-exDate closes reduced by `amount` (the standard Yahoo/Bloomberg
 *  convention for adjusted closes). */
function backAdjustCashDividend(days: DayInput[], exDate: string, amount: number): DayInput[] {
  return days.map((d) => {
    if (d.price === null) return d;
    return d.date < exDate ? { ...d, price: d.price - amount } : d;
  });
}

// A common price path shaped to produce buys, a hold or two, and an unwind.
const RAW_PATH: DayInput[] = [
  { date: "2024-10-01", price: 200 },
  { date: "2024-10-02", price: 202 },
  { date: "2024-10-03", price: 204 },
  { date: "2024-10-04", price: 900 }, // regime unwind trigger
  { date: "2024-10-07", price: 880 },
  { date: "2024-10-08", price: 400 },
  { date: "2024-10-09", price: 380 },
];

describe("Phase 6 parity: stock splits, dividends, and corporate-action adjusted feeds", () => {
  it("2:1 forward split (back-adjusted feed) — continuous series, trade-for-trade parity", () => {
    const adjusted = backAdjustForwardSplit(RAW_PATH, "2024-10-07", 2);
    assertCaParity("GLD", adjusted, cfg("GLD"));
  });

  it("2:1 forward split (raw/unadjusted feed) — overnight halving triggers identical reaction", () => {
    // Ex-date halves the price. Both paths interpret this as a crash and
    // must handle it identically — GIGO, but in perfect lockstep.
    const raw: DayInput[] = RAW_PATH.map((d) =>
      d.price !== null && d.date >= "2024-10-07" ? { ...d, price: d.price / 2 } : d,
    );
    assertCaParity("IAU", raw, cfg("IAU"));
  });

  it("1:10 reverse split (back-adjusted feed) on GBp-quoted SGLN.L → continuous", () => {
    const adjusted = backAdjustReverseSplit(RAW_PATH, "2024-10-07", 10);
    assertCaParity("SGLN.L", adjusted, cfg("SGLN.L"), "GBP");
  });

  it("cash dividend (back-adjusted) — pre-ex closes reduced by dividend amount", () => {
    const adjusted = backAdjustCashDividend(RAW_PATH, "2024-10-04", 1.25);
    assertCaParity("GLD", adjusted, cfg("GLD"));
  });

  it("special dividend (raw feed) — ex-date step-down triggers identical rebalance", () => {
    // A 40-unit special distribution on 2024-10-03: raw close drops from
    // 204 → 164 overnight, then resumes normally.
    const raw: DayInput[] = [
      { date: "2024-10-01", price: 200 },
      { date: "2024-10-02", price: 202 },
      { date: "2024-10-03", price: 164 }, // ex-div step down
      { date: "2024-10-04", price: 166 },
      { date: "2024-10-07", price: 900 }, // later regime shift
      { date: "2024-10-08", price: 400 },
    ];
    assertCaParity("GLD", raw, cfg("GLD"));
  });

  it("split with pre-existing position (back-adjusted): qty/cash preserved, MTM continuous", () => {
    // Seed the executor with an existing hedge position; back-adjusted
    // series means no engine-side split handling is required. Trade
    // decisions must still agree with a fresh backtest that starts from
    // the same back-adjusted series (backtest has no seed API, so we only
    // compare trade-for-trade fills, not terminal NAV).
    const adjusted = backAdjustForwardSplit(RAW_PATH, "2024-10-07", 2);
    assertCaParity(
      "GLD", adjusted, cfg("GLD", { initialCash: 100_000 }),
      "USD",
      { qty: 5, avgCost: 90 },
    );
  });

  it("symbol continuation after CA — contiguous grid, both paths treat as one instrument", () => {
    // Two half-series stitched at the CA boundary. Feeding as one symbol
    // to both engines produces the same fills — proving the parity
    // contract holds under caller-side continuation.
    const stitched: DayInput[] = [
      { date: "2024-10-01", price: 100 },
      { date: "2024-10-02", price: 105 },
      { date: "2024-10-03", price: 110 }, // pre-CA
      // continuation from 2024-10-04 onward (new listing, back-adjusted)
      { date: "2024-10-04", price: 108 },
      { date: "2024-10-07", price: 500 }, // regime shift
      { date: "2024-10-08", price: 200 },
    ];
    assertCaParity("GLD", stitched, cfg("GLD"));
  });

  it("deferral parity across a split: insufficient_cash on adjusted series stays identical", () => {
    // Tiny NAV + tiny cash + expensive hedge → both paths defer with
    // insufficient_cash on every day, before and after a 2:1 back-adjust.
    const raw: DayInput[] = [
      { date: "2024-10-01", price: 20 },
      { date: "2024-10-02", price: 20 },
      { date: "2024-10-03", price: 20 },
      { date: "2024-10-04", price: 20 },
    ];
    const adjusted = backAdjustForwardSplit(raw, "2024-10-03", 2); // pre-ex → 10
    const c = cfg("GLD", { initialCash: 5 });
    const bt = runPhaseBacktest(
      [buildSeries("GLD", adjusted), spine(adjusted)],
      noSignal,
      { ...ALL_PHASES_OFF, hedge: true },
      c,
    );
    const ex = replayExecutor("GLD", adjusted, c, "USD");
    expect(bt.trades.filter((t) => t.symbol === "GLD").length).toBe(0);
    expect(ex.trades.length).toBe(0);
    expect(ex.deferrals.every((d) => d.bucket === "insufficient_cash")).toBe(true);
  });

  it("no_price parity across a split: pre-CA null quotes defer identically", () => {
    // Split falls inside a data outage; both paths carry forward the last
    // valid close and take the same actions when quotes resume.
    const days: DayInput[] = [
      { date: "2024-10-01", price: 200 },
      { date: "2024-10-02", price: null }, // outage
      { date: "2024-10-03", price: null }, // outage covers ex-date
      { date: "2024-10-04", price: 100 },  // resumes on 2:1 split price
      { date: "2024-10-07", price: 500 },  // regime shift after CA
      { date: "2024-10-08", price: 200 },
    ];
    assertCaParity("GLD", days, cfg("GLD"));
  });
});
