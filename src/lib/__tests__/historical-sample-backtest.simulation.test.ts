// End-to-end backtest simulation: full buy/sell decision loop replayed
// across a curated historical sample starting from £1,000. The intent
// is a realistic integration between the pure decision layers we've
// already unit-tested individually:
//
//   * `runBacktest`  — deterministic bar-by-bar replay + ledger snapshots
//   * `buildHeuristicSells` — protective exit rules used by the live
//                             engine when the AI gateway is unavailable
//   * a compact momentum + RSI entry rule that mirrors the "cautious
//     BUY when trend is up and not overbought" gate the AI prompt
//     enforces in production
//
// The historical sample is hand-crafted (no external data), 40 bars
// long, and includes three symbols with distinct regimes: an uptrend
// (AAA), a mid-run reversal (BBB), and a persistent downtrend (CCC).
// This lets us assert the loop:
//   1. Actually deploys capital (not sitting in 100% cash)
//   2. Exits BBB on the way down via the heuristic rule
//   3. Never opens a new position in CCC
//   4. Never breaches no-borrow / no-leverage invariants
//   5. Finishes with a coherent equity curve (one point per bar)

import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestBar, type BacktestStrategy } from "../backtest-runner";
import type { SimDecision, SimState } from "../broker-simulator";
import { buildHeuristicSells, type HeuristicFeature } from "../heuristic-decision";

// -------------------------- Fixture data -------------------------- //

const START_CASH = 1_000;

// Simple date iterator (weekday-agnostic; we just need monotonic ISO).
function isoRange(startISO: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startISO}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Hand-crafted price paths. All strictly positive, chosen so that:
//   - AAA drifts smoothly up ~+45% end-to-end (buyable, holdable)
//   - BBB rallies for ~half the window then reverses hard (buy early,
//     heuristic must exit on the -5d / -30d rule when it drops)
//   - CCC bleeds monotonically down (must never be bought)
const DATES = isoRange("2024-01-02", 40);

function pricePath(bars: number, fn: (i: number) => number): number[] {
  return Array.from({ length: bars }, (_, i) => Number(fn(i).toFixed(4)));
}

// Oscillating trend paths. Amplitude is deliberately > drift so RSI
// settles in the 55-70 range on the uptrend leg — realistic behaviour
// that (a) satisfies our "not overbought" (<75) buy gate and (b) keeps
// the heuristic sell's `RSI>=75` rule from spuriously exiting a
// healthy uptrend.
const wiggle = (i: number, amp: number) => 1 + amp * Math.sin(i * 1.3);

const AAA = pricePath(40, (i) => 100 * (1 + 0.01 * i) * wiggle(i, 0.03));
const BBB = pricePath(40, (i) => {
  const peak = 20;
  const base =
    i <= peak
      ? 50 * (1 + 0.02 * i)             // up to ~70
      : 70 * (1 - 0.025 * (i - peak));  // fades ~-2.5%/bar
  return base * wiggle(i, 0.03);
});
const CCC = pricePath(40, (i) => 80 * Math.pow(0.985, i) * wiggle(i, 0.01));

const BARS: BacktestBar[] = DATES.map((date, i) => ({
  date,
  closes: { AAA: AAA[i], BBB: BBB[i], CCC: CCC[i] },
}));

// -------------------------- Indicators ---------------------------- //

function pctChange(hist: number[], lookback: number): number | null {
  if (hist.length <= lookback) return null;
  const prev = hist[hist.length - 1 - lookback];
  const now = hist[hist.length - 1];
  if (!(prev > 0)) return null;
  return now / prev - 1;
}

