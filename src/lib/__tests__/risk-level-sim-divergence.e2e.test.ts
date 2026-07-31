import { describe, it, expect, beforeAll } from "vitest";
import { runBacktest, type BacktestBar, type BacktestResult } from "@/lib/backtest-runner";
import {
  buildHeuristicBuys,
  buildHeuristicSells,
  type HeuristicFeature,
} from "@/lib/heuristic-decision";
import type { SimDecision, SimState } from "@/lib/broker-simulator";

/**
 * Multi-tick divergence test for the "High risk sim" vs "Balanced risk sim"
 * portfolios.
 *
 * Regression context: both sim portfolios once mirrored the same broker
 * account, so they rendered byte-identical holdings, equity and cash. The
 * ledgers are now fully independent AND the risk level genuinely changes the
 * sizing rules (high = up to 3 names at 10% of cash per tick, balanced = up
 * to 2 names at 8%). This test replays the SAME price tape through both risk
 * levels for many ticks and asserts the two runs diverge in holdings, equity
 * curve and cash — while each individually respects the no-borrow invariant.
 *
 * Everything here is pure and deterministic: no clock, no randomness, no I/O.
 */

const SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE"] as const;
const BARS = 45;
const START_CASH = 10_000;

/** Per-symbol base price and per-bar drift — distinct so ranking is stable. */
const TAPE: Record<string, { base: number; drift: number }> = {
  AAA: { base: 100, drift: 0.0030 },
  BBB: { base: 50, drift: 0.0026 },
  CCC: { base: 200, drift: 0.0022 },
  DDD: { base: 25, drift: 0.0018 },
  EEE: { base: 80, drift: 0.0014 },
};

function buildBars(): BacktestBar[] {
  const bars: BacktestBar[] = [];
  for (let i = 0; i < BARS; i++) {
    const closes: Record<string, number> = {};
    for (const s of SYMBOLS) {
      const { base, drift } = TAPE[s];
      closes[s] = Number((base * (1 + drift) ** i).toFixed(4));
    }
    const day = String(i + 1).padStart(2, "0");
    bars.push({ date: `2026-05-${day}`.replace("2026-05-32", "2026-06-01"), closes });
  }
  // Guarantee strictly-increasing ISO dates across the month boundary.
  return bars.map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10),
  }));
}

/** Deterministic momentum features derived from the rolling close history. */
function featuresFrom(history: Record<string, number[]>): HeuristicFeature[] {
  const out: HeuristicFeature[] = [];
  for (const s of SYMBOLS) {
    const h = history[s] ?? [];
    if (h.length < 31) continue;
    const last = h[h.length - 1];
    const pct = (n: number) => (last - h[h.length - 1 - n]) / h[h.length - 1 - n];
    out.push({
      symbol: s,
      change5d: Number(pct(5).toFixed(6)),
      change30d: Number(pct(30).toFixed(6)),
      rsi14: 58,
      macd_hist: 0.4,
      assetClass: "stock",
    });
  }
  return out;
}

/** Replay the tape for one risk level and return the full backtest result. */
async function runRisk(riskLevel: "high" | "balanced"): Promise<BacktestResult> {
  const initial: SimState = { cash: START_CASH, holdings: [] };
  return runBacktest(initial, buildBars(), ({ state, closes, history, barIndex }) => {
    const features = featuresFrom(history);
    if (features.length === 0) return [];
    const holdings = state.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity }));
    const decisions: SimDecision[] = [];

    for (const sell of buildHeuristicSells(holdings, features)) {
      const px = closes[sell.symbol];
      if (!(px > 0) || !(sell.quantity > 0)) continue;
      decisions.push({
        id: `${riskLevel}-${barIndex}-s-${sell.symbol}`,
        symbol: sell.symbol,
        side: "SELL",
        quantity: sell.quantity,
        price: px,
      });
    }

    const buys = buildHeuristicBuys(holdings, features, {
      cashValue: state.cash,
      riskLevel,
    });
    for (const buy of buys) {
      const px = closes[buy.symbol];
      if (!(px > 0)) continue;
      const qty = Math.floor((state.cash * (buy.percent / 100)) / px);
      if (qty <= 0) continue;
      decisions.push({
        id: `${riskLevel}-${barIndex}-b-${buy.symbol}`,
        symbol: buy.symbol,
        side: "BUY",
        quantity: qty,
        price: px,
      });
    }
    return decisions;
  }, { defaultFee: 1 });
}

function finalHoldingsMap(r: BacktestResult): Record<string, number> {
  return Object.fromEntries(r.finalState.holdings.map((h) => [h.symbol, h.quantity]));
}

let high: BacktestResult;
let balanced: BacktestResult;

