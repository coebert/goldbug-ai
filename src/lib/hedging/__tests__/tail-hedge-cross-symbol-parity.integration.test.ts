// Cross-symbol parity: same Phase 6 advisory scenarios as the edge-case
// suite, run against every hedge symbol we might plausibly configure per
// portfolio (US gold, LSE gold, silver, and a crypto ETP proxy). Fills
// and deferral buckets must remain identical to the backtest runner for
// each choice — otherwise switching `hedgeSymbol` per portfolio would
// silently change execution behavior versus the persisted Phase 6 report.
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

import { findSymbol } from "@/lib/universe.server";
import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];
const BUFFER = 0.01;
const noSignal: SignalFn = () => "hold";

type DayInput = { date: string; price: number | null };

type DeferralBucket =
  | "hold" | "sub_threshold" | "no_price" | "insufficient_cash" | "no_position_to_unwind";

function classifyExecutorReason(reason: string): DeferralBucket {
  if (reason.startsWith("hold:")) return "hold";
  if (reason.startsWith("no price for")) return "no_price";
  if (reason.startsWith("insufficient cash for 1 share")) return "insufficient_cash";
  if (reason.startsWith("no ") && reason.endsWith(" to unwind")) return "no_position_to_unwind";
  if (reason === "computed sell qty is zero") return "no_position_to_unwind";
  throw new Error(`unknown executor deferral reason: ${reason}`);
}

function makeHarness(HEDGE: string) {
  const buildSeries = (days: DayInput[]): SymbolSeries => ({
    symbol: HEDGE,
    bars: days
      .filter((d): d is { date: string; price: number } => d.price !== null)
      .map((d) => ({ date: d.date, high: d.price, low: d.price, close: d.price })),
    earnings: [],
  });
  const spine = (days: DayInput[]): SymbolSeries => ({
    symbol: "__SPINE__",
    bars: days.map((d) => ({ date: d.date, high: 1, low: 1, close: 1 })),
    earnings: [],
  });

  const cfg = (overrides: Partial<RunnerConfig> = {}): RunnerConfig => ({
    ...DEFAULT_CONFIG,
    baseFeeBps: 0,
    baseSlippageBps: 0,
    slicingSlippageBps: 0,
    hedgeSymbol: HEDGE,
    hedgeCashBufferPct: BUFFER,
    cape: 40,
    regime: "risk_on",
    ...overrides,
  });

  function replayViaExecutor(days: DayInput[], c: RunnerConfig) {
    let cash = c.initialCash;
    const holdings = new Map<string, Holding>();
    const trades: Trade[] = [];
    const perDay: Array<{
      date: string; filled: boolean; bucket?: DeferralBucket;
      price: number; nav: number; heldBefore: number;
    }> = [];
    let lastPrice = 0;

    for (const day of days) {
      const price = day.price ?? lastPrice;
      const held = Number(holdings.get(HEDGE)?.quantity ?? 0);
      const nav = cash + held * price;
      const decision = computeTailHedge({
        nav, cape: c.cape, regime: c.regime, currentHedgeNotional: held * price,
      });
      const priceMap = price > 0 ? new Map([[HEDGE, price]]) : new Map<string, number>();
      const r = applyTailHedgeToPaperPortfolio({
        portfolioId: "00000000-0000-0000-0000-000000000000",
        portfolioCurrency: "USD",
        isLivePortfolio: false,
        hedgeSymbol: HEDGE,
        cashBufferPct: BUFFER,
        decision, holdingsByS: holdings, workingCash: cash, priceMap,
      });
      cash = r.workingCash;
      if (r.applied && r.trade) {
        trades.push({
          date: day.date, symbol: HEDGE, side: r.trade.side,
          qty: r.trade.quantity, price, costBps: 0, reason: r.trade.reason,
        });
        perDay.push({ date: day.date, filled: true, price, nav, heldBefore: held });
      } else {
        let bucket = classifyExecutorReason(r.reason);
        if (bucket === "hold" && Math.abs(decision.deltaNotional) > 0 &&
            Math.abs(decision.deltaNotional) < 1) bucket = "sub_threshold";
        perDay.push({ date: day.date, filled: false, bucket, price, nav, heldBefore: held });
      }
      if (day.price !== null) lastPrice = day.price;
    }
    const finalQty = Number(holdings.get(HEDGE)?.quantity ?? 0);
    return { trades, perDay, finalCash: cash, finalQty };
  }

  function runnerExpectedBucket(
    price: number, cash: number, held: number, c: RunnerConfig,
  ): DeferralBucket | "fill" {
    const nav = cash + held * price;
    const dec = computeTailHedge({
      nav, cape: c.cape, regime: c.regime, currentHedgeNotional: held * price,
    });
    if (dec.action === "hold") return "hold";
    if (price <= 0) return "no_price";
    if (Math.abs(dec.deltaNotional) < 1) return "sub_threshold";
    // Both paths size through the shared rule, so the expectation does too.
    if (dec.action === "buy") {
      const sized = sizeHedgeBuy({
        deltaNotional: dec.deltaNotional,
        cash,
        price,
        bufferPct: c.hedgeCashBufferPct ?? BUFFER,
        wholeShares: false,
      });
      return sized.ok ? "fill" : "insufficient_cash";
    }
    const sized = sizeHedgeSell({
      deltaNotional: dec.deltaNotional, heldQty: held, price, wholeShares: false,
    });
    return sized.ok ? "fill" : "no_position_to_unwind";
  }


  function assertParity(
    days: DayInput[],
    c: RunnerConfig,
    opts: { minFills?: number; requiredBuckets?: DeferralBucket[] } = {},
  ) {
    const series: SymbolSeries[] = [buildSeries(days), spine(days)];
    const bt = runPhaseBacktest(series, noSignal, { ...ALL_PHASES_OFF, hedge: true }, c);
    const btHedge = bt.trades.filter((t) => t.symbol === HEDGE);
    const ex = replayViaExecutor(days, c);

    expect(btHedge.length).toBe(ex.trades.length);
    for (let i = 0; i < btHedge.length; i++) {
      const a = btHedge[i], b = ex.trades[i];
      expect(a.date, `date @${i}`).toBe(b.date);
      expect(a.side, `side @${i}`).toBe(b.side);
      expect(a.price, `price @${i}`).toBeCloseTo(b.price, 8);
      expect(a.qty, `qty @${i}`).toBeCloseTo(b.qty, 8);
      expect(a.symbol, `symbol @${i}`).toBe(HEDGE);
    }

    const filledDates = new Set(btHedge.map((t) => t.date));
    const seen = new Set<DeferralBucket>();
    for (const d of ex.perDay) {
      if (d.filled) continue;
      expect(filledDates.has(d.date), `runner unexpectedly filled ${d.date}`).toBe(false);
      const expected = runnerExpectedBucket(
        d.price, d.nav - d.heldBefore * d.price, d.heldBefore, c,
      );
      expect(expected, `runner would have filled ${d.date}`).not.toBe("fill");
      expect(d.bucket, `bucket @${d.date}`).toBe(expected);
      if (d.bucket) seen.add(d.bucket);
    }

    if (opts.minFills !== undefined) expect(btHedge.length).toBeGreaterThanOrEqual(opts.minFills);
    for (const b of opts.requiredBuckets ?? []) {
      expect(seen.has(b), `expected bucket "${b}"`).toBe(true);
    }

    const lastPrice = [...days].reverse().find((d) => d.price !== null)!.price!;
    expect(bt.metrics.finalEquity).toBeCloseTo(ex.finalCash + ex.finalQty * lastPrice, 6);
  }

  return { cfg, assertParity };
}

