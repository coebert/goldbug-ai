// Integrates the pure broker-simulator ledger into the live decision
// loop as a final invariant guard. The engine's own execution path
// already sizes trades against cash, per-symbol caps, correlated
// clusters etc. — this layer double-checks that the resulting order
// list, when replayed step-by-step, NEVER violates the two hard rules
// the user pinned for the app:
//
//   1. No borrowing — cash may not go below 0 at any step.
//   2. No leverage / shorting — no holding may go below 0 at any step.
//
// Risk level tunes how permissive the simulator is when the primary
// engine's numbers and the simulator's ledger disagree by float noise
// or by a stale price:
//
//   conservative  → strict. Any BUY that would overspend, or SELL that
//                   would short, is REJECTED. Callers must drop those
//                   trades before persisting.
//   balanced      → truncate BUYs to the affordable size, but reject
//                   SELLs beyond the current position (no accidental
//                   shorting).
//   aggressive    → truncate both. Never reject — always fit the
//                   trade to the ledger.
//
// This module is a thin PURE wrapper around `simulateBrokerExecution`.
// It contains no I/O and no imports beyond the simulator + risk enum
// so it can be unit-tested exhaustively and reused from any surface
// (live loop, backtests, previews).

import {
  simulateBrokerExecution,
  type SimDecision,
  type SimulateOptions,
  type SimulateResult,
  type SimState,
  type SimSnapshot,
  type SimRejection,
} from "./broker-simulator";
import type { Database } from "@/integrations/supabase/types";

export type RiskLevel = Database["public"]["Enums"]["risk_level"];

/** Executed-trade shape as produced by the trading engine. */
export type EngineExecutedTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string | null;
};

export type BrokerSimulatorGuardInput = {
  riskLevel: RiskLevel;
  startingCash: number;
  startingHoldings: Array<{ symbol: string; quantity: number; avgCost: number }>;
  executed: EngineExecutedTrade[];
  priceMap?: Record<string, number>;
  /** Optional fixed fee per trade to include in the ledger check. */
  feePerTrade?: number;
};

export type BrokerSimulatorGuardResult = {
  /** Simulator options used, derived from riskLevel — surfaced for logging. */
  options: SimulateOptions;
  /** Whole simulator result. */
  simulation: SimulateResult;
  /**
   * IDs of executed trades the simulator rejected. In conservative
   * mode these MUST be dropped before persisting. In balanced /
   * aggressive mode they were already truncated inside the simulator
   * and reflected in the snapshots, so this array is typically empty.
   */
  rejectedTradeIds: string[];
  /**
   * Whether the simulator's final cash / holdings match the engine's
   * own numbers to within a tight tolerance. `false` means the engine
   * and the pure ledger disagree — a signal to drop the extra trades
   * or log a warning for investigation.
   */
  ledgerMatchesEngine: boolean;
  /** Diagnostics per (mismatched) step, if any. */
  drift: Array<{
    symbol: string;
    side: "buy" | "sell";
    engineValue: number;
    simulatedValue: number;
  }>;
};

/** Maps the user-facing risk enum onto broker-simulator options. */
export function simulatorOptionsForRisk(risk: RiskLevel): SimulateOptions {
  switch (risk) {
    case "conservative":
      return { truncateBuysToCash: false, truncateSellsToPosition: false };
    case "aggressive":
      return { truncateBuysToCash: true, truncateSellsToPosition: true };
    case "balanced":
    default:
      return { truncateBuysToCash: true, truncateSellsToPosition: false };
  }
}

/**
 * Stable id for a trade — engine trades don't carry an id at this
 * stage, so we derive one from position+symbol+side. Deterministic so
 * `rejectedTradeIds` maps 1:1 back to the caller's array indices.
 */
export function decisionIdFor(trade: EngineExecutedTrade, index: number): string {
  return `${index}:${trade.side}:${trade.symbol}`;
}

/** Map engine trades → simulator decisions, skipping engine-rejected rows. */
function toSimDecisions(
  executed: EngineExecutedTrade[],
  feePerTrade: number,
): Array<{ index: number; sim: SimDecision }> {
  const out: Array<{ index: number; sim: SimDecision }> = [];
  executed.forEach((t, i) => {
    if (t.rejected) return; // already dropped upstream
    if (!(t.quantity > 0)) return; // no-op rows
    out.push({
      index: i,
      sim: {
        id: decisionIdFor(t, i),
        symbol: t.symbol,
        side: t.side === "buy" ? "BUY" : "SELL",
        quantity: t.quantity,
        price: t.price,
        fee: feePerTrade,
      },
    });
  });
  return out;
}

const CASH_EPSILON = 0.01; // 1 cent — tighter than any real fee/rounding gap
const QTY_EPSILON = 1e-6;

export function runBrokerSimulatorGuard(
  input: BrokerSimulatorGuardInput,
): BrokerSimulatorGuardResult {
  const options: SimulateOptions = {
    ...simulatorOptionsForRisk(input.riskLevel),
    markPrices: input.priceMap,
  };
  const feePerTrade = Number.isFinite(input.feePerTrade) && (input.feePerTrade ?? 0) >= 0
    ? (input.feePerTrade as number)
    : 0;

  const simDecisions = toSimDecisions(input.executed, feePerTrade);

  const initial: SimState = {
    cash: Math.max(0, Number(input.startingCash) || 0),
    holdings: input.startingHoldings.map((h) => ({
      symbol: h.symbol,
      quantity: Math.max(0, Number(h.quantity) || 0),
      avgCost: Math.max(0, Number(h.avgCost) || 0),
    })),
  };

  const simulation = simulateBrokerExecution(
    initial,
    simDecisions.map((s) => s.sim),
    options,
  );

  // Rejected trade ids — decode back to the caller's numeric indices
  // via the decisionId prefix so callers can drop the trades cleanly.
  const rejectedIds = new Set(simulation.rejections.map((r: SimRejection) => r.decisionId));
  const rejectedTradeIds = simDecisions
    .filter((s) => rejectedIds.has(s.sim.id))
    .map((s) => s.sim.id);

  // Compare fill sizes step-by-step. In truncate modes the simulator
  // may cut a BUY quantity down to fit cash. Any such divergence is
  // reported so the engine can log it into the decision guardrails.
  const drift: BrokerSimulatorGuardResult["drift"] = [];
  const bySimId = new Map<string, SimSnapshot>();
  for (const s of simulation.snapshots) bySimId.set(s.decisionId, s);
  for (const s of simDecisions) {
    const snap = bySimId.get(s.sim.id);
    if (!snap) continue; // rejected; already captured above
    const engineTrade = input.executed[s.index];
    if (Math.abs(snap.fillQuantity - engineTrade.quantity) > QTY_EPSILON) {
      drift.push({
        symbol: engineTrade.symbol,
        side: engineTrade.side,
        engineValue: engineTrade.quantity,
        simulatedValue: snap.fillQuantity,
      });
    }
  }

  const ledgerMatchesEngine =
    rejectedTradeIds.length === 0 &&
    drift.length === 0 &&
    simulation.finalState.cash >= -CASH_EPSILON;

  return { options, simulation, rejectedTradeIds, ledgerMatchesEngine, drift };
}