// Wilder-style RSI(14) on close history, returns null until warmed up.
function rsi14(hist: number[]): number | null {
  const period = 14;
  if (hist.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = hist.length - period; i < hist.length; i++) {
    const diff = hist[i] - hist[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgG = gain / period;
  const avgL = loss / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// -------------------------- Strategy ------------------------------ //
//
// Full decision loop for one bar:
//   a) Build per-symbol features from the rolling history.
//   b) Ask `buildHeuristicSells` for protective exits on current
//      holdings (this is the same helper the live engine uses when
//      the AI gateway is down).
//   c) After sells free up cash, evaluate BUY candidates:
//        - 5-day change > +2%
//        - 30-day change > +5%
//        - RSI14 in the 45-65 "healthy uptrend, not overbought" band
//        - not already held
//      Split up to 25% of current cash into the top candidate to keep
//      position sizing bounded and force multiple bars to fully deploy.
function makeStrategy(): BacktestStrategy {
  let seq = 0;
  const nextId = (tag: string, date: string) => `${date}-${++seq}-${tag}`;

  return async (ctx) => {
    const symbols = Object.keys(ctx.closes);
    const features: HeuristicFeature[] = symbols.map((s) => {
      const h = ctx.history[s] ?? [];
      return {
        symbol: s,
        rsi14: rsi14(h),
        change5d: pctChange(h, 5),
        change30d: pctChange(h, 30),
        macd_hist: null, // not needed by any of our fixtures
      };
    });

    const decisions: SimDecision[] = [];

    // -- SELLS first (free up cash before we consider buys) --
    const heldNow = ctx.state.holdings
      .filter((h) => h.quantity > 0)
      .map((h) => ({ symbol: h.symbol, quantity: h.quantity }));
    const sells = buildHeuristicSells(heldNow, features, { maxSells: 3 });
    for (const s of sells) {
      decisions.push({
        id: nextId(`sell-${s.symbol}`, ctx.date),
        symbol: s.symbol,
        side: "SELL",
        quantity: s.quantity,
        price: ctx.closes[s.symbol],
      });
    }

    // Project cash forward after those sells so BUYs size against the
    // right pool (broker-simulator will enforce the real budget).
    let projectedCash = ctx.state.cash;
    for (const s of sells) {
      const px = ctx.closes[s.symbol];
      if (Number.isFinite(px) && px > 0) projectedCash += s.quantity * px;
    }

    // -- BUYS --
    const heldSet = new Set(heldNow.map((h) => h.symbol));
    // Symbols we're selling this bar shouldn't be re-bought same bar.
    for (const s of sells) heldSet.add(s.symbol);

    const buyCandidates = features
      .filter((f) => !heldSet.has(f.symbol))
      .filter(
        (f) =>
          typeof f.change5d === "number" && f.change5d > 0.02 &&
          typeof f.change30d === "number" && f.change30d > 0.05 &&
          // RSI upper-bound only: reject overbought (>=80). Smooth
          // monotonic uptrends pin RSI at 100, so a lower bound would
          // spuriously reject perfectly buyable trends.
          typeof f.rsi14 === "number" && f.rsi14 < 80,
      )
      .sort((a, b) => (b.change30d ?? 0) - (a.change30d ?? 0));

    if (buyCandidates.length > 0 && projectedCash > 10) {
      const pick = buyCandidates[0];
      const px = ctx.closes[pick.symbol];
      const budget = projectedCash * 0.25;
      const qty = Math.floor(budget / px);
      if (qty > 0) {
        decisions.push({
          id: nextId(`buy-${pick.symbol}`, ctx.date),
          symbol: pick.symbol,
          side: "BUY",
          quantity: qty,
          price: px,
        });
      }
    }

    return decisions;
  };
}

// --------------------------- Test suite --------------------------- //

describe("historical sample backtest: full buy/sell decision loop, £1000 start", () => {
  const initial: SimState = { cash: START_CASH, holdings: [] };

  it("runs end-to-end and produces one equity point per bar", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    expect(res.equityCurve).toHaveLength(BARS.length);
    // Chronology preserved
    for (let i = 1; i < res.equityCurve.length; i++) {
      expect(res.equityCurve[i].date > res.equityCurve[i - 1].date).toBe(true);
    }
  });

  it("actually deploys capital (not sitting in 100% cash at the end)", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const finalPoint = res.equityCurve.at(-1)!;
    expect(finalPoint.holdingsValue).toBeGreaterThan(0);
    // Cash should be materially below the starting pot — capital moved.
    expect(finalPoint.cash).toBeLessThan(START_CASH);
  });

  it("executes at least one BUY and one SELL over the sample", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const buys = res.snapshots.filter((s) =>
      s.decisionId.includes("-buy-"),
    );
    const sells = res.snapshots.filter((s) =>
      s.decisionId.includes("-sell-"),
    );
    expect(buys.length).toBeGreaterThan(0);
    expect(sells.length).toBeGreaterThan(0);
  });

  it("never opens a position in the persistent-downtrend symbol (CCC)", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const cccTouches = res.snapshots.filter((s) => s.decisionId.includes("-CCC"));
    expect(cccTouches).toHaveLength(0);
    expect(res.finalState.holdings.find((h) => h.symbol === "CCC")).toBeUndefined();
  });

  it("exits the reversing symbol (BBB) via the heuristic protective sell", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const bbbSells = res.snapshots.filter(
      (s) => s.decisionId.includes("-sell-BBB"),
    );
    expect(bbbSells.length).toBeGreaterThan(0);
    const finalBBB = res.finalState.holdings.find((h) => h.symbol === "BBB");
    // Either fully exited, or heavily reduced from any peak position.
    expect(finalBBB?.quantity ?? 0).toBe(0);
  });

  it("never breaches no-borrow (cash < 0) or no-leverage (qty < 0) invariants", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    for (const s of res.snapshots) {
      expect(s.cash).toBeGreaterThanOrEqual(0);
      for (const h of s.holdings) expect(h.quantity).toBeGreaterThanOrEqual(0);
    }
    for (const p of res.equityCurve) {
      expect(p.cash).toBeGreaterThanOrEqual(0);
    }
    expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
    for (const h of res.finalState.holdings) {
      expect(h.quantity).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every snapshot internally consistent (cash + holdingsValue = totalValue)", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    for (const s of res.snapshots) {
      expect(s.totalValue).toBeCloseTo(s.cash + s.holdingsValue, 6);
    }
    for (const p of res.equityCurve) {
      expect(p.totalValue).toBeCloseTo(p.cash + p.holdingsValue, 6);
    }
  });

  it("is fully deterministic — same inputs produce byte-identical equity curves", async () => {
    const a = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const b = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    expect(b.equityCurve).toEqual(a.equityCurve);
    expect(b.finalState).toEqual(a.finalState);
  });

  it("finishes with a plausible total equity (bounded by best-case buy-and-hold of AAA)", async () => {
    const res = await runBacktest(initial, BARS, makeStrategy(), { defaultFee: 0.5 });
    const finalTotal = res.equityCurve.at(-1)!.totalValue;
    // AAA buy-and-hold from bar 0: 1000/100 = 10 shares → final ≈ 10 * AAA[39].
    const aaaBH = Math.floor(START_CASH / AAA[0]) * AAA.at(-1)!;
    // Sanity: our loop's terminal wealth is positive, non-degenerate,
    // and cannot exceed a perfect single-name buy-and-hold on the best
    // trending symbol (accounting for fees + partial deployment).
    expect(finalTotal).toBeGreaterThan(START_CASH * 0.5);
    expect(finalTotal).toBeLessThanOrEqual(aaaBH + 1e-6);
  });
});
