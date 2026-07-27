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

export type HeuristicDecision = {
  briefing: string;
  rationale: string;
  orders: Array<{ symbol: string; side: "sell"; quantity: number; reason: string }>;
};

export function buildHeuristicDecision(args: {
  holdings: HeuristicHolding[];
  features: HeuristicFeature[];
  reason: string; // why AI was unavailable
}): HeuristicDecision {
  const sells = buildHeuristicSells(args.holdings, args.features);
  const briefing = sells.length > 0
    ? `AI unavailable — heuristic proposed ${sells.length} protective sell(s); no new buys.`
    : "AI unavailable — heuristic found no exit signals; guardrail exits still enforced.";
  return {
    briefing,
    rationale:
      `AI gateway error: ${args.reason.slice(0, 200)}. ` +
      `Fallback rule-set: sell holdings with 30d ≤ -10%, 5d ≤ -5%, RSI ≥ 75, or MACD- + 5d-. ` +
      `No BUY orders are placed without the model's risk view. Stop-loss / take-profit / ATR ` +
      `trailing / hedging reconciliation run independently of this decision.`,
    orders: sells,
  };
}
