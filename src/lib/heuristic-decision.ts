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
  /** Optional — when present, heuristic buys are restricted to "stock". */
  assetClass?: string | null;
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

export type HeuristicManiaBlock = {
  symbol: string;
  action: "block" | "trim";
  score: number;
  tier: "watch" | "mania";
  reason: string;
  breakdown: ManiaScoreItem[];
};

export type HeuristicDecision = {
  briefing: string;
  rationale: string;
  orders: HeuristicOrder[];
  maniaBlocks: HeuristicManiaBlock[];
};

import type { AlgoRegimeSnapshot } from "./microstructure/algo-regime";
import { summarizeAlgoRegime } from "./microstructure/algo-regime-prompt";
import {
  detectRetailMania,
  formatManiaExplanation,
  type ManiaScoreItem,
} from "./microstructure/retail-mania";

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
 *     (N tightens with risk_level so a conservative portfolio never opens
 *     more than 1 fallback name per tick). Levels are normalised via
 *     normalizeHeuristicRiskLevel so conservative/aggressive (portfolio
 *     vocabulary) and legacy low/high map to the same sleeve.
 *   • Env kill-switch: HEURISTIC_BUYS_ENABLED=false disables the whole path.
 */
/**
 * Canonical heuristic risk vocabulary.
 *
 * Portfolios store `risk_level` as conservative | balanced | aggressive
 * (Database["public"]["Enums"]["risk_level"]). Older sim/backtest code used
 * low | balanced | high. Both are accepted here and normalised to the
 * portfolio vocabulary so the fallback buy sleeve is identical regardless of
 * which caller supplies the level.
 */
export type HeuristicRiskLevel = "conservative" | "balanced" | "aggressive";
export type HeuristicRiskLevelInput =
  | HeuristicRiskLevel
  | "low"
  | "high"
  | string
  | null
  | undefined;

export function normalizeHeuristicRiskLevel(
  level: HeuristicRiskLevelInput,
): HeuristicRiskLevel {
  switch ((level ?? "").toString().trim().toLowerCase()) {
    case "conservative":
    case "low":
      return "conservative";
    case "aggressive":
    case "high":
      return "aggressive";
    default:
      return "balanced";
  }
}

/** Fallback buy sleeve sizing per canonical risk level. */
export const HEURISTIC_BUY_SLEEVE: Record<
  HeuristicRiskLevel,
  { maxBuys: number; perNamePct: number }
> = {
  conservative: { maxBuys: 1, perNamePct: 5 },
  balanced: { maxBuys: 2, perNamePct: 8 },
  aggressive: { maxBuys: 3, perNamePct: 10 },
};

/**
 * Hard ceiling (as a % of account value) on any single name opened while the
 * AI model is unavailable. Enforced by the trading engine's sizing pipeline —
 * the rule-set must never be able to build a 45%-of-book single-stock bet.
 */
export const FALLBACK_MAX_NAME_WEIGHT_PCT = 8;

/** Market-sentiment labels the fallback reacts to (see `fear-index.ts`). */
export type HeuristicFearLabel =
  | "extreme_greed"
  | "greed"
  | "neutral"
  | "fear"
  | "extreme_fear"
  | string;

