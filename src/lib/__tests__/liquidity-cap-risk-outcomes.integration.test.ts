// Integration: tighter liquidity caps → smaller positions, different stop
// triggers, lower drawdown for the SAME chosen risk level.
//
// Composes:
//   • riskProfile(level).maxPositionPct        → sizing intent (per-position cap)
//   • simulateBrokerExecution + liquidity      → actual fills subject to ADV/participation
//   • a peak-trailing stop of stop_loss_pct    → deterministic exit rule
//
// Design
// ------
// We replay a scripted price path (accumulation → run-up → drawdown) bar by
// bar. On each bar the strategy:
//   1. issues a BUY sized to bring the position toward riskProfile.maxPositionPct
//      * totalValue / price, capped at the caller-supplied per-bar
//      availableVolume, and
//   2. issues a SELL of the full position when price falls stop_loss_pct below
//      its running peak since entry.
//
// Running the SAME strategy at the SAME risk level under a "loose" vs a
// "tight" per-bar liquidity cap must produce:
//   (a) SMALLER peak position size (fewer units accumulated) in the tight run,
//   (b) DIFFERENT stop trigger — a later step and/or a different fill price
//       because the loose run reaches a bigger stack (and thus its trailing
//       peak) sooner,
//   (c) LOWER peak-to-trough drawdown of totalValue in the tight run.
//
// These are the concrete, testable consequences of the invariant added to the
// broker simulator's liquidity model: liquidity truncation shrinks positions,
// which shrinks the equity swing when the market turns.

import { describe, expect, it } from "vitest";
import {
  simulateBrokerExecution,
  type SimDecision,
  type SimSnapshot,
  type SimState,
} from "@/lib/broker-simulator";
import { riskProfile } from "@/lib/universe.server";
import { checkExecutionInvariants } from "@/lib/execution-invariants";

// A deterministic price path: 6 bars of accumulation near $100, 4 bars of
// run-up to $130 (new peak), then 5 bars of drawdown to $88. Chosen so the
// peak-trailing stop is guaranteed to trigger on the way down for any run
// that has an open position.
const PRICE_PATH = [
  100, 100, 101, 100, 102, 101, // accumulation
  108, 118, 126, 130,           // run-up (peak = 130)
  122, 114, 104, 96, 88,        // drawdown → trailing stop trips
];

type BarResult = {
  bar: number;
  price: number;
  qty: number;             // filled qty this bar (0 if none)
  side: "BUY" | "SELL" | null;
  position: number;        // held units after this bar
  cash: number;
  totalValue: number;
  peakSinceEntry: number;  // running peak used by trailing stop
  stopTriggered: boolean;
  truncationReason: SimSnapshot["truncationReason"];
};

type RunResult = {
  bars: BarResult[];
  peakPosition: number;
  stopBar: number | null;
  stopFillPrice: number | null;
  stopFillQty: number | null;
  maxDrawdownPct: number;
};

/**
 * Peak-trailing-stop runner. Executes ONE decision per bar against
 * simulateBrokerExecution, threading state forward so the ledger is
 * consistent bar-to-bar.
 */
function runStrategy(args: {
  startingCash: number;
  maxPositionPct: number;
  stopPct: number;
  liquidityPerBar: number;   // per-bar availableVolume for the single symbol
  prices: number[];
}): RunResult {
  const { startingCash, maxPositionPct, stopPct, liquidityPerBar, prices } = args;
  const SYMBOL = "ACME";
  let state: SimState = { cash: startingCash, holdings: [] };
  const bars: BarResult[] = [];
  let peakSinceEntry = 0;
  let stopBar: number | null = null;
  let stopFillPrice: number | null = null;
  let stopFillQty: number | null = null;
  let peakEquity = startingCash;
  let maxDD = 0;
  let peakPosition = 0;

  for (let i = 0; i < prices.length; i += 1) {
    const price = prices[i];
    const held = state.holdings.find((h) => h.symbol === SYMBOL)?.quantity ?? 0;
    const equity = state.cash + held * price;
    if (held > 0) peakSinceEntry = Math.max(peakSinceEntry, price);

    // Decide side for this bar.
    let decision: SimDecision | null = null;
    const stopHit =
      held > 0 &&
      peakSinceEntry > 0 &&
      price <= peakSinceEntry * (1 - stopPct);

    if (stopHit && stopBar === null) {
      decision = {
        id: `sell-${i}`, symbol: SYMBOL, side: "SELL",
        quantity: held, price,
      };
    } else if (!stopHit) {
      // Momentum-only entry: only accumulate while price is at/above its
      // running peak since entry. This isolates the liquidity effect —
      // otherwise the tight run would keep buying on the way down (target
      // grows as price falls) and the drawdown comparison becomes noisy.
      const canAccumulate = held === 0 || price >= peakSinceEntry - 1e-9;
      if (canAccumulate) {
        const targetUnits = (maxPositionPct * equity) / price;
        const gap = targetUnits - held;
        if (gap > 1e-9) {
          decision = {
            id: `buy-${i}`, symbol: SYMBOL, side: "BUY",
            quantity: gap, price,
          };
        }
      }
    }

    let barRec: BarResult = {
      bar: i, price, qty: 0, side: null,
      position: held, cash: state.cash,
      totalValue: equity, peakSinceEntry,
      stopTriggered: false, truncationReason: null,
    };

    if (decision) {
      const res = simulateBrokerExecution(
        state,
        [decision],
        {
          markPrices: { [SYMBOL]: price },
          liquidity: { availableVolume: { [SYMBOL]: liquidityPerBar } },
        },
      );
      // Invariants must hold on every step.
      expect(checkExecutionInvariants({
        initial: state, decisions: [decision],
        snapshots: res.snapshots, rejections: res.rejections,
        markPrices: { [SYMBOL]: price },
      }).ok).toBe(true);

      if (res.snapshots.length > 0) {
        const s = res.snapshots[0];
        state = { cash: s.cash, holdings: s.holdings };
        const newHeld =
          s.holdings.find((h) => h.symbol === SYMBOL)?.quantity ?? 0;
        barRec = {
          ...barRec,
          qty: s.fillQuantity,
          side: decision.side,
          position: newHeld,
          cash: s.cash,
          totalValue: s.totalValue,
          truncationReason: s.truncationReason,
          stopTriggered: decision.side === "SELL",
        };
        if (decision.side === "SELL" && stopBar === null) {
          stopBar = i;
          stopFillPrice = s.fillPrice;
          stopFillQty = s.fillQuantity;
          peakSinceEntry = 0; // reset for any future re-entry (not used here)
        }
        peakPosition = Math.max(peakPosition, newHeld);
      }
    }

    peakEquity = Math.max(peakEquity, barRec.totalValue);
    const dd = peakEquity > 0 ? (peakEquity - barRec.totalValue) / peakEquity : 0;
    if (dd > maxDD) maxDD = dd;
    bars.push(barRec);
  }

  return { bars, peakPosition, stopBar, stopFillPrice, stopFillQty, maxDrawdownPct: maxDD };
}