// Configurable hedge instruments the app may pick per portfolio. All must
// resolve in the universe or the executor rejects them with "unknown hedge
// symbol", which would be a different (fatal) failure mode than parity.
const HEDGE_SYMBOLS = ["GLD", "IAU", "SGLN.L", "SLV", "BTCE.DE"] as const;

describe("Phase 6 backtest ↔ executor: parity across configurable hedge symbols", () => {
  it.each(HEDGE_SYMBOLS)("%s resolves in the universe (executor precondition)", (sym) => {
    expect(findSymbol(sym)).toBeTruthy();
  });

  describe.each(HEDGE_SYMBOLS)("hedgeSymbol = %s", (HEDGE) => {
    const { cfg, assertParity } = makeHarness(HEDGE);

    it("overnight gap up and down: fills match trade-for-trade", () => {
      assertParity(
        [
          { date: "2024-01-01", price: 100 },
          { date: "2024-01-02", price: 102 },
          { date: "2024-01-03", price: 105 },
          { date: "2024-01-04", price: 500 },
          { date: "2024-01-05", price: 480 },
          { date: "2024-01-06", price: 200 },
          { date: "2024-01-07", price: 180 },
          { date: "2024-01-08", price: 150 },
        ],
        cfg(),
        { minFills: 3 },
      );
    });

    it("missing quote days carry forward last close in both paths", () => {
      assertParity(
        [
          { date: "2024-01-01", price: 100 },
          { date: "2024-01-02", price: null },
          { date: "2024-01-03", price: null },
          { date: "2024-01-04", price: 300 },
          { date: "2024-01-05", price: null },
          { date: "2024-01-06", price: 120 },
        ],
        cfg(),
        { minFills: 2 },
      );
    });

    it("no first-day quote defers with 'no_price' in both paths", () => {
      assertParity(
        [
          { date: "2024-01-01", price: null },
          { date: "2024-01-02", price: null },
          { date: "2024-01-03", price: 100 },
          { date: "2024-01-04", price: 110 },
        ],
        cfg(),
        { minFills: 1, requiredBuckets: ["no_price"] },
      );
    });

    it("tiny cash + expensive hedge defers with 'insufficient_cash'", () => {
      assertParity(
        [
          { date: "2024-01-01", price: 10 },
          { date: "2024-01-02", price: 10 },
          { date: "2024-01-03", price: 10 },
        ],
        cfg({ initialCash: 50 }),
        { requiredBuckets: ["insufficient_cash"] },
      );
    });

    it("post-initial-buy stability triggers 'hold' rebalance threshold", () => {
      assertParity(
        [
          { date: "2024-01-01", price: 100 },
          { date: "2024-01-02", price: 100.5 },
          { date: "2024-01-03", price: 100.6 },
          { date: "2024-01-04", price: 100.4 },
          { date: "2024-01-05", price: 100.3 },
        ],
        cfg({ cape: 18, regime: "risk_on" }),
        { minFills: 1, requiredBuckets: ["hold"] },
      );
    });

    it("share-boundary rounding: spend one bp under one share defers as insufficient", () => {
      assertParity(
        [
          { date: "2024-01-01", price: 3.01 },
          { date: "2024-01-02", price: 3.01 },
        ],
        cfg({ initialCash: 100 }),
        { requiredBuckets: ["insufficient_cash"] },
      );
    });
  });
});