export function buildHeuristicBuys(
  holdings: HeuristicHolding[],
  features: HeuristicFeature[],
  opts: {
    cashValue: number;
    riskLevel?: HeuristicRiskLevelInput;
    algoRegime?: AlgoRegimeSnapshot | null;
    /** Composite fear/greed label at decision time. */
    fearLabel?: HeuristicFearLabel | null;
  },
): Array<{ symbol: string; side: "buy"; percent: number; reason: string }> {
  if (process.env.HEURISTIC_BUYS_ENABLED === "false") return [];
  if (!(opts.cashValue > 0)) return [];
  // Extreme greed / complacency: the rule-set has no way to judge whether a
  // stretched tape is worth chasing, so it stands aside rather than treating
  // froth as momentum. Ordinary greed halves the sleeve (below).
  if (opts.fearLabel === "extreme_greed") return [];
  // Suppress under adverse microstructure — the AI's view matters most here.
  if (opts.algoRegime?.tier === "elevated" || opts.algoRegime?.tier === "extreme") return [];

  const heldSet = new Set(holdings.filter((h) => h.quantity > 0).map((h) => h.symbol));
  const scored: Array<{ symbol: string; score: number; reason: string }> = [];

  for (const f of features) {
    if (heldSet.has(f.symbol)) continue;
    // Heuristic buys are restricted to plain equities. Crypto/commodity ETPs
    // require Saxo instrument-cache verification (see crypto-validation.server
    // + commodity-validation.server) which the rule-set can't perform — the
    // trading engine would reject them fail-fast with a "not verified as
    // Saxo-tradable" note, leaving cash idle for the tick.
    if (f.assetClass != null && f.assetClass !== "stock") continue;
    if (typeof f.change30d !== "number" || f.change30d < 0.02) continue;
    if (typeof f.change5d !== "number" || f.change5d < 0.002) continue;
    if (typeof f.rsi14 !== "number" || f.rsi14 < 45 || f.rsi14 > 70) continue;
    if (typeof f.macd_hist !== "number" || f.macd_hist < 0) continue;
    // Retail-mania / short-squeeze guardrail (post-GameStop 2021): hard-skip
    // names showing parabolic ramps even if the momentum filter above would
    // otherwise clear them. The RSI 45–70 window already blocks the classic
    // GME setup, but this makes the intent explicit and defends against
    // combinations where RSI has just rolled back into range mid-parabola.
    const mania = detectRetailMania({
      symbol: f.symbol,
      change5d: f.change5d,
      change30d: f.change30d,
      rsi14: f.rsi14,
    });
    if (mania.blockNewBuys) continue;
    const score = f.change30d * 2 + f.change5d * 5 + f.macd_hist * 0.5;
    scored.push({
      symbol: f.symbol,
      score,
      reason: `heuristic momentum entry: 30d ${(f.change30d * 100).toFixed(1)}%, 5d ${(f.change5d * 100).toFixed(1)}%, RSI ${f.rsi14.toFixed(0)}, MACD+`,
    });
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  const { maxBuys, perNamePct } =
    HEURISTIC_BUY_SLEEVE[normalizeHeuristicRiskLevel(opts.riskLevel)];
  const greedScale = opts.fearLabel === "greed" ? 0.5 : 1;
  return scored.slice(0, maxBuys).map((s) => ({
    symbol: s.symbol,
    side: "buy" as const,
    percent: perNamePct * greedScale, // % of available cash to spend on this name
    reason: s.reason,
  }));
}

/**
 * Run the retail-mania detector over the current features, splitting into
 * "block new buy" (unheld symbols) and "trim existing long" (currently held).
 * Exposed so callers (trading engine) can log counterfactuals and surface
 * per-component score breakdowns in the decision-summary card.
 */
export function collectHeuristicManiaBlocks(
  holdings: HeuristicHolding[],
  features: HeuristicFeature[],
): HeuristicManiaBlock[] {
  const heldSet = new Set(holdings.filter((h) => h.quantity > 0).map((h) => h.symbol));
  const out: HeuristicManiaBlock[] = [];
  for (const f of features) {
    const sig = detectRetailMania({
      symbol: f.symbol,
      change5d: f.change5d,
      change30d: f.change30d,
      rsi14: f.rsi14,
    });
    if (sig.tier === "none") continue;
    const held = heldSet.has(f.symbol);
    if (!held && sig.blockNewBuys) {
      out.push({
        symbol: f.symbol,
        action: "block",
        score: sig.score,
        tier: sig.tier,
        reason: formatManiaExplanation(sig, "block"),
        breakdown: sig.scoreBreakdown,
      });
    } else if (held && sig.trimExistingLong) {
      out.push({
        symbol: f.symbol,
        action: "trim",
        score: sig.score,
        tier: sig.tier,
        reason: formatManiaExplanation(sig, "trim"),
        breakdown: sig.scoreBreakdown,
      });
    }
  }
  return out;
}

export function buildHeuristicDecision(args: {
  holdings: HeuristicHolding[];
  features: HeuristicFeature[];
  reason: string; // why AI was unavailable
  algoRegime?: AlgoRegimeSnapshot | null;
  cashValue?: number;
  riskLevel?: HeuristicRiskLevelInput;
  fearLabel?: HeuristicFearLabel | null;
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
        fearLabel: args.fearLabel ?? null,
      })
    : [];
  const maniaBlocks = collectHeuristicManiaBlocks(args.holdings, args.features);
  const regimeTag = args.algoRegime ? ` · ${summarizeAlgoRegime(args.algoRegime)}` : "";
  const orders: HeuristicOrder[] = [...sells, ...buys];
  const maniaTag = maniaBlocks.length > 0
    ? ` · retail-mania guardrail: ${maniaBlocks.length} name(s) (${maniaBlocks.filter((m) => m.action === "block").length} blocked, ${maniaBlocks.filter((m) => m.action === "trim").length} flagged for trim)`
    : "";
  const briefing = orders.length > 0
    ? `AI unavailable — heuristic proposed ${sells.length} protective sell(s) and ${buys.length} conservative buy(s).${regimeTag}${maniaTag}`
    : `AI unavailable — heuristic found no signals; guardrail exits still enforced.${regimeTag}${maniaTag}`;
  return {
    briefing,
    rationale:
      `AI gateway error: ${args.reason.slice(0, 200)}. ` +
      `Fallback rule-set: sell holdings with 30d ≤ -10%, 5d ≤ -5%, RSI ≥ 75, or MACD- + 5d-. ` +
      `Buy up to ${buys.length ? buys.length : "0"} unheld name(s) with 30d ≥ 2%, 5d ≥ 0.5%, RSI 45–65, MACD+; ` +
      `capped at ${FALLBACK_MAX_NAME_WEIGHT_PCT}% of account value per name and ` +
      (args.fearLabel === "extreme_greed"
        ? "suppressed entirely (extreme greed — froth is not treated as momentum); "
        : args.fearLabel === "greed"
        ? "halved (greedy tape); "
        : "") +
      `suppressed in elevated/extreme algo regimes. Stop-loss / take-profit / ATR ` +
      `trailing / hedging reconciliation run independently of this decision.` +
      (args.algoRegime && args.algoRegime.tier !== "normal"
        ? ` Algo-regime tier=${args.algoRegime.tier} → protective-sell cap raised to ${maxSells}, heuristic buys suppressed.`
        : ""),
    orders,
    maniaBlocks,
  };
}