describe("high-risk vs balanced-risk sim: multi-tick divergence", () => {
  beforeAll(async () => {
    high = await runRisk("high");
    balanced = await runRisk("balanced");
  });

  it("both replays complete over the full tape", () => {
    expect(high.equityCurve).toHaveLength(BARS);
    expect(balanced.equityCurve).toHaveLength(BARS);
  });

  it("holdings diverge — high risk builds breadth faster and sizes differently", () => {
    const h = finalHoldingsMap(high);
    const b = finalHoldingsMap(balanced);
    // Same tape and ranking, so the balanced book is always a subset of the
    // high-risk universe — but the per-name quantities must differ.
    for (const sym of Object.keys(b)) expect(Object.keys(h)).toContain(sym);
    expect(h).not.toEqual(b);

    // Breadth over time: high risk opens up to 3 names per tick vs 2, so it
    // reaches full breadth strictly earlier and is never behind.
    const breadth = (r: typeof high) => {
      const seen = new Set<string>();
      return r.snapshots.map((s) => {
        if (s.side === "BUY") seen.add(s.symbol);
        return seen.size;
      });
    };
    const target = Object.keys(h).length;
    const firstFull = (r: typeof high) => {
      const seen = new Set<string>();
      for (const s of r.snapshots) {
        if (s.side === "BUY") seen.add(s.symbol);
        if (seen.size >= target) return s.step;
      }
      return Number.POSITIVE_INFINITY;
    };
    expect(firstFull(high)).toBeLessThan(firstFull(balanced));
    expect(Math.max(...breadth(high))).toBeGreaterThanOrEqual(Math.max(...breadth(balanced)));
  });


  it("per-name size diverges — high risk buys a bigger slice of cash", () => {
    const h = finalHoldingsMap(high);
    const b = finalHoldingsMap(balanced);
    const shared = Object.keys(b).filter((s) => s in h);
    expect(shared.length).toBeGreaterThan(0);
    // 10%-of-cash sizing vs 8% must leave at least one shared name larger.
    expect(shared.some((s) => h[s] !== b[s])).toBe(true);
  });

  it("cash balances diverge and never go negative", () => {
    expect(high.finalState.cash).not.toBeCloseTo(balanced.finalState.cash, 6);
    // High risk deploys more capital, so it ends with less idle cash.
    expect(high.finalState.cash).toBeLessThan(balanced.finalState.cash);
    for (const r of [high, balanced]) {
      for (const p of r.equityCurve) expect(p.cash).toBeGreaterThanOrEqual(0);
      for (const s of r.snapshots) expect(s.cash).toBeGreaterThanOrEqual(0);
    }
  });

  it("equity curves diverge after the first trading tick and stay distinct", () => {
    const hv = high.equityCurve.map((p) => p.totalValue);
    const bv = balanced.equityCurve.map((p) => p.totalValue);
    const firstDiff = hv.findIndex((v, i) => Math.abs(v - bv[i]) > 1e-9);
    expect(firstDiff).toBeGreaterThan(0); // identical while still flat/cash-only
    expect(firstDiff).toBeLessThan(BARS);
    // Once they part, they must not silently re-converge to identical curves.
    const tail = hv.slice(firstDiff).filter((v, i) => Math.abs(v - bv[firstDiff + i]) > 1e-9);
    expect(tail.length).toBe(BARS - firstDiff);
    expect(hv).not.toEqual(bv);
  });

  it("each tick's step count differs at least once (more slots at high risk)", () => {
    const hs = high.equityCurve.map((p) => p.steps);
    const bs = balanced.equityCurve.map((p) => p.steps);
    expect(hs).not.toEqual(bs);
    expect(Math.max(...hs)).toBeGreaterThan(Math.max(...bs));
  });

  it("ledgers are independent — neither run mutates the other's state", () => {
    const hSyms = new Set(high.snapshots.map((s) => s.decisionId.split("-")[0]));
    const bSyms = new Set(balanced.snapshots.map((s) => s.decisionId.split("-")[0]));
    expect([...hSyms]).toEqual(["high"]);
    expect([...bSyms]).toEqual(["balanced"]);
  });

  it("each run is internally consistent: equity = cash + marked holdings", () => {
    const bars = buildBars();
    for (const r of [high, balanced]) {
      for (const p of r.equityCurve) {
        expect(p.totalValue).toBeCloseTo(p.cash + p.holdingsValue, 6);
        expect(bars[p.barIndex].date).toBe(p.date);
      }
    }
  });

  it("replays are deterministic — re-running yields identical curves", async () => {
    const again = await runRisk("high");
    expect(again.equityCurve).toEqual(high.equityCurve);
    expect(again.finalState).toEqual(high.finalState);
    const againBalanced = await runRisk("balanced");
    expect(againBalanced.finalState).toEqual(balanced.finalState);
    // ...and the two risk levels still differ under the repeated run.
    expect(again.finalState).not.toEqual(againBalanced.finalState);
  });
});
