// Non-AI heuristic decision fallback.
//
// Invoked by the trading engine when the AI Gateway is unavailable (403/429/
// network). The goal is to keep the portfolio defensively managed even when
// the LLM cannot be called:
//   * NEVER emit speculative BUYs — without the model's risk view we don't
//     initiate fresh long exposure.
//   * Emit protective SELLs for held positions showing clear weakness or
//     overbought exhaustion so risk keeps coming down.
//   * The engine's downstream guardrail exits (stop-loss, take-profit, ATR
//     trailing, chandelier, time-based, hedging reconciliation) still run
//     independently of whatever this returns.

export type HeuristicFeature = {
  symbol: string;
  rsi14: number | null;
  change5d: number | null;
  change30d: number | null;
  macd_hist: number | null;
};

export type HeuristicHolding = {
  symbol: string;
  quantity: number;
};

export type HeuristicSellOrder = {
  symbol: string;
  side: "sell";
  quantity: number;
  reason: string;
};

export function buildHeuristicSells(
  holdings: HeuristicHolding[],
  features: HeuristicFeature[],
  opts: { maxSells?: number } = {},
): HeuristicSellOrder[] {
  const maxSells = opts.maxSells ?? 3;
  const byS = new Map(features.map((f) => [f.symbol, f] as const));
  const scored: Array<{ order: HeuristicSellOrder; badness: number }> = [];

  for (const h of holdings) {
    if (!(h.quantity > 0)) continue;
    const f = byS.get(h.symbol);
    if (!f) continue;
    const reasons: string[] = [];
    let badness = 0;
    if (typeof f.change30d === "number" && f.change30d <= -0.1) {
      reasons.push(`30d ${(f.change30d * 100).toFixed(1)}%`);
      badness += Math.min(1, Math.abs(f.change30d) * 5);
    }
    if (typeof f.change5d === "number" && f.change5d <= -0.05) {
      reasons.push(`5d ${(f.change5d * 100).toFixed(1)}%`);
      badness += Math.min(1, Math.abs(f.change5d) * 10);
    }
    if (typeof f.rsi14 === "number" && f.rsi14 >= 75) {
      reasons.push(`RSI ${f.rsi14.toFixed(0)} overbought`);
      badness += (f.rsi14 - 70) / 30;
    }
    if (typeof f.macd_hist === "number" && f.macd_hist < 0
        && typeof f.change5d === "number" && f.change5d < 0) {
      reasons.push("MACD-");
      badness += 0.25;
    }
    if (reasons.length === 0) continue;
    scored.push({
      order: {
        symbol: h.symbol,
        side: "sell",
        quantity: h.quantity,
        reason: `heuristic exit: ${reasons.join(", ")}`,
      },
      badness,
    });
  }

  scored.sort((a, b) => b.badness - a.badness);
  return scored.slice(0, maxSells).map((s) => s.order);
}

export type HeuristicOrder =
  | { symbol: string; side: "sell"; quantity: number; reason: string }
  | { symbol: string; side: "buy"; percent: number; reason: string };

export type HeuristicDecision = {
  briefing: string;
  rationale: string;
  orders: HeuristicOrder[];
};

import type { AlgoRegimeSnapshot } from "./microstructure/algo-regime";
import { summarizeAlgoRegime } from "./microstructure/algo-regime-prompt";

/**
 * Rule-based BUY generator used only when the AI Gateway is unavailable.
 *
 * Deliberately conservative — the goal is to keep cash from sitting idle for
 * a full trading day when the model is offline, NOT to replicate the AI's
 * risk view. Constraints:
 *   • Skip symbols already held (no averaging into existing positions).
 *   • Momentum + not-overbought filter: 30d ≥ +2%, 5d ≥ +0.5%, 45 ≤ RSI ≤ 65,
 *     MACD histogram ≥ 0.
 *   • Hard-suppressed in "elevated" / "extreme" algo regimes (thin liquidity,
 *     spoofing bursts) — those are exactly when the AI's judgement matters
 *     most, so we do not substitute a rule-set for it.
 *   • Cap the total buy sleeve at 25% of cash, split across up to N names
 *     (N tightens with risk_level so a low-risk portfolio never opens more
 *     than 1 fallback name per tick).
 *   • Env kill-switch: HEURISTIC_BUYS_ENABLED=false disables the whole path.
 */