describe("integration: tighter liquidity caps → risk-outcome differences at the same risk level", () => {
  const LEVEL = "aggressive" as const;
  const profile = riskProfile(LEVEL);
  const STARTING = 100_000;
  const STOP_PCT = 0.10; // 10% peak-trailing stop
  const LOOSE = 10_000;  // per-bar liquidity — never binds vs target
  const TIGHT = 20;      // per-bar liquidity — heavily throttles accumulation

  const loose = runStrategy({
    startingCash: STARTING,
    maxPositionPct: profile.maxPositionPct,
    stopPct: STOP_PCT,
    liquidityPerBar: LOOSE,
    prices: PRICE_PATH,
  });
  const tight = runStrategy({
    startingCash: STARTING,
    maxPositionPct: profile.maxPositionPct,
    stopPct: STOP_PCT,
    liquidityPerBar: TIGHT,
    prices: PRICE_PATH,
  });

  it("tighter liquidity is actually binding (some bars report liquidity truncation)", () => {
    const anyTightTrunc = tight.bars.some((b) => b.truncationReason === "liquidity");
    const anyLooseTrunc = loose.bars.some((b) => b.truncationReason === "liquidity");
    expect(anyTightTrunc).toBe(true);
    // Loose cap is 500× a single-bar target so it should never bind.
    expect(anyLooseTrunc).toBe(false);
  });

  it("(a) tighter liquidity → strictly SMALLER peak position", () => {
    expect(tight.peakPosition).toBeLessThan(loose.peakPosition);
    // Sanity: both actually opened a position.
    expect(tight.peakPosition).toBeGreaterThan(0);
    expect(loose.peakPosition).toBeGreaterThan(0);
  });

  it("(b) tighter liquidity → DIFFERENT stop trigger (bar and/or fill price)", () => {
    // Both runs must actually trip the trailing stop on the drawdown leg.
    expect(loose.stopBar).not.toBeNull();
    expect(tight.stopBar).not.toBeNull();

    const sameBar = loose.stopBar === tight.stopBar;
    const samePrice = loose.stopFillPrice === tight.stopFillPrice;
    // At minimum one of (bar, price) must differ — the runs cannot be
    // observationally identical if their positions differ.
    expect(sameBar && samePrice).toBe(false);
  });

  it("(c) tighter liquidity → strictly LOWER peak-to-trough drawdown of equity", () => {
    expect(tight.maxDrawdownPct).toBeLessThan(loose.maxDrawdownPct);
    // Both runs must actually experience some drawdown for the comparison
    // to be meaningful — otherwise the assertion is vacuous.
    expect(loose.maxDrawdownPct).toBeGreaterThan(0);
  });

  it("holds across every non-max risk level too (property, not just an aggressive-only quirk)", () => {
    for (const level of ["conservative", "balanced", "aggressive"] as const) {
      const p = riskProfile(level);
      const l = runStrategy({
        startingCash: STARTING, maxPositionPct: p.maxPositionPct,
        stopPct: STOP_PCT, liquidityPerBar: LOOSE, prices: PRICE_PATH,
      });
      const t = runStrategy({
        startingCash: STARTING, maxPositionPct: p.maxPositionPct,
        stopPct: STOP_PCT, liquidityPerBar: TIGHT, prices: PRICE_PATH,
      });
      expect(t.peakPosition).toBeLessThan(l.peakPosition);
      expect(t.maxDrawdownPct).toBeLessThanOrEqual(l.maxDrawdownPct);
    }
  });
});