export function buildHeuristicBuys(
  holdings: HeuristicHolding[],
  features: HeuristicFeature[],
  opts: {
    cashValue: number;
    riskLevel?: "low" | "balanced" | "high" | string | null;
    algoRegime?: AlgoRegimeSnapshot | null;
  },
): Array<{ symbol: string; side: "buy"; percent: number; reason: string }> {
  if (process.env.HEURISTIC_BUYS_ENABLED === "false") return [];
  if (!(opts.cashValue > 0)) return [];
  // Suppress under adverse microstructure — the AI's view matters most here.
  if (opts.algoRegime?.tier === "elevated" || opts.algoRegime?.tier === "extreme") return [];

  const heldSet = new Set(holdings.filter((h) => h.quantity > 0).map((h) => h.symbol));
  const scored: Array<{ symbol: string; score: number; reason: string }> = [];

  for (const f of features) {
    if (heldSet.has(f.symbol)) continue;
    if (typeof f.change30d !== "number" || f.change30d < 0.02) continue;
    if (typeof f.change5d !== "number" || f.change5d < 0.005) continue;
    if (typeof f.rsi14 !== "number" || f.rsi14 < 45 || f.rsi14 > 65) continue;
    if (typeof f.macd_hist !== "number" || f.macd_hist < 0) continue;
    const score = f.change30d * 2 + f.change5d * 5 + f.macd_hist * 0.5;
    scored.push({
      symbol: f.symbol,
      score,
      reason: `heuristic momentum entry: 30d ${(f.change30d * 100).toFixed(1)}%, 5d ${(f.change5d * 100).toFixed(1)}%, RSI ${f.rsi14.toFixed(0)}, MACD+`,
    });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  const maxBuys = opts.riskLevel === "low" ? 1 : opts.riskLevel === "high" ? 3 : 2;
  const perNamePct = opts.riskLevel === "low" ? 5 : opts.riskLevel === "high" ? 10 : 8;
  return scored.slice(0, maxBuys).map((s) => ({
    symbol: s.symbol,
    side: "buy" as const,
    percent: perNamePct, // % of available cash to spend on this name
    reason: s.reason,
  }));
}

export function buildHeuristicDecision(args: {
  holdings: HeuristicHolding[];
  features: HeuristicFeature[];
  reason: string; // why AI was unavailable
  algoRegime?: AlgoRegimeSnapshot | null;
  cashValue?: number;
  riskLevel?: "low" | "balanced" | "high" | string | null;
}): HeuristicDecision {
  const maxSells = args.algoRegime?.tier === "extreme" ? 6
    : args.algoRegime?.tier === "elevated" ? 4
    : 3;
  const sells = buildHeuristicSells(args.holdings, args.features, { maxSells });
  const buys = args.cashValue != null
    ? buildHeuristicBuys(args.holdings, args.features, {
        cashValue: args.cashValue,
        riskLevel: args.riskLevel,
        algoRegime: args.algoRegime,
      })
    : [];
  const regimeTag = args.algoRegime ? ` · ${summarizeAlgoRegime(args.algoRegime)}` : "";
  const orders: HeuristicOrder[] = [...sells, ...buys];
  const briefing = orders.length > 0
    ? `AI unavailable — heuristic proposed ${sells.length} protective sell(s) and ${buys.length} conservative buy(s).${regimeTag}`
    : `AI unavailable — heuristic found no signals; guardrail exits still enforced.${regimeTag}`;
  return {
    briefing,
    rationale:
      `AI gateway error: ${args.reason.slice(0, 200)}. ` +
      `Fallback rule-set: sell holdings with 30d ≤ -10%, 5d ≤ -5%, RSI ≥ 75, or MACD- + 5d-. ` +
      `Buy up to ${buys.length ? buys.length : "0"} unheld name(s) with 30d ≥ 2%, 5d ≥ 0.5%, RSI 45–65, MACD+; ` +
      `suppressed in elevated/extreme algo regimes. Stop-loss / take-profit / ATR ` +
      `trailing / hedging reconciliation run independently of this decision.` +
      (args.algoRegime && args.algoRegime.tier !== "normal"
        ? ` Algo-regime tier=${args.algoRegime.tier} → protective-sell cap raised to ${maxSells}, heuristic buys suppressed.`
        : ""),
    orders,
  };
}

