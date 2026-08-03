// Core trading engine. Called once per "tick" (day) for a portfolio.
// Uses AI SDK -> Lovable AI Gateway with structured output.

import { recordIntradayEquity } from "@/lib/equity-intraday.server";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { asJson } from "@/lib/_server/db-json";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { HISTORICAL_PLAYBOOK } from "./historical-playbook.server";
import { HEDGE_FUND_PLAYBOOK } from "./hedge-fund-playbook.server";
import { COMMODITY_PLAYBOOK } from "./commodity-playbook.server";
import { CRYPTO_PLAYBOOK } from "./crypto-playbook.server";
import {
  resolveAggressiveness,
  aggressiveBuySpend,
  aggressiveSellQty,
} from "./risk-aggressiveness";
import {
  buildLearningContext,
  formatLearningBlock,
  reflectAndUpdateLessons,
  type LearningContext,
} from "./learning.server";
import {
  getDailyCandles,
  primeDailyCandles,
  getPriceOn,
  sma,
  rsi,
  pctChange,
  dailyVolatility,
} from "./market-data.server";
import {
  macd,
  bollingerWidth,
  atrPct,
  averageDailyVolume,
  volumeWeightedMomentum,
  weeklySnapshot,
} from "./signals-extended.server";
import { getCrossAssetSnapshot, formatCrossAssetBlock } from "./cross-asset.server";
import { getOptionsSnapshot, formatOptionsBlock } from "./options-signals.server";
import { classifyPanicSell } from "./fear-sell-guard";
import { computeFearIndex, formatFearIndexBlock } from "./fear-index";
import {
  computeCrossSectionalRanks,
  formatCrossSectionalBlock,
  type RankInfo,
} from "./cross-sectional-ranking.server";
import { getNewsForDate } from "./news.server";
import { computeExecPostSignals } from "./exec-posts";
import { learnedExecPostNudge, learnedHalfLifeHours } from "./exec-post-learning";
import { loadActiveExecPostLessons } from "./exec-post-analysis.server";
import {
  extractMarketEvents,
  macroEventFeatures,
  symbolEventFeatures,
  eventTilt,
  formatMarketEventsBlock,
  type SymbolEventFeatures,
} from "./market-events";
import {
  playbookAdjustedTilt,
  formatMacroPlaybookBlock,
  drawdownSizeScale,
} from "./macro-playbook";
import { loadActiveMacroLessons } from "./macro-history-analysis.server";
import {
  ensureSentimentScored,
  aggregatedSentimentForSymbol,
  loadScoredNewsWindow,
  computeSentimentMomentum,
  type SentimentMomentum,
} from "./sentiment.server";
import {
  buildCorrelationMap,
  correlatedClusterAllowance,
  convictionSizedSpend,
  refreshCooldownsFromRecentTrades,
  isSymbolCooling,
  upcomingEvents,
} from "./portfolio-optimizer.server";
import { computeAttribution, formatAttributionBlock } from "./attribution.server";
import { getOrRefreshHyperparams, formatHyperparamBlock, type TunedHyperparams } from "./hyperparam-tuning.server";
import { getOrWalkForward } from "./hyperparam-walkforward.server";
import { logCounterfactual, evaluatePendingCounterfactuals } from "./counterfactuals.server";
import { ensembleVote, scoreDisagreement } from "./ensemble.server";
import { computeAndPersistCalibration, getLatestCalibration, formatCalibrationBlock } from "./calibration.server";
import {
  parseCircuit,
  evaluateBreaker,
  persistCircuit,
  tightenForRegime,
} from "./circuit-breaker.server";
import { applyBuyExecution, applySellExecution } from "./execution-realism.server";
import { estimateSaxoCommission, inferSaxoCurrency } from "./saxo-fees";
import { instrumentCcyFor } from "./instrument-ccy-rules";
import { normalizeMarketPriceForTrading, holdingAvgCostBase } from "./market-price-units";
import { valuePortfolioHoldings } from "./valuation/value-holdings.server";
import { engineSymbolKey, priceSymbolVariants, resolvePriceSymbol } from "./price-symbol";
import { writeEquitySnapshot } from "./valuation/write-snapshot.server";

// Resolve a live GBP-normalized price for a held symbol, tolerant of the
// symbol casing mismatch between `holdings.symbol` (often lowercase, e.g.
// "HSBA:xlon") and `priceMap` keys (uppercase). Falls back to the stored
// avg_cost with GBX→GBP normalization so LSE common stocks don't inflate the
// class-exposure buckets by 100× when the priceMap lookup misses.
// Price lookup by symbol alone (no holding row), tolerant of broker-native
// spellings. Returns null rather than guessing so callers can distinguish
// "no quote" from "quote is zero".
function holdingPriceBySymbol(priceMap: Map<string, number>, symbol: string): number | null {
  for (const key of priceSymbolVariants(symbol)) {
    const v = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  const v = priceMap.get(symbol);
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

function holdingLivePrice(
  priceMap: Map<string, number>,
  h: { symbol: string; avg_cost: number | string; asset_class?: string | null },
): number {
  for (const key of priceSymbolVariants(h.symbol)) {
    const live = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
    if (live != null && Number.isFinite(live)) return live;
  }
  const live = priceMap.get(h.symbol);
  if (live != null && Number.isFinite(live)) return live;
  return holdingAvgCostBase(h.symbol, h.avg_cost);
}

import { computeCommodityTradeLiquidity } from "./commodity-liquidity-metrics";
import { runBrokerSimulatorGuard } from "./broker-simulator-integration";
import {
  filterUniverse,
  filterUniverseByAffordability,

  findSymbol,
  riskProfile,
  parseRiskConfig,
  effectiveCashFloorPct,
  buildDiversificationTiltBlock,
  type UniverseSymbol,
} from "./universe.server";
import {
  detectAndPersistRegime,
  regimeDescription,
  humanRegime,
  type PersistedRegime,
} from "./regime-detector.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cached } from "./market-context-cache.server";
import { computePortfolioDrawdownSizing, grossExposureLimit } from "./portfolio-drawdown.server";
import { computeRebalanceTrims } from "./rebalance-bands.server";
import { refreshSectorScores, sectorSizeMultiplier, symbolSector } from "./sector-rotation.server";
import { updateSignalPerformance } from "./signal-decay.server";
import { checkOvernightGap } from "./overnight-gap.server";
import {
  evaluateChandelier,
  evaluateScaleOut,
  evaluateTimeStop,
  evaluateEventBlackout,
  reentryLockoutDays,
} from "./exits";
import { scoreUniverse, formatAlphaPriorsForPrompt } from "./alpha";
import { alphaConvictionBonus, riskParityTargetSpend } from "./alpha/sizing";
import {
  planOrderSlices,
  todExecutionAdjustment,
  inferVenueFromSymbol,
  resolveVenueTodConfig,
} from "./alpha/execution-alpha";

import type { Database } from "@/integrations/supabase/types";




type Portfolio = Database["public"]["Tables"]["portfolios"]["Row"];
type Holding = Database["public"]["Tables"]["holdings"]["Row"];

const SignalWeightsSchema = z.object({
  sma_trend: z.number().min(0).max(100),
  rsi: z.number().min(0).max(100),
  price_change: z.number().min(0).max(100),
  news_sentiment: z.number().min(0).max(100),
  volatility: z.number().min(0).max(100),
});

const OrderSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  percent: z.number(),
  // 0..1 model confidence in this specific call (used for Kelly-capped sizing)
  conviction: z.number().min(0).max(1).optional(),
  reason: z.string(),
  signal_weights: SignalWeightsSchema,
});


import { FxConversionOrderSchema } from "./ai-fx-conversions.server";
import { FxIntentSchema } from "./fx-intents";

const DecisionSchema = z.object({
  briefing: z.string(),
  rationale: z.string(),
  orders: z.array(OrderSchema),
  fx_conversions: z.array(FxConversionOrderSchema).optional(),
  fx_intents: z.array(FxIntentSchema).optional(),
});

export type DecisionOutput = z.infer<typeof DecisionSchema>;


function classesFromUniverse(u: unknown): Database["public"]["Enums"]["asset_class"][] {
  if (!Array.isArray(u)) return ["stock", "etf", "crypto", "commodity", "fx"];
  return u.filter(
    (x): x is Database["public"]["Enums"]["asset_class"] =>
      typeof x === "string" && ["stock", "etf", "crypto", "commodity", "fx"].includes(x),
  );
}

async function buildCandidateFeatures(
  candidates: UniverseSymbol[],
  asOf: string,
) {
  const rows: Array<{
    symbol: string;
    name: string;
    asset_class: string;
    price: number;
    sma20: number | null;
    sma50: number | null;
    rsi14: number | null;
    change5d: number | null;
    change30d: number | null;
    vol20d: number | null;
    macd_hist: number | null;
    macd_bull_cross: boolean;
    macd_bear_cross: boolean;
    bb_width: number | null;
    atr_pct: number | null;
    adv_20d: number | null;
    vw_momentum_10d: number | null;
    weekly_trend_up: boolean;
    weekly_rsi14: number | null;
    // Sentiment / cooldown are filled in later once news + cooldowns load
    news_score: number | null;
    news_contributors: number;
    news_momentum: SentimentMomentum | null;
    // Typed market-event features derived from the global news feed
    event_features: SymbolEventFeatures | null;
    cooling: boolean;
    // Cross-sectional rank across today's universe (filled in later)
    rank_info: RankInfo | null;
  }> = [];
  // One bulk `price_cache` read for the whole universe instead of one per
  // symbol per consumer — the rest of the tick then hits the in-memory memo.
  await primeDailyCandles(candidates.map((c) => c.symbol), 260, asOf);
  await Promise.all(
    candidates.map(async (c) => {
      const candles = await getDailyCandles(c.symbol, 260, asOf);
      if (candles.length < 5) return;
      const closes = candles.map((k) => k.close);
      const m = macd(closes);
      const wk = weeklySnapshot(candles);
      rows.push({
        symbol: c.symbol,
        name: c.name,
        asset_class: c.asset_class,
        price: closes[closes.length - 1],
        sma20: sma(closes, 20),
        sma50: sma(closes, 50),
        rsi14: rsi(closes, 14),
        change5d: pctChange(closes, 5),
        change30d: pctChange(closes, 30),
        vol20d: dailyVolatility(closes, 20),
        macd_hist: m ? m.histogram : null,
        macd_bull_cross: m ? m.bullish_cross : false,
        macd_bear_cross: m ? m.bearish_cross : false,
        bb_width: bollingerWidth(closes, 20),
        atr_pct: atrPct(candles, 14),
        adv_20d: averageDailyVolume(candles, 20),
        vw_momentum_10d: volumeWeightedMomentum(candles, 10),
        weekly_trend_up: wk?.weekly_trend_up ?? false,
        weekly_rsi14: wk?.weekly_rsi14 ?? null,
        news_score: null,
        news_contributors: 0,
        news_momentum: null,
        event_features: null,
        cooling: false,
        rank_info: null,
      });
    }),
  );
  return rows;
}




export type ExecutedTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string;
  instrument_ccy?: string;
  // Sizing telemetry — populated for commodity trades so the decision/executed
  // rows expose the same slippage/liquidity numbers the sizer used.
  liquidity?: import("./commodity-liquidity-metrics").CommodityTradeLiquidity;
  // Phase 6 — execution alpha telemetry.
  slice_plan?: { childCount: number; childNotional: number; advParticipationPct: number | null; reason: string };
  tod?: { multiplier: number; allow: boolean; reason: string };
};

export async function callAiForDecision(args: {
  portfolio: Portfolio;
  holdings: Holding[];
  cashValue: number;
  totalValue: number;
  features: Awaited<ReturnType<typeof buildCandidateFeatures>>;
  news: Array<{ headline: string; source: string | null; sentiment: number | null }>;
  execPosts?: Array<{ symbol: string; score: number; posts: number; executives: string[]; latest_date: string | null }>;
  /** Rules the AI itself derived from the executive-post ↔ market-pattern study. */
  execPostLessons?: string[];
  crossAsset: string; // preformatted block
  optionsBlock: string; // preformatted options-implied block
  crossSectional: string; // preformatted cross-sectional ranking block
  marketEvents?: string | null; // preformatted typed market-event block
  events: Array<{ event_date: string; kind: string; symbol: string | null; title: string; impact: string }>;
  cooling: string[];
  asOf: string;
  regime: PersistedRegime;
  learning: LearningContext;
  attribution?: string | null;
  regimeNote?: string | null;
  hyperparams?: TunedHyperparams | null;
  calibrationBlock?: string | null;
  budgetNotes?: string[];
  perSymbolBudget?: number;
  minTradeValue?: number;
  variantSuffix?: string | null;
  fxSystemBlock?: string | null;
  fxUserBlock?: string | null;
  alphaPriors?: string | null;
  cryptoSignalsBlock?: string | null;
  algoRegimeBlock?: string | null;



}): Promise<DecisionOutput> {

  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const gateway = createLovableAiGatewayProvider(key);
  const MODEL_ID = "google/gemini-2.5-flash";
  const model = gateway(MODEL_ID);

  const risk = riskProfile(args.portfolio.risk_level);
  const cfg = parseRiskConfig(args.portfolio.risk_config);
  const perSymbolCap = cfg.per_symbol_limit_pct ?? risk.maxPositionPct;

  const holdingsSummary = args.holdings.map((h) => ({
    symbol: h.symbol,
    quantity: Number(h.quantity),
    avg_cost: Number(h.avg_cost),
  }));

  const classLimitsStr = Object.entries(cfg.asset_class_limits)
    .map(([k, v]) => `${k}: ${((v as number) * 100).toFixed(0)}%`)
    .join(", ");
  const fxCcyLimitsStr = Object.entries(cfg.fx_currency_limits ?? {})
    .filter(([, v]) => Number.isFinite(v as number) && (v as number) > 0)
    .map(([k, v]) => `${k}: ${((v as number) * 100).toFixed(0)}% of NAV`)
    .join(", ");


  const r = args.regime;
  const regimeBlock = `MACRO REGIME (auto-detected from SPY/VIX/GLD/TLT as of ${r.as_of}):
- Current regime: ${humanRegime(r.regime)} (confidence ${(r.confidence * 100).toFixed(0)}%)
- Previous stored regime: ${r.previous_regime ? humanRegime(r.previous_regime) : "n/a"}${r.transitioned ? " — REGIME TRANSITION DETECTED TODAY" : ""}
- Signals: ${r.notes}
- Prior playbook for this regime: ${regimeDescription(r.regime)}
${r.transitioned ? "Because the regime just shifted, explicitly reassess existing holdings under the new prior and note it in the rationale." : "Bias posture toward the current regime's playbook."}`;

  const eventsBlock =
    args.events.length > 0
      ? `UPCOMING KNOWN EVENTS (within 3 days) — reduce position size into these:\n${args.events
          .map((e) => `- ${e.event_date} [${e.impact}] ${e.kind}${e.symbol ? ` ${e.symbol}` : ""}: ${e.title}`)
          .join("\n")}`
      : "UPCOMING KNOWN EVENTS: none tracked in the next 3 days.";

  const coolingBlock =
    args.cooling.length > 0
      ? `LOSS COOLDOWN active for: ${args.cooling.join(", ")}. Any BUY on these will be automatically halved by guardrails; consider skipping.`
      : "";

  const system = `You are a disciplined portfolio manager running a ${args.portfolio.currency} ${args.portfolio.starting_cash} paper-trading account.
HARD RULES YOU MUST NEVER BREAK:
- No borrowing, no margin, no shorting, no leverage, no derivatives.
- Cash balance must never go negative.
- No single position may exceed ${(perSymbolCap * 100).toFixed(0)}% of portfolio value.
- Keep at least ${(effectiveCashFloorPct(cfg, args.portfolio.risk_level) * 100).toFixed(0)}% of portfolio value in cash.
- Open at most ${risk.maxNewPositionsPerDay} NEW positions per day.
- Asset-class exposure caps: ${classLimitsStr}.
${fxCcyLimitsStr ? `- Non-base currency exposure caps (base=${args.portfolio.currency.toUpperCase()}, sum of foreign-denominated holdings in base terms): ${fxCcyLimitsStr}. Buys that would breach these caps are rejected — never rely on borrowing.` : ""}
- Highly correlated buys are portfolio-capped at 35% of value (guardrails will scale down).
- Positions with a ${cfg.stop_loss_pct > 0 ? `${(cfg.stop_loss_pct * 100).toFixed(0)}% drop from avg cost are auto-sold (stop-loss)` : "no stop-loss configured"}.
- Positions with a ${cfg.take_profit_pct > 0 ? `${(cfg.take_profit_pct * 100).toFixed(0)}% gain from avg cost are auto-sold (take-profit)` : "no take-profit configured"}.
- ${cfg.atr_trailing_mult > 0 ? `An ATR trailing stop at ${cfg.atr_trailing_mult}×ATR below each position's high-water mark auto-sells on breach.` : "No ATR trailing stop configured."}
- ${cfg.max_hold_days > 0 ? `Positions held longer than ${cfg.max_hold_days} days are auto-exited (time-based exit).` : "No time-based exit configured."}
${cfg.volatility_sizing ? `- Position sizing scales inversely to 20d volatility to target ~${(cfg.vol_target_pct * 100).toFixed(2)}% daily risk per position.` : ""}
- Only trade the provided symbols.

${regimeBlock}

${args.crossAsset}

${args.optionsBlock}

${args.crossSectional}

${args.marketEvents ?? ""}

${eventsBlock}
${coolingBlock}

${formatLearningBlock(args.learning)}

${args.attribution ?? ""}
${args.hyperparams ? formatHyperparamBlock(args.hyperparams) : ""}
${args.calibrationBlock ?? ""}
${args.regimeNote ? `REGIME RISK ADJUSTMENT: ${args.regimeNote}` : ""}
${args.alphaPriors ?? ""}
${args.algoRegimeBlock ?? ""}

${HISTORICAL_PLAYBOOK}

${HEDGE_FUND_PLAYBOOK}

${COMMODITY_PLAYBOOK}

${CRYPTO_PLAYBOOK}

${args.cryptoSignalsBlock ?? ""}

${args.fxSystemBlock ?? ""}

${buildDiversificationTiltBlock({ tilt: cfg.diversification_tilt, cfg })}


Style: ${args.portfolio.risk_level} risk. Explain concisely. Prefer inaction if uncertain.
Prefer high-conviction entries with MULTI-TIMEFRAME confirmation (daily trend AND weekly_trend_up), and be cautious when MACD or Bollinger width disagree with headline sentiment.
${args.variantSuffix ? `\n=== VARIANT OVERRIDE ===\n${args.variantSuffix}\n=== END VARIANT ===` : ""}`;



  const budgetBlock = args.perSymbolBudget != null
    ? `CASH-AWARE BUDGET:
- Available cash: ${args.cashValue.toFixed(2)} ${args.portfolio.currency}
- Per-symbol budget (cap × total, floored at cash): ${args.perSymbolBudget.toFixed(2)} ${args.portfolio.currency}
- Minimum trade value: ${(args.minTradeValue ?? 25).toFixed(2)} ${args.portfolio.currency}
- The candidate list has ALREADY been filtered to instruments whose share price fits within this budget. Do not propose buys of a size that cannot afford at least one whole share; guardrails will reject them.
${(args.budgetNotes ?? []).map((n) => `- ${n}`).join("\n")}`
    : "";

  const user = `Date: ${args.asOf}
Portfolio value: ${args.totalValue.toFixed(2)} ${args.portfolio.currency}
Cash: ${args.cashValue.toFixed(2)} ${args.portfolio.currency}
Current holdings: ${JSON.stringify(holdingsSummary)}

${budgetBlock}

${args.fxUserBlock ?? ""}

Candidate assets (extended technicals, sentiment, cooldown flag):
${JSON.stringify(args.features, null, 2)}

Recent headlines (sentiment -1 bearish .. +1 bullish, LLM-scored):
${args.news
  .slice(0, 15)
  .map(
    (n, i) =>
      `${i + 1}. [${n.source ?? "news"}] (sent ${n.sentiment == null ? "?" : n.sentiment.toFixed(2)}) ${n.headline}`,
  )
  .join("\n")}

Tracked CEO / founder social posts affecting these symbols (recency-weighted, -1..+1):
${args.execPosts && args.execPosts.length > 0
  ? args.execPosts
      .map((e) => `- ${e.symbol}: ${e.score.toFixed(2)} from ${e.posts} post(s) by ${e.executives.join(", ")} (latest ${e.latest_date ?? "n/a"})`)
      .join("\n")
  : "- none in the last 7 days"}
Posts by figures such as Elon Musk can move a ticker within minutes; treat a strongly negative post score as a reason to shrink or skip a BUY, and a strongly positive one as confirmation only when the technicals already agree.

Lessons you previously learned from studying these posts against the subsequent price path — apply them:
${args.execPostLessons && args.execPostLessons.length > 0
  ? args.execPostLessons.map((l) => `- ${l}`).join("\n")
  : "- no study on file yet; treat post scores as a tie-breaker only, never as a standalone entry."}

Return:
- briefing: 2-3 sentences on market context today (mention the ${humanRegime(r.regime)} regime${r.transitioned ? " and today's transition" : ""}, and cross-asset posture).
- rationale: 2-4 sentences explaining today's actions in light of the regime, cross-asset, and priors.
- orders: array of trades to place today. Each order has:
    symbol (must be from candidate list),
    side ("buy" or "sell"),
    percent (for BUY: % of current cash to spend, 1-100; for SELL: % of the held quantity to sell, 1-100),
    conviction: 0..1 (how sure you are). Higher conviction => guardrails allow larger Kelly-capped sizing.
    reason (one sentence citing the strongest 1-2 features),
    signal_weights: attribute the decision across five feature buckets, summing to 100:
      sma_trend       — MA trend AND MACD histogram / crosses (grouped)
      rsi             — daily RSI-14 AND weekly RSI alignment
      price_change    — recent price change (5d/30d) AND volume-weighted momentum
      news_sentiment  — weighted LLM sentiment for this symbol, its typed event_features (catalysts from the MARKET-EVENT FEED), INCLUDING its 3d/7d momentum (surge/accel in news_momentum). Rising sentiment (positive delta_3d and accel > 0) supports BUY; deteriorating sentiment (negative delta_3d, accel < 0) supports SELL or skip.
      volatility      — 20d vol, ATR%, Bollinger width
- fx_intents (PREFERRED when the FX WALLET & EXPOSURE block is present): array of typed intents (kind = "pre_fund" | "hedge" | "sweep_idle" | "carry_tilt" | "close_hedge") — see the FX STRATEGY playbook for the required fields per kind. Guardrails (per-tick turnover, min notional, tilt-exposure cap) are applied server-side; oversized intents are trimmed rather than rejected. Reason MUST cite the numbered rule and its numeric trigger.
- fx_conversions (LEGACY, discouraged unless no intent kind fits): array of { from_ccy, to_ccy, amount_percent (1..100 of the from-currency balance), reason }. Prefer fx_intents. Omit both if no FX action is warranted.
If no action is warranted, return an empty orders array.`;


  const timeoutRaw = Number(process.env.AI_DECISION_TIMEOUT_MS ?? 15_000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 15_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const { output } = await generateText({
      model,
      system,
      prompt: user,
      output: Output.object({ schema: DecisionSchema }),
      abortSignal: abortController.signal,
    });
    return output;
  } catch (error) {
    // AI gateway failures (403 Forbidden, 429 rate-limit, 402 credits,
    // network) and unparseable outputs must NEVER abort the tick — the
    // engine's downstream guardrail exits (stop-loss, take-profit, ATR
    // trailing, chandelier, time-based, hedging reconciliation) still need
    // to run. We also emit a NON-AI HEURISTIC set of protective sells so
    // risk keeps coming down even when the model is unreachable. No BUYs
    // are proposed without the model's risk view.
    const parseFail = NoObjectGeneratedError.isInstance(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    const msg = aborted
      ? `AI decision timed out after ${Math.round(timeoutMs / 1000)}s`
      : parseFail
      ? (error.text?.slice(0, 300) ?? "structured output parse error")
      : (error instanceof Error ? error.message : String(error));
    console.warn(
      `AI decision unavailable — falling back to heuristic (${parseFail ? "parse" : "gateway"}: ${msg.slice(0, 160)})`,
    );
    try {
      const { buildHeuristicDecision } = await import("./heuristic-decision");
      const heuristic = buildHeuristicDecision({
        holdings: args.holdings.map((h) => ({
          symbol: h.symbol,
          quantity: Number(h.quantity),
        })),
        features: args.features.map((f) => ({
          symbol: f.symbol,
          rsi14: f.rsi14,
          change5d: f.change5d,
          change30d: f.change30d,
          macd_hist: f.macd_hist,
          assetClass: (f as { asset_class?: string | null }).asset_class ?? null,
        })),

        reason: msg,
        cashValue: args.cashValue,
        riskLevel: args.portfolio.risk_level,
      });
      // Log any retail-mania guardrail hits (blocks + trims) as counterfactuals
      // so they surface in the decision-summary card with the full per-component
      // score breakdown (parabola 5d/30d, RSI, volume, short-interest, gamma,
      // social velocity). Best-effort — must never break the tick.
      if (heuristic.maniaBlocks.length > 0) {
        Promise.all(
          heuristic.maniaBlocks.map((mb) =>
            logCounterfactual({
              portfolioId: args.portfolio.id,
              asOf: args.asOf,
              symbol: mb.symbol,
              side: mb.action === "trim" ? "sell" : "buy",
              hypotheticalPrice: 0,
              blockReason: mb.reason,
            }).catch(() => {
              /* ignore */
            }),
          ),
        ).catch(() => {
          /* ignore */
        });
      }
      return {
        briefing: heuristic.briefing,
        rationale: heuristic.rationale,
        orders: heuristic.orders.map((o) =>
          o.side === "sell"
            ? {
                symbol: o.symbol,
                side: "sell" as const,
                percent: 100, // full-exit sell of the current holding
                conviction: 0.5,
                reason: o.reason,
                signal_weights: { sma_trend: 0, rsi: 0, price_change: 100, news_sentiment: 0, volatility: 0 },
              }
            : {
                symbol: o.symbol,
                side: "buy" as const,
                percent: o.percent,
                conviction: 0.4, // lower than model — reflects rule-set uncertainty
                reason: o.reason,
                signal_weights: { sma_trend: 40, rsi: 20, price_change: 30, news_sentiment: 0, volatility: 10 },
              },
        ),
      };
    } catch (heuristicErr) {
      // Heuristic itself must never break the tick. Fall through to an
      // empty decision so guardrails still run downstream.
      const hMsg = heuristicErr instanceof Error ? heuristicErr.message : String(heuristicErr);
      console.warn(`Heuristic fallback failed — ${hMsg}`);
      return {
        briefing: `AI provider unavailable (${msg.slice(0, 120)}); heuristic fallback errored. Guardrail exits still applied.`,
        rationale: `AI gateway error: ${msg.slice(0, 200)}. Heuristic error: ${hMsg.slice(0, 200)}.`,
        orders: [],
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function currentPrices(symbols: string[], asOf: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      // Broker-native spellings ("MKS:xlon") are not Yahoo symbols: fetching
      // them 404s every tick and leaves the holding unpriced, which silently
      // falls back to cost basis. Resolve to the canonical price key first,
      // then publish the quote under every variant so lookups by either
      // spelling hit.
      const canonical = resolvePriceSymbol(s);
      const p = (await getPriceOn(canonical, asOf)) ?? (canonical === s ? null : await getPriceOn(s, asOf));
      if (p != null) {
        const norm = normalizeMarketPriceForTrading(canonical, p);
        for (const key of new Set([s, canonical, ...priceSymbolVariants(s)])) {
          out.set(key, norm);
          out.set(key.toUpperCase(), norm);
          out.set(key.toLowerCase(), norm);
        }
      }
    }),
  );
  return out;
}


export async function runDailyTick(portfolioId: string, asOf: string, opts?: { skipNews?: boolean }) {
  // For live portfolios, pick up external Saxo deposits/withdrawals before we
  // read current_cash. Cron path: no authenticated session, so resolve the
  // owning user first and hand syncLiveCashFromBroker an admin-mode
  // OwnedDbClient. That flips isAdmin=true inside the sidecar so it re-scopes
  // the portfolio lookup by user_id (RLS is bypassed on this branch).
  //
  // For live_sim / live_prod portfolios this is a HARD guard: if the broker
  // read fails we abort the tick rather than sizing trades against stale
  // cash assumptions. The abort surfaces as a decision row so the user can
  // see why nothing traded.
  const ownerLookup = await supabaseAdmin
    .from("portfolios")
    .select("user_id, mode, broker, broker_account_id")
    .eq("id", portfolioId)
    .maybeSingle();
  const ownerMode = ownerLookup.data?.mode;
  // Only a portfolio actually bound to a broker account can (or must) have its
  // cash confirmed against the broker. An unlinked live_sim portfolio runs on a
  // purely local ledger — treating its unavoidable "no broker_account_id" skip
  // as a fatal reconciliation failure froze it out of trading entirely.
  const { resolvePortfolioBrokerLink } = await import(
    "@/lib/brokers/portfolio-broker-link.server"
  );
  const brokerLinked = ownerLookup.data
    ? resolvePortfolioBrokerLink(ownerLookup.data).linked
    : false;
  const isLiveMode = ownerMode === "live_sim" || ownerMode === "live_prod";
  const requiresBrokerCash = isLiveMode && brokerLinked;
  let cashSyncFailure: string | null = null;
  if (ownerLookup.data?.user_id) {
    try {
      const { syncLiveCashFromBroker } = await import("./live-cash-sync.server");
      const { withOwnedClient } = await import("./_server/owned-client");
      const res = await syncLiveCashFromBroker(
        portfolioId,
        withOwnedClient(ownerLookup.data.user_id),
      );
      // A "skipped" result on a broker-linked portfolio for any reason other
      // than "no material drift" means we couldn't confirm broker cash. Treat
      // as failure so we don't size against stale local cash.
      if (requiresBrokerCash && res.skipped && res.reason !== "no material drift") {
        cashSyncFailure = res.reason;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("cash sync failed", portfolioId, msg);
      if (requiresBrokerCash) cashSyncFailure = msg;
    }
  }


  if (cashSyncFailure) {
    const briefing = "Skipped: could not reconcile broker cash before sizing trades.";
    const rationale = `Pre-sizing cash reconciliation failed (${cashSyncFailure}). No trades were sized or placed to avoid acting on stale cash assumptions. The next tick will retry.`;
    await supabaseAdmin.from("decisions").insert({
      portfolio_id: portfolioId,
      run_date: asOf,
      briefing,
      rationale,
      model: "cash-reconcile-guard",
      portfolio_value: null,
      raw: asJson({ orders: [], executed: [], reconciliation_failed: true, reason: cashSyncFailure }),
    });
    return {
      decision: { briefing, rationale, orders: [] as { symbol: string; side: "buy" | "sell"; quantity: number }[] },
      executed: [] as { symbol: string; side: "buy" | "sell"; quantity: number; price: number; value: number; reason?: string; rejected?: string }[],
      totalValue: 0,
      cash: 0,
      routedOrders: null as unknown,
      skipped: true as const,
      skippedReason: "cash-reconcile-failed" as const,
      skippedDetail: cashSyncFailure,
    };
  }

  const { data: portfolio, error: pErr } = await supabaseAdmin
    .from("portfolios")
    .select("*")
    .eq("id", portfolioId)
    .single();
  if (pErr || !portfolio) throw new Error(pErr?.message ?? "Portfolio not found");


  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("*")
    .eq("portfolio_id", portfolioId);


  let fullUniverse = filterUniverse(classesFromUniverse(portfolio.universe));

  // Live-broker tradeability filter. Our Saxo integration only reliably resolves
  // plain equities/ETFs (US + LSE `.L`). Yahoo FX pairs (`=X`), futures (`=F`),
  // and crypto spot (`-USD`) do not map to Saxo retail cash-account UICs and
  // consistently fail with "instrument not found", so exclude them from the
  // universe for live_prod portfolios. live_sim and backtest keep the full set.
  const brokerBlockedSymbols: string[] = [];
  if (portfolio.mode === "live_prod") {
    const originalCount = fullUniverse.length;

    // Learned account-level blocks (e.g. Saxo suitability test not taken for
    // complex products like gold ETCs). Retrying these is guaranteed to fail.
    let learnedBlocked: string[] = [];
    try {
      const { loadActiveBrokerBlocks } = await import("./broker-instrument-blocks.server");
      learnedBlocked = (await loadActiveBrokerBlocks(portfolio.user_id as string)).map(
        (b) => b.symbol,
      );
    } catch (e) {
      console.warn("[trading-engine] could not load broker blocks:", e);
    }
    const { isSymbolBlocked } = await import("./broker-instrument-blocks");

    fullUniverse = fullUniverse.filter((u) => {
      const s = u.symbol.toUpperCase();
      const untradeable =
        s.endsWith("=X") ||
        s.endsWith("=F") ||
        s.endsWith("-USD") ||
        (learnedBlocked.length > 0 && isSymbolBlocked(u.symbol, learnedBlocked));
      if (untradeable) brokerBlockedSymbols.push(u.symbol);
      return !untradeable;
    });
    if (brokerBlockedSymbols.length > 0) {
      console.info(
        `[trading-engine] live_prod broker filter dropped ${brokerBlockedSymbols.length}/${originalCount} untradeable symbols: ${brokerBlockedSymbols.join(", ")}`,
      );
    }
  }


  // Partial execution: drop symbols whose venue is currently closed so the
  // AI sizes trades only against instruments that could actually fill this
  // tick. Held symbols are preserved so sells/stops remain visible even if
  // their venue is closed (they'll only fill on the next open, but keeping
  // them in the universe lets risk logic still see the position). Always-open
  // venues (crypto, FX) pass through untouched.
  {
    const { getMarketStatusForSymbol } = await import("./market-hours");
    const heldSet = new Set((holdings ?? []).map((h) => h.symbol));
    const closedSkipped: string[] = [];
    const beforeCount = fullUniverse.length;
    fullUniverse = fullUniverse.filter((u) => {
      if (heldSet.has(u.symbol)) return true;
      const open = getMarketStatusForSymbol(u.symbol).isOpen;
      if (!open) closedSkipped.push(u.symbol);
      return open;
    });
    if (closedSkipped.length > 0) {
      console.info(
        `[trading-engine] partial-exec: dropped ${closedSkipped.length}/${beforeCount} closed-venue symbols: ${closedSkipped.slice(0, 12).join(", ")}${closedSkipped.length > 12 ? "…" : ""}`,
      );
    }
  }



  // Price the entire (asset-class-filtered) universe up front so we can pick a
  // candidate list the portfolio's cash can actually trade. Held symbols are
  // always included so sells remain possible even if now unaffordable.
  const heldSymbols = (holdings ?? []).map((h) => h.symbol);
  const universePriceSyms = Array.from(
    new Set([...heldSymbols, ...fullUniverse.map((c) => c.symbol)]),
  );
  const priceMap = await currentPrices(universePriceSyms, asOf);

  const cash = Number(portfolio.current_cash);
  // Track how much of the book had no live quote and was valued off cost
  // basis. A large unpriced share means the NAV is a guess — risk halts must
  // not treat that shortfall as a real drawdown.
  let unpricedHoldingsValue = 0;
  const holdingsValue = (holdings ?? []).reduce((sum, h) => {
    const quoted = holdingPriceBySymbol(priceMap, h.symbol);
    const p = holdingLivePrice(priceMap, h);
    const value = p * Number(h.quantity);
    if (quoted == null) unpricedHoldingsValue += value;
    return sum + value;
  }, 0);
  const totalValue = cash + holdingsValue;


  // Cash-aware universe filter. Uses raw risk_config (pre-regime tightening) so
  // the pre-filter is at least as generous as the final guardrails. Shared
  // helper is unit-tested in src/lib/__tests__/affordability-filter.test.ts.
  const preRiskCfg = parseRiskConfig(portfolio.risk_config);
  const preRisk = riskProfile(portfolio.risk_level);
  const perSymbolCapPct = preRiskCfg.per_symbol_limit_pct ?? preRisk.maxPositionPct;
  const minTradeValue = preRiskCfg.execution_params?.min_trade_value ?? 25;
  const affordabilityResult = filterUniverseByAffordability({
    fullUniverse, priceMap, heldSymbols, cash, totalValue,
    perSymbolCapPct, minTradeValue, currency: portfolio.currency,
  });
  const perSymbolBudget = affordabilityResult.perSymbolBudget;
  const droppedForCash = affordabilityResult.dropped;
  const candidateSymbols = affordabilityResult.candidates;
  const budgetNotes = affordabilityResult.notes;


  // Circuit breaker: evaluate BEFORE spending on the AI call. If tripped,
  // we still run auto-liquidation stops but skip the AI + any new buys.
  const priorCircuit = parseCircuit(portfolio.circuit_breaker);
  const circuit = await evaluateBreaker(portfolioId, asOf, priorCircuit).catch(() => priorCircuit);
  const breakerTripped = circuit.paused;

  const universeKey = candidateSymbols.map((c) => c.symbol).sort().join(",");
  // Clone: features are per-portfolio-mutated below (news_score, cooling, rank_info),
  // but the raw technicals only need to be computed once per hour per universe.
  const rawFeatures = await cached("features", `${asOf}:${universeKey}`, () =>
    buildCandidateFeatures(candidateSymbols, asOf),
  );
  const features = rawFeatures.map((f) => ({ ...f }));

  const [rawNews, regime, learning, crossAsset, options, cooldowns, events, attribution, hyperparams, sectorScores, ddSizing, calibration, _cfEvalCount] = await Promise.all([
    opts?.skipNews
      ? Promise.resolve([])
      : cached("news", asOf, () => getNewsForDate(asOf)).catch(() => []),
    cached("regime", asOf, () => detectAndPersistRegime(asOf)).catch((e) => {
      console.warn("Regime detection failed:", e);
      return null;
    }),
    buildLearningContext(portfolioId, asOf).catch((e) => {
      console.warn("Learning context failed:", e);
      return {
        stats: {
          window_days: 20, horizon_days: 5, evaluable: 0, wins: 0, losses: 0,
          win_rate: null, avg_return_pct: null, best: null, worst: null,
          per_symbol: [], per_side: { buy: { n: 0, win_rate: null }, sell: { n: 0, win_rate: null } },
        },
        lessons: [], lessons_as_of: null, lessons_regime: null, lessons_raw: [], lessons_overrides: [], per_regime_stats: [], current_regime: null, samples: [],
      } satisfies LearningContext;
    }),
    cached("crossAsset", asOf, () => getCrossAssetSnapshot(asOf)).catch(() => null),
    cached("options", asOf, () => getOptionsSnapshot(asOf)).catch((e) => {
      console.warn("Options snapshot failed:", e);
      return null;
    }),
    refreshCooldownsFromRecentTrades(portfolioId, asOf).catch(() => ({})),
    cached("events", `${asOf}:${universeKey}`, () =>
      upcomingEvents(asOf, candidateSymbols.map((c) => c.symbol)),
    ).catch(() => []),
    computeAttribution(portfolioId, asOf).catch(() => null),
    // F. Walk-forward tuner (30d train / 7d validate cadence, audit-logged).
    getOrWalkForward(portfolioId, asOf).catch((e) => {
      console.warn("Walk-forward tuning failed, falling back:", e);
      return getOrRefreshHyperparams(portfolioId, asOf).catch(() => null as TunedHyperparams | null);
    }),
    cached("sectorScores", asOf, () => refreshSectorScores(asOf)).catch((e) => {
      console.warn("Sector rotation failed:", e);
      return [] as Awaited<ReturnType<typeof refreshSectorScores>>;
    }),
    computePortfolioDrawdownSizing(portfolioId).catch(() => ({
      peak_5d: null, current: null, drawdown_pct: 0, size_multiplier: 1, note: "dd calc failed",
    })),
    // K. Calibration (latest snapshot for prompt + sizing).
    getLatestCalibration(portfolioId).catch(() => ({
      brier_score: 0.25, samples: 0, hit_rate: null, avg_conviction: null,
      global_size_mult: 1, notes: "unavailable",
    })),
    // G. Evaluate any counterfactuals whose 5d window has fully elapsed.
    evaluatePendingCounterfactuals(asOf).catch(() => 0),
  ]);



  // Score news sentiment (LLM pass, cached), then aggregate per-symbol
  const scoredNews = rawNews.length > 0
    ? await cached("scoredNews", asOf, () =>
        ensureSentimentScored(asOf, rawNews),
      ).catch(() => rawNews.map((n) => ({
        ...n, sentiment: null, entities: [] as string[], source_weight: 0.4,
      })))
    : [];

  // Rolling 8-day window of scored headlines for momentum. Cheap: reads cache only.
  const scoredWindow = await cached("scoredWindow", asOf, () =>
    loadScoredNewsWindow(asOf, 8),
  ).catch(() => [] as Awaited<ReturnType<typeof loadScoredNewsWindow>>);

  // Tracked CEO/founder social posts (Musk & co.) reported by the wires.
  // These move tickers faster than ordinary coverage, so they get a small,
  // bounded nudge on top of the standard news sentiment.
  //
  // The strength, direction and decay of that nudge are no longer hardcoded:
  // `runExecPostAnalysis` studies how each person's posts actually mapped onto
  // forward returns and stores learned per-executive coefficients, which are
  // loaded here. With no study on file this falls back to the catalogued
  // defaults, so the engine behaves exactly as before.
  const execLessons = portfolio.user_id
    ? await loadActiveExecPostLessons(supabaseAdmin as never, portfolio.user_id).catch(() => null)
    : null;
  const execCoefficients = execLessons?.coefficients ?? null;

  // Learned macro playbook: `runMacroHistoryAnalysis` studies ~20 years of
  // index history plus the documented episode catalogue and stores, per
  // event kind, whether the first move historically extended (follow),
  // round-tripped (fade), needed confirmation (wait) or preceded a slow bear
  // (de_risk) — plus buy-size scaling by how deep the index already is.
  // With no study on file every multiplier is 1 and the engine is unchanged.
  const macroLessons = portfolio.user_id
    ? await loadActiveMacroLessons(supabaseAdmin as never, portfolio.user_id).catch(() => null)
    : null;
  const macroPlaybook = macroLessons?.playbook ?? null;

  const execPostSignals = computeExecPostSignals(
    [
      ...scoredNews.map((n) => ({
        headline: n.headline,
        source: n.source,
        sentiment: n.sentiment,
        date: asOf,
      })),
      ...scoredWindow.map((n) => ({
        headline: n.headline,
        source: n.source,
        sentiment: n.sentiment,
        date: n.news_date,
      })),
    ],
    asOf,
    execCoefficients && execCoefficients.length > 0
      ? { halfLifeHours: learnedHalfLifeHours(execCoefficients) }
      : undefined,
  );

  // Market-event ingestion: type today's + the rolling window's headlines into
  // dated events (earnings, guidance, M&A, rate decisions, tariffs, shocks) so
  // the decision layer sees explicit catalysts, not just an average sentiment.
  const marketEvents = extractMarketEvents(
    [
      ...scoredNews.map((n) => ({
        headline: n.headline,
        source: n.source,
        sentiment: n.sentiment,
        entities: n.entities,
        source_weight: n.source_weight,
        date: asOf,
      })),
      ...scoredWindow.map((n) => ({
        headline: n.headline,
        source: n.source,
        sentiment: n.sentiment,
        entities: n.entities,
        source_weight: n.source_weight,
        date: n.news_date,
      })),
    ],
    asOf,
  );
  const macroEvents = macroEventFeatures(marketEvents);

  for (const f of features) {
    const agg = aggregatedSentimentForSymbol(f.symbol, f.name, scoredNews, asOf);
    const execNudge = learnedExecPostNudge(f.symbol, execPostSignals, execCoefficients).nudge;
    const evf = symbolEventFeatures(f.symbol, f.name, marketEvents);
    const rawTilt = eventTilt(evf, macroEvents);
    // The playbook re-weights the tilt by what this event kind historically
    // did — including flipping the sign for "fade" kinds. Still hard-capped
    // at MAX_EVENT_TILT inside `playbookAdjustedTilt`.
    const evTilt = playbookAdjustedTilt(
      rawTilt,
      [...evf.top_kinds, ...macroEvents.drivers.map((d) => d.kind)],
      macroPlaybook,
    );
    const base = agg.contributors > 0 ? agg.score : 0;
    const blended = Math.max(-1, Math.min(1, base + execNudge + evTilt));
    f.news_score =
      agg.contributors > 0 || execNudge !== 0 || evTilt !== 0
        ? Number(blended.toFixed(3))
        : null;
    f.news_contributors = agg.contributors;
    f.news_momentum = computeSentimentMomentum(f.symbol, f.name, scoredWindow, asOf);
    f.event_features = evf.event_count > 0 ? evf : null;
    f.cooling = isSymbolCooling(cooldowns, f.symbol, asOf);
  }

  const macroPlaybookBlock = formatMacroPlaybookBlock(
    macroLessons,
    // Drawdown context is resolved below once the regime is known; the block
    // only needs the raw depth, which the regime snapshot already carries.
    regime?.signals.spy_drawdown_pct ?? null,
    [
      ...new Set([
        ...features.flatMap((f) => f.event_features?.top_kinds ?? []),
        ...macroEvents.drivers.map((d) => String(d.kind)),
      ]),
    ],
  );

  const marketEventsBlock = formatMarketEventsBlock(
    macroEvents,
    features.map((f) => ({
      symbol: f.symbol,
      features: f.event_features ?? { event_score: 0, event_pressure: 0, event_count: 0, hard_catalyst: false, top_kinds: [] },
    })),
  );

  // Cross-sectional ranking across today's universe (momentum + trend + quality + low-vol)
  const rankMap = computeCrossSectionalRanks(features);
  for (const f of features) f.rank_info = rankMap.get(f.symbol) ?? null;

  const coolingSymbols = features.filter((f) => f.cooling).map((f) => f.symbol);

  // Regime-linked risk tightening: bear/crisis → tighter per-symbol cap and stop-loss.
  const risk = riskProfile(portfolio.risk_level);
  const baseCfg = parseRiskConfig(portfolio.risk_config);
  const effectiveRegime = regime ?? {
    as_of: asOf,
    regime: "bull_quiet" as const,
    previous_regime: null,
    transitioned: false,
    confidence: 0,
    signals: {
      spy_price: null, spy_sma50: null, spy_sma200: null,
      spy_drawdown_pct: null, spy_return_30d: null, spy_vol_20d: null,
      vix_level: null, gld_return_30d: null, tlt_return_30d: null,
    },
    notes: "regime detection unavailable",
  };

  // Composite FEAR INDEX — blends VIX level/term structure/VVIX/SKEW/put-call
  // proxy with the index drawdown into a single 0..100 gauge. It is threaded
  // into the AI prompt AND enforced deterministically in the buy-sizing chain.
  const fearIndex = computeFearIndex({
    vix: options?.vix ?? effectiveRegime.signals.vix_level ?? null,
    vix9d: options?.vix9d ?? null,
    vix3m: options?.vix3m ?? null,
    vvix: options?.vvix ?? null,
    skew: options?.skew ?? null,
    putCallProxy: options?.put_call_proxy ?? null,
    drawdownPct: effectiveRegime.signals.spy_drawdown_pct ?? null,
  });
  const fearBlock = formatFearIndexBlock(fearIndex);

  const tightened = tightenForRegime(baseCfg, portfolio.risk_level, effectiveRegime);

  const cfg = tightened.cfg;
  // Risk dial (1..5) → position sizing + per-side trade aggressiveness.
  const aggression = resolveAggressiveness(portfolio.risk_config);
  const cashFloorPctEff = effectiveCashFloorPct(cfg, portfolio.risk_level);
  const cashFloor = totalValue * cashFloorPctEff;
  const basePerSymbolPct = tightened.per_symbol_effective_pct;

  // Learned drawdown sizing: the 20-year study measured the forward return
  // from each depth below the index high. Deep holes historically needed a
  // confirmed turn, so the playbook is allowed to SHRINK the per-symbol cap
  // there — never to widen it beyond the configured risk limit.
  const macroDdSizing = drawdownSizeScale(
    effectiveRegime.signals.spy_drawdown_pct,
    macroLessons?.drawdown_rules ?? null,
  );
  const ddSizeScale = Math.min(1, macroDdSizing.scale);
  const maxPosVal = totalValue * basePerSymbolPct * ddSizeScale;

  // Build FX context (wallet, exposure by currency, live rates, circuit state).
  // Safe to call even when fx_enabled is false — returns an inactive context
  // that just tells the model FX is off. Never throws.
  const { buildFxContext, applyAiFxConversions } = await import("./ai-fx-conversions.server");
  const fxContext = await buildFxContext({
    portfolio,
    holdings: holdings ?? [],
    priceMap,
    candidateSymbols: candidateSymbols.map((c) => c.symbol),
  }).catch((e) => {
    console.warn("fx context build failed", e);
    return null;
  });

  // Alpha priors: composite scores per symbol, blended by regime. We hoist
  // these out of the AI-decision IIFE so the sizing pipeline can also
  // reference them (Phase 2 bonus + Phase 5 risk parity).
  const alphaScores = scoreUniverse(
    features as unknown as Parameters<typeof scoreUniverse>[0],
    effectiveRegime.regime,
  );
  const alphaCompositeBySymbol = new Map(alphaScores.map((s) => [s.symbol, s.composite] as const));
  const alphaPriors = formatAlphaPriorsForPrompt(alphaScores, effectiveRegime.regime, 10);

  // Crypto sleeve — dedicated allocation & risk-management engine. Computes
  // per-symbol trend/momentum/drawdown signals, maps regime → sleeve target,
  // and formats a compact prompt block the AI must respect (plus a HARD
  // veto in risk_off regimes that the sizing layer also honours).
  const cryptoDecision = await (async () => {
    try {
      const { computeCryptoSleeveDecision, formatCryptoSignalsBlock } =
        await import("./crypto-strategy.server");
      const cryptoHoldings = (holdings ?? [])
        .filter((h) => h.asset_class === "crypto")
        .map((h) => {
          const px = priceMap.get(h.symbol) ?? 0;
          return { symbol: h.symbol, market_value_base: Number(h.quantity) * px };
        });
      const d = await computeCryptoSleeveDecision({
        asOf,
        riskLevel: portfolio.risk_level,
        regime: effectiveRegime.regime,
        nav: totalValue,
        holdings: cryptoHoldings,
      });
      return { decision: d, block: formatCryptoSignalsBlock(d) };
    } catch (e) {
      console.warn("crypto sleeve decision failed", e);
      return null;
    }
  })();

  // Phase E — algo-regime guard. Best-effort snapshot; failure never blocks
  // the tick. Threaded into the AI prompt (Phase D), into live routing
  // (Phase B pre-place block for new BUYs) and persisted in decisions.raw
  // for observability.
  const algoRegime = await (async () => {
    try {
      const { buildAlgoRegimeSnapshot } = await import(
        "./microstructure/algo-regime.server"
      );
      return await buildAlgoRegimeSnapshot({
        asOf,
        holdingSymbols: (holdings ?? []).map((h) => h.symbol),
        portfolioId,
      });
    } catch (e) {
      console.warn("algo-regime snapshot failed", e);
      return null;
    }
  })();
  const algoRegimeBlock = await (async () => {
    if (!algoRegime) return null;
    const { formatAlgoRegimePromptBlock } = await import(
      "./microstructure/algo-regime-prompt"
    );
    return formatAlgoRegimePromptBlock(algoRegime);
  })();

  // If circuit breaker is tripped, skip the AI call entirely.

  const decision: DecisionOutput = breakerTripped
    ? {
        briefing: `Circuit breaker active (${circuit.reason ?? "auto-paused"}). No new AI decisions today; stop-loss / take-profit still enforced.`,
        rationale: "Trading is auto-paused. Review diagnostics or resume manually.",
        orders: [],
      }
    : await callAiForDecision({
        portfolio,
        holdings: holdings ?? [],
        cashValue: cash,
        totalValue,
        features,
        news: scoredNews.slice(0, 15).map((n) => ({
          headline: n.headline,
          source: n.source,
          sentiment: n.sentiment,
        })),
        execPosts: execPostSignals.slice(0, 8),
        execPostLessons: execLessons?.lessons?.slice(0, 12) ?? [],
        crossAsset: crossAsset ? formatCrossAssetBlock(crossAsset) : "CROSS-ASSET CONTEXT: unavailable.",
        optionsBlock: `${options ? formatOptionsBlock(options) : "OPTIONS-IMPLIED SIGNALS: unavailable."}\n\n${fearBlock}`,
        crossSectional: formatCrossSectionalBlock(rankMap),
        marketEvents: macroPlaybookBlock
          ? `${marketEventsBlock}\n\n${macroPlaybookBlock}`
          : marketEventsBlock,
        events,
        cooling: coolingSymbols,
        asOf,
        regime: effectiveRegime,
        learning,
        attribution: attribution ? formatAttributionBlock(attribution) : null,
        regimeNote: tightened.note,
        hyperparams: hyperparams ?? null,
        calibrationBlock: formatCalibrationBlock(calibration),
        budgetNotes,
        perSymbolBudget,
        minTradeValue,
        fxSystemBlock: fxContext?.block ?? null,
        fxUserBlock: fxContext?.contextBlock ?? null,
        alphaPriors,
        cryptoSignalsBlock: cryptoDecision?.block ?? null,
        algoRegimeBlock,
      });


  // Enforce the crypto sleeve's hard risk-off veto in the sizing layer too,
  // not just in the prompt. If the regime bucket is risk_off, strip any AI
  // crypto BUY orders (X6) — sells / trims are always allowed to fire.
  if (cryptoDecision?.decision?.hard_veto) {
    const { classifyCryptoSymbol } = await import("./crypto-groups");
    const before = decision.orders.length;
    decision.orders = decision.orders.filter((o) => {
      const isCrypto = classifyCryptoSymbol(o.symbol) != null;
      return !(isCrypto && o.side === "buy");
    });
    const stripped = before - decision.orders.length;
    if (stripped > 0) {
      decision.briefing = `${decision.briefing}\n[Crypto sleeve veto] ${cryptoDecision.decision.veto_reason} — ${stripped} crypto BUY order(s) removed.`;
    }
  }





  // Feature lookup for later use (volatility sizing, asset class)
  const featureBySymbol = new Map(features.map((f) => [f.symbol, f] as const));

  // Per-symbol microstructure calibration overrides (ADV$, realized vol, ATR
  // → tightened impact_coeff / vol_widening_coeff_bps / caps). Falls back to
  // DEFAULT_TUNING when a symbol has no persisted calibration row.
  const { loadTuningForSymbols } = await import("./execution-calibration.server");
  const symbolTuning = await loadTuningForSymbols(features.map((f) => f.symbol))
    .catch(() => new Map<string, import("./spread-slippage").SpreadSlippageTuning>());


  // Phase 6 — execution-alpha helper for sells. Mirrors the buy-path wiring
  // (TOD haircut/hard-block + slice plan) so protective and discretionary
  // sells surface the same telemetry and respect the same auction windows.
  // `protective=true` skips the TOD gate so stop-losses / event-blackout
  // liquidations can always fire; slicing still applies for the audit trail.
  const applyExecAlphaSell = (
    symbol: string,
    notional: number,
    fillPrice: number,
    opts: { protective?: boolean } = {},
  ): {
    allow: boolean;
    adjNotional: number;
    tod?: { multiplier: number; allow: boolean; reason: string };
    slicePlan?: { childCount: number; childNotional: number; advParticipationPct: number | null; reason: string };
  } => {
    let adjNotional = notional;
    let tod: { multiplier: number; allow: boolean; reason: string } | undefined;
    if (cfg.tod_filter_enabled && !opts.protective) {
      const venue = inferVenueFromSymbol(symbol);
      const venueCfg = resolveVenueTodConfig(
        {
          avoidOpenMin: cfg.tod_avoid_open_min,
          avoidCloseMin: cfg.tod_avoid_close_min,
          openHaircut: cfg.tod_open_haircut,
          closeHaircut: cfg.tod_close_haircut,
          hardBlockOpenMin: cfg.tod_hard_block_open_min,
          hardBlockCloseMin: cfg.tod_hard_block_close_min,
        },
        venue,
        cfg.tod_venue_overrides,
      );
      tod = todExecutionAdjustment({ venue, ...venueCfg });
      if (!tod.allow) return { allow: false, adjNotional: 0, tod };
      if (tod.multiplier < 1) adjNotional = adjNotional * tod.multiplier;
    }

    const slicePlan = cfg.execution_slicing_enabled && adjNotional > 0
      ? planOrderSlices({
          parentNotional: adjNotional,
          price: fillPrice,
          adv20d: featureBySymbol.get(symbol)?.adv_20d ?? null,
          participationCap: cfg.execution_participation_cap,
          maxChildNotional: cfg.execution_max_child_notional,
        })
      : undefined;
    return {
      allow: true,
      adjNotional,
      tod,
      slicePlan: slicePlan
        ? {
            childCount: slicePlan.childCount,
            childNotional: slicePlan.childNotional,
            advParticipationPct: slicePlan.advParticipationPct,
            reason: slicePlan.reason,
          }
        : undefined,
    };
  };


  let workingCash = cash;
  // Keyed by canonical universe symbol (see engineSymbolKey); the record
  // keeps its broker-native `symbol` so persistence targets the same row.
  const holdingsByS = new Map(
    (holdings ?? []).map((h) => [engineSymbolKey(h.symbol), { ...h }] as const),
  );
  const executed: ExecutedTrade[] = [];
  let newPositions = 0;

  // -------- Hard risk halts (max daily loss, max drawdown) --------
  // Evaluated once against pre-execution equity. If either trips, every BUY
  // in this run is rejected with a halt reason — sells (including automatic
  // stop-losses above) still fire so the portfolio can de-risk.
  const { evaluateRiskHalts, loadEquityStats } = await import("./risk-halts.server");
  const equityStats = await loadEquityStats(supabaseAdmin, portfolioId, asOf).catch(
    () => ({ priorCloseEquity: null, peakEquity: null }),
  );
  const halts = evaluateRiskHalts({
    startingEquity: Number(portfolio.starting_cash) || totalValue,
    currentEquity: totalValue,
    unpricedHoldingsValue,
    priorCloseEquity: equityStats.priorCloseEquity,
    peakEquity: equityStats.peakEquity,
    thresholds: {
      max_position_pct: basePerSymbolPct,
      max_daily_loss_pct: cfg.max_daily_loss_pct,
      max_drawdown_halt_pct: cfg.max_drawdown_halt_pct,
    },
  });
  if (halts.valuation_suspect) {
    console.warn(
      `[trading-engine] risk halts suppressed for ${portfolioId}: valuation unreliable (unpriced ${unpricedHoldingsValue.toFixed(2)} of ${totalValue.toFixed(2)})`,
    );
  }


  // ---- Auto-liquidation: multi-layer exits BEFORE the AI runs ----
  // Layers, in evaluation order:
  //  1. Hard stop-loss / take-profit (fixed %)
  //  2. Chandelier trailing stop (adaptive ATR, tightens as R grows) — replaces the
  //     fixed atr_trailing_mult trail when cfg.chandelier_enabled is true.
  //  3. Time-stop tied to horizon (exit when horizon elapsed with < min R progress)
  //  4. Event blackout trim (partial sell of oversized positions into known events)
  //  5. Scale-out ladder (25% @1R, 25% @2R by default) — partial sells only
  //  6. Legacy max_hold_days hard exit
  // Any exit that isn't a pure take-profit adds the symbol to the loss-cooldown
  // map with an ATR-adaptive lockout so we don't re-enter into the same setup.
  const atrPctBySymbol = new Map(features.map((f) => [f.symbol, f.atr_pct] as const));
  const nowMs = Date.parse(asOf + "T00:00:00Z") || Date.now();

  // Prior scale-out fills per symbol (since opened_at) — read from trades.reason.
  const scaleOutTakenBySym = new Map<string, number>();
  if (cfg.scale_out_enabled) {
    try {
      const { data: recentSells } = await supabaseAdmin
        .from("trades")
        .select("symbol, reason, trade_date")
        .eq("portfolio_id", portfolioId)
        .eq("side", "sell")
        .ilike("reason", "scale-out%")
        .gte("trade_date", (() => {
          const d = new Date(nowMs); d.setUTCDate(d.getUTCDate() - 365);
          return d.toISOString().slice(0, 10);
        })());
      for (const t of recentSells ?? []) {
        // Only count fills after this position's opened_at.
        const h = holdingsByS.get(engineSymbolKey(String((t as { symbol: string }).symbol)));
        if (!h) continue;
        const openedAt = (h as unknown as { opened_at?: string | null }).opened_at;
        if (!openedAt) continue;
        if (String((t as { trade_date: string }).trade_date) >= openedAt.slice(0, 10)) {
          const key = engineSymbolKey(String((t as { symbol: string }).symbol));
          scaleOutTakenBySym.set(key, (scaleOutTakenBySym.get(key) ?? 0) + 1);

        }
      }
    } catch {
      // best-effort; if the read fails, scale-out treats history as empty
    }
  }

  const eventList = (events ?? []).map((e: { event_date: string; impact?: string | null; kind?: string | null; symbol?: string | null }) => ({
    event_date: String(e.event_date),
    impact: (e.impact ?? null) as string | null,
    kind: (e.kind ?? null) as string | null,
    symbol: (e.symbol ?? null) as string | null,
  }));

  for (const [sym, h] of Array.from(holdingsByS.entries())) {
    const price = priceMap.get(sym);
    const qty = Number(h.quantity);
    const cost = Number(h.avg_cost);
    if (!price || !(qty > 0) || !(cost > 0)) continue;

    // Refresh high-water mark BEFORE any trail check
    const prevHwm = Number((h as unknown as { high_water_mark?: number | null }).high_water_mark ?? cost);
    const hwm = Math.max(prevHwm || cost, price);
    (h as unknown as { high_water_mark: number }).high_water_mark = hwm;

    const change = (price - cost) / cost;
    const atrPct = atrPctBySymbol.get(sym) ?? 0;
    let trigger: string | null = null;
    let triggerKind: "stop" | "take_profit" | "trail" | "time" | "max_hold" = "stop";
    let sellFraction = 1; // full liquidation unless a partial-exit layer overrides

    // 1. Hard stop-loss / take-profit
    if (cfg.stop_loss_pct > 0 && change <= -cfg.stop_loss_pct) {
      trigger = `stop-loss triggered (${(change * 100).toFixed(2)}% ≤ -${(cfg.stop_loss_pct * 100).toFixed(1)}%)`;
      triggerKind = "stop";
    } else if (cfg.take_profit_pct > 0 && change >= cfg.take_profit_pct) {
      trigger = `take-profit triggered (+${(change * 100).toFixed(2)}% ≥ +${(cfg.take_profit_pct * 100).toFixed(1)}%)`;
      triggerKind = "take_profit";
    } else if (cfg.chandelier_enabled && atrPct > 0) {
      // 2. Chandelier trail — replaces the fixed atr_trailing_mult check when enabled.
      const ch = evaluateChandelier({
        avgCost: cost, price, highWaterMark: hwm, atrPct,
        initialStopAtrMult: cfg.initial_stop_atr_mult,
        kBase: cfg.chandelier_k_base,
        kTight: cfg.chandelier_k_tight,
        tightenAfterR: cfg.chandelier_tighten_after_r,
      });
      if (ch.breached) {
        trigger = `chandelier trail (k=${ch.effectiveK.toFixed(2)}×ATR, ${ch.dropFromHwmPct.toFixed(2)}% from high, ${ch.unrealisedR.toFixed(2)}R held)`;
        triggerKind = "trail";
      }
    } else if (cfg.atr_trailing_mult > 0 && atrPct > 0) {
      // Legacy fixed-multiple trail (only when chandelier disabled).
      const stopPrice = hwm * (1 - cfg.atr_trailing_mult * atrPct);
      if (price <= stopPrice) {
        const dropFromHwm = ((price - hwm) / hwm) * 100;
        trigger = `ATR trailing stop (${dropFromHwm.toFixed(2)}% from high, ${cfg.atr_trailing_mult}×ATR=${(cfg.atr_trailing_mult * atrPct * 100).toFixed(2)}%)`;
        triggerKind = "trail";
      }
    }

    // 3. Time-stop tied to horizon
    if (!trigger && cfg.time_stop_enabled && atrPct > 0) {
      const openedAt = (h as unknown as { opened_at?: string | null }).opened_at;
      if (openedAt) {
        const ts = evaluateTimeStop({
          avgCost: cost, price, atrPct,
          initialStopAtrMult: cfg.initial_stop_atr_mult,
          openedAtMs: Date.parse(openedAt) || nowMs,
          nowMs,
          horizonDays: cfg.time_stop_horizon_days,
          minProgressR: cfg.time_stop_min_progress_r,
        });
        if (ts.triggered) {
          trigger = ts.reason!;
          triggerKind = "time";
        }
      }
    }

    // 4. Event blackout trim (partial sell — does not fully close)
    if (!trigger && cfg.event_blackout_enabled && eventList.length > 0) {
      const positionValue = qty * price;
      const eb = evaluateEventBlackout({
        symbol: sym, positionValue, portfolioValue: totalValue,
        events: eventList, asOf,
        windowDays: cfg.event_blackout_window_days,
        blackoutPctNav: cfg.event_blackout_pct_nav,
        targetPctNav: cfg.event_blackout_target_pct_nav,
        highImpactOnly: true,
      });
      if (eb.trim) {
        trigger = eb.reason!;
        triggerKind = "trail"; // partial defensive exit; treat as stop-like for cooldown
        sellFraction = eb.sellFraction;
      }
    }

    // 5. Scale-out ladder (partial sell)
    if (!trigger && cfg.scale_out_enabled && atrPct > 0) {
      const so = evaluateScaleOut({
        avgCost: cost, price, atrPct,
        initialStopAtrMult: cfg.initial_stop_atr_mult,
        levels: cfg.scale_out_levels.map((l) => ({ rMultiple: l.r, fractionOfPosition: l.frac })),
        levelsAlreadyTaken: scaleOutTakenBySym.get(sym) ?? 0,
      });
      if (so.fire) {
        trigger = so.reason!;
        triggerKind = "take_profit"; // partial take-profit; do NOT lock the symbol out
        sellFraction = so.sellFraction;
      }
    }

    // 6. Legacy max_hold_days
    if (!trigger && cfg.max_hold_days > 0) {
      const openedAt = (h as unknown as { opened_at?: string | null }).opened_at;
      if (openedAt) {
        const heldDays = Math.floor((nowMs - Date.parse(openedAt)) / 86_400_000);
        if (heldDays >= cfg.max_hold_days) {
          trigger = `max-hold reached (${heldDays}d ≥ ${cfg.max_hold_days}d)`;
          triggerKind = "max_hold";
        }
      }
    }

    if (!trigger) continue;

    const sellQty = qty * Math.max(0, Math.min(1, sellFraction));
    if (!(sellQty > 0)) continue;
    const value = sellQty * price;
    workingCash += value;
    const remaining = qty - sellQty;
    if (remaining <= 1e-8) {
      holdingsByS.delete(sym);
    } else {
      holdingsByS.set(sym, { ...h, quantity: remaining } as Holding);
    }
    // Protective exit — TOD hard-blocks are bypassed; slicing telemetry still attached.
    const ea = applyExecAlphaSell(sym, value, price, { protective: true });
    executed.push({
      symbol: sym, side: "sell", quantity: sellQty, price, value,
      reason: trigger, tod: ea.tod, slice_plan: ea.slicePlan,
    });

    // Re-entry lockout for adverse exits only (stop / trail / time / event-blackout / max-hold).
    // Take-profit and scale-out are constructive — they don't trigger lockout.
    if (cfg.reentry_lockout_enabled && triggerKind !== "take_profit") {
      const days = reentryLockoutDays({
        atrPct,
        baseCooldownDays: cfg.reentry_min_days,
        atrDaysMult: cfg.reentry_atr_days_mult,
        minDays: cfg.reentry_min_days,
        maxDays: cfg.reentry_max_days,
      });
      const untilDate = new Date(nowMs);
      untilDate.setUTCDate(untilDate.getUTCDate() + days);
      (cooldowns as Record<string, string>)[sym] = untilDate.toISOString().slice(0, 10);
    }
  }

  // Recompute per-asset-class exposure after auto-liquidation, based on live prices.
  const classExposure = new Map<string, number>();
  for (const h of holdingsByS.values()) {
    const price = holdingLivePrice(priceMap, h);
    classExposure.set(
      h.asset_class,
      (classExposure.get(h.asset_class) ?? 0) + price * Number(h.quantity),
    );
  }

  // Per-commodity-group exposure (Gold, Silver, Basket, …) recomputed for
  // the enforcement pass below. Mirrors `classExposure` but keyed on the
  // shared commodity classifier.
  const { classifyCommoditySymbol } = await import("./commodity-groups");
  const commodityGroupExposure = new Map<string, number>();
  for (const h of holdingsByS.values()) {
    if (h.asset_class !== "commodity") continue;
    const grp = classifyCommoditySymbol(h.symbol);
    if (!grp) continue;
    const price = holdingLivePrice(priceMap, h);
    commodityGroupExposure.set(
      grp,
      (commodityGroupExposure.get(grp) ?? 0) + price * Number(h.quantity),
    );
  }

  // Per-currency exposure (base-ccy value) for non-base holdings. Used to
  // enforce cfg.fx_currency_limits without allowing leverage — cap can only
  // shrink a proposed buy, never inflate one, and never permit borrowing.
  const { inferSymbolCurrency } = await import("./ai-fx-conversions.server");
  const portfolioBaseCcy = (portfolio.currency || "USD").toUpperCase();
  const currencyExposure = new Map<string, number>();
  for (const h of holdingsByS.values()) {
    const ccy = inferSymbolCurrency(h.symbol, portfolioBaseCcy).toUpperCase();
    if (ccy === portfolioBaseCcy) continue;
    const price = holdingLivePrice(priceMap, h);
    currencyExposure.set(ccy, (currencyExposure.get(ccy) ?? 0) + price * Number(h.quantity));
  }





  // Build correlation map covering current holdings + candidate buys
  const buySymbols = decision.orders
    .filter((o) => o.side === "buy")
    .map((o) => o.symbol.toUpperCase())
    .filter((s) => !!findSymbol(s));
  const corrSymbols = Array.from(new Set([...holdingsByS.keys(), ...buySymbols]));
  const corrMap = corrSymbols.length > 1
    ? await buildCorrelationMap(corrSymbols, asOf).catch(() => new Map<string, Map<string, number>>())
    : new Map<string, Map<string, number>>();

  // High-impact events touching a symbol => size penalty
  const eventPenaltyBySymbol = new Map<string, number>();
  for (const ev of events) {
    if (!ev.symbol) continue;
    const key = ev.symbol.toUpperCase();
    const penalty = ev.impact === "high" ? 0.5 : ev.impact === "medium" ? 0.75 : 0.9;
    eventPenaltyBySymbol.set(key, Math.min(eventPenaltyBySymbol.get(key) ?? 1, penalty));
  }
  // Broad macro event within window applies a mild across-the-board penalty
  const macroPenalty = events.some((e) => !e.symbol && (e.impact === "high" || e.impact === "medium"))
    ? 0.85
    : 1;

  // Process sells first to free cash
  const sorted = [...decision.orders].sort((a) =>
    a.side === "sell" ? -1 : 1,
  );


  // Commodity-tradability validator (cache-only, no network). Runs per
  // proposed buy of a commodity ETC/ETF to confirm the symbol is Saxo-routable
  // and that we have the market data the sizing pipeline expects.
  const { makeCommodityValidator } = await import("./commodity-validation.server");
  const validateCommodity = makeCommodityValidator({
    supabaseAdmin,
    env: (process.env.SAXO_ENV as string) || "sim",
  });
  // Same shape for the crypto ETP sleeve — confirms Saxo-routability of
  // physically-backed ETPs before a buy is sized. Spot pairs (BTC-USD) are
  // fail-fast rejected by the classifier so they never leak to the broker.
  const { makeCryptoValidator } = await import("./crypto-validation.server");
  const validateCrypto = makeCryptoValidator({
    supabaseAdmin,
    env: (process.env.SAXO_ENV as string) || "sim",
  });

  for (const order of sorted) {
    const sym = order.symbol.toUpperCase();
    const meta = findSymbol(sym);
    if (!meta) {
      executed.push({
        symbol: sym,
        side: order.side,
        quantity: 0,
        price: 0,
        value: 0,
        reason: order.reason,
        rejected: "symbol not in universe",
      });
      continue;
    }
    const price = priceMap.get(meta.symbol);
    if (!price || price <= 0) {
      executed.push({
        symbol: meta.symbol,
        side: order.side,
        quantity: 0,
        price: 0,
        value: 0,
        reason: order.reason,
        rejected: "no price available",
      });
      continue;
    }
    const pct = Math.max(0, Math.min(100, order.percent)) / 100;

    if (order.side === "sell") {
      // PANIC-SELL GUARD — the fear index must never trigger liquidations.
      const panicVerdict = classifyPanicSell({
        reason: order.reason,
        fearScore: fearIndex.score,
      });
      if (panicVerdict.block) {
        executed.push({
          symbol: meta.symbol, side: "sell", quantity: 0, price, value: 0,
          reason: order.reason,
          rejected: panicVerdict.reason,
        });
        continue;
      }
      const cur = holdingsByS.get(meta.symbol);
      if (!cur || Number(cur.quantity) <= 0) {
        executed.push({
          symbol: meta.symbol,
          side: "sell",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: "no holding to sell",
        });
        continue;
      }
      // Risk dial, sell side: a defensive profile exits faster than it
      // enters. Clamped to the held quantity, so this can only accelerate an
      // exit — never short.
      let qty = aggressiveSellQty(Number(cur.quantity) * pct, Number(cur.quantity), aggression);
      // Phase 6 — discretionary AI sell: apply TOD gate/haircut and slice plan.
      const eaPreview = applyExecAlphaSell(meta.symbol, qty * price, price);
      if (!eaPreview.allow) {
        executed.push({
          symbol: meta.symbol, side: "sell", quantity: 0, price, value: 0,
          reason: order.reason, rejected: `TOD block: ${eaPreview.tod?.reason ?? "auction window"}`,
          tod: eaPreview.tod,
        });
        continue;
      }
      // Scale qty by TOD multiplier if applied (adjNotional/(qty*price)).
      if (eaPreview.tod && eaPreview.tod.multiplier < 1) {
        qty = qty * eaPreview.tod.multiplier;
      }
      const value = qty * price;
      workingCash += value;
      const remaining = Number(cur.quantity) - qty;
      if (remaining <= 1e-8) holdingsByS.delete(meta.symbol);
      else holdingsByS.set(meta.symbol, { ...cur, quantity: remaining });
      classExposure.set(
        meta.asset_class,
        Math.max(0, (classExposure.get(meta.asset_class) ?? 0) - value),
      );
      if (meta.asset_class === "commodity") {
        const grp = classifyCommoditySymbol(meta.symbol);
        if (grp) {
          commodityGroupExposure.set(
            grp,
            Math.max(0, (commodityGroupExposure.get(grp) ?? 0) - value),
          );
        }
      }
      {
        const sellCcy = inferSymbolCurrency(meta.symbol, portfolioBaseCcy).toUpperCase();
        if (sellCcy !== portfolioBaseCcy) {
          currencyExposure.set(
            sellCcy,
            Math.max(0, (currencyExposure.get(sellCcy) ?? 0) - value),
          );
        }
      }

      // Recompute slice plan against the actual executed notional so telemetry matches fills.
      const eaFinal = applyExecAlphaSell(meta.symbol, value, price);
      executed.push({
        symbol: meta.symbol,
        side: "sell",
        quantity: qty,
        price,
        value,
        reason: eaPreview.tod && eaPreview.tod.multiplier < 1
          ? `${order.reason} [tod x${eaPreview.tod.multiplier.toFixed(2)}]`
          : order.reason,
        tod: eaPreview.tod,
        slice_plan: eaFinal.slicePlan,
      });
    } else {
      // BUY
      if (halts.any_halt) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: `risk halt active: ${halts.reason}`,
        });
        continue;
      }
      const isNewPosition = !holdingsByS.has(meta.symbol);
      if (isNewPosition && newPositions >= risk.maxNewPositionsPerDay) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: "daily new-position cap reached",
        });
        continue;
      }
      // Commodity-only pre-trade validation. Confirms Saxo tradability + that
      // required market data is present before this proposal enters sizing.
      if (meta.asset_class === "commodity") {
        const cval = await validateCommodity({
          symbol: meta.symbol,
          side: "buy",
          price,
          hasFeatureRow: featureBySymbol.has(meta.symbol),
        });
        if (!cval.ok) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
            reason: order.reason, rejected: cval.reason ?? "commodity validation failed",
          });
          continue;
        }
        // Liquidity / spread threshold gates for commodity buys. These are
        // separate from the per-group NAV cap and operate on candidate
        // symbol quality rather than portfolio composition.
        const cfeat = featureBySymbol.get(meta.symbol);
        const advUsd = (cfeat?.adv_20d ?? 0) * price;
        // Sizing telemetry attached to this candidate — populated regardless of
        // whether the buy is allowed, so the UI can explain the rejection.
        const commodityLiquidity = meta.asset_class === "commodity"
          ? computeCommodityTradeLiquidity({
              requestedSpend: Math.max(0, workingCash - cashFloor) * pct,
              price,
              atrPct: cfeat?.atr_pct ?? null,
              adv20d: cfeat?.adv_20d ?? null,
              liquidityCappedSpend: null,
            })
          : undefined;
        if (cfg.commodity_min_adv_usd > 0 && advUsd > 0 && advUsd < cfg.commodity_min_adv_usd) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
            reason: order.reason,
            rejected: `commodity ${meta.symbol} blocked: 20d ADV $${Math.round(advUsd).toLocaleString()} below min $${Math.round(cfg.commodity_min_adv_usd).toLocaleString()}`,
            liquidity: commodityLiquidity,
          });
          continue;
        }

        const atrP = cfeat?.atr_pct ?? null;
        if (cfg.commodity_max_atr_pct > 0 && atrP != null && atrP > cfg.commodity_max_atr_pct) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
            reason: order.reason,
            rejected: `commodity ${meta.symbol} blocked: 14d ATR ${(atrP * 100).toFixed(2)}% exceeds max ${(cfg.commodity_max_atr_pct * 100).toFixed(2)}%`,
            liquidity: commodityLiquidity,
          });
          continue;
        }
      }

      // Crypto-only pre-trade validation. Mirror of the commodity gate: confirms
      // the proposed ETP is Saxo-routable, has a live price, and has the
      // feature row the sizer needs. Spot pairs (BTC-USD etc.) are rejected
      // here even though the live_prod broker filter also drops them, so
      // sim/backtest proposals surface the same clear reason.
      if (meta.asset_class === "crypto") {
        const kval = await validateCrypto({
          symbol: meta.symbol,
          side: "buy",
          price,
          hasFeatureRow: featureBySymbol.has(meta.symbol),
        });
        if (!kval.ok) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
            reason: order.reason, rejected: kval.reason ?? "crypto validation failed",
          });
          continue;
        }
      }

      const spendableCash = Math.max(0, workingCash - cashFloor);
      // Risk dial, buy side: position-size multiplier × buy aggressiveness.
      // Every downstream cap (per-symbol, class, vol, cash) still applies.
      let spend = aggressiveBuySpend(spendableCash * pct, aggression);
      const sizingNotes: string[] = [
        `dial ${aggression.level} (${aggression.name}) size×${aggression.sizeMult.toFixed(2)} buy×${aggression.buy.toFixed(2)}`,
      ];

      // Conviction-weighted Kelly cap (only shrinks; never grows above requested %)
      if (typeof order.conviction === "number") {
        const feat = featureBySymbol.get(meta.symbol);
        const convSpend = convictionSizedSpend({
          baseSize: spend,
          conviction: order.conviction,
          volPct: feat?.vol20d ?? null,
          kellyCap: hyperparams?.kelly_cap ?? null,
        });
        if (convSpend < spend) {
          spend = convSpend;
          sizingNotes.push(`kelly@conv=${order.conviction.toFixed(2)}${hyperparams ? ` cap=${(hyperparams.kelly_cap * 100).toFixed(0)}%` : ""}`);
        }
      }

      // K. Global calibration multiplier — shrinks buys when AI conviction has been over-stated
      if (calibration.global_size_mult !== 1) {
        spend *= calibration.global_size_mult;
        sizingNotes.push(`calib×${calibration.global_size_mult.toFixed(2)}`);
      }

      // Phase 2 — two-sided sizing bonus. Lifts spend (up to cap) when the
      // regime-blended alpha prior and AI conviction both strongly agree with
      // the trade side. Never shrinks below the current spend.
      if (order.side === "buy" && cfg.alpha_bonus_enabled) {
        const alphaComp = alphaCompositeBySymbol.get(meta.symbol) ?? 0;
        const bonus = alphaConvictionBonus({
          side: "buy",
          alphaComposite: alphaComp,
          conviction: order.conviction,
          cap: cfg.alpha_bonus_cap,
          enabled: true,
        });
        if (bonus.mult > 1) {
          spend *= bonus.mult;
          if (bonus.note) sizingNotes.push(bonus.note);
        }
      }

      // J. Ensemble second opinion — halve on strong disagreement, log to journal
      {
        const feat = featureBySymbol.get(meta.symbol);
        if (feat) {
          const vote = ensembleVote({
            symbol: feat.symbol, price: feat.price,
            sma20: feat.sma20, sma50: feat.sma50, rsi14: feat.rsi14,
            change5d: feat.change5d, change30d: feat.change30d,
          });
          if (scoreDisagreement(order.side, vote)) {
            spend *= 0.5;
            sizingNotes.push(`ensemble≠AI (${vote.side} ${vote.score.toFixed(2)}) x0.5`);
          }
        }
      }

      // Loss cooldown: halve size while cooling
      if (isSymbolCooling(cooldowns, meta.symbol, asOf)) {
        spend *= 0.5;
        sizingNotes.push("cooldown x0.5");
      }

      // Cross-sectional ranking guardrail: outside top quartile => halve size,
      // outside universe entirely (should not happen) => leave alone.
      const rankInfo = rankMap.get(meta.symbol) ?? null;
      if (rankInfo && !rankInfo.top_quartile) {
        spend *= 0.5;
        sizingNotes.push(`rank #${rankInfo.rank}/${rankInfo.universe_size} x0.5`);
      }

      // FEAR INDEX overlay — panic blocks fresh buys outright, elevated fear
      // shrinks them, complacency trims risk-taking slightly.
      if (fearIndex.blockNewBuys) {
        executed.push({
          symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
          reason: order.reason,
          rejected: `fear index ${fearIndex.score.toFixed(0)}/100 (panic) — new buys blocked`,
        });
        continue;
      }
      if (fearIndex.sizeMultiplier !== 1) {
        spend *= fearIndex.sizeMultiplier;
        sizingNotes.push(`fear${fearIndex.score.toFixed(0)}×${fearIndex.sizeMultiplier.toFixed(2)}`);
      }


      // Portfolio-level 5-day drawdown → shrink new buys
      if (ddSizing.size_multiplier < 1) {
        spend *= ddSizing.size_multiplier;
        sizingNotes.push(`dd×${ddSizing.size_multiplier.toFixed(2)}`);
      }

      // Sector rotation size multiplier
      const secMult = sectorSizeMultiplier(symbolSector(meta.symbol), sectorScores);
      if (secMult.mult !== 1) {
        spend *= secMult.mult;
        sizingNotes.push(secMult.note);
      }

      // Overnight-gap guard: skip fresh buys when 1d move is > 2σ
      const gap = await checkOvernightGap(meta.symbol, asOf).catch(() => null);
      if (gap?.triggered) {
        executed.push({
          symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
          reason: order.reason, rejected: gap.note,
        });
        continue;
      }

      // Gross-exposure cap by regime (crisis/bear/correction)
      const currentHoldingsValue = Array.from(holdingsByS.values()).reduce((s, h) => {
        const p = holdingLivePrice(priceMap, h);
        return s + p * Number(h.quantity);
      }, 0);
      const gross = grossExposureLimit(totalValue, currentHoldingsValue, effectiveRegime);
      if (gross.target_pct < 1) {
        if (gross.room <= 0) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price, value: 0,
            reason: order.reason, rejected: gross.note,
          });
          continue;
        }
        if (spend > gross.room) {
          spend = gross.room;
          sizingNotes.push(`gross≤${(gross.target_pct * 100).toFixed(0)}%`);
        }
      }

      // Event penalty (symbol-specific and broad macro)
      const evPenalty = (eventPenaltyBySymbol.get(meta.symbol) ?? 1) * macroPenalty;
      if (evPenalty < 1) {
        spend *= evPenalty;
        sizingNotes.push(`event x${evPenalty.toFixed(2)}`);

      }

      // Enforce per-symbol position cap
      const existingVal = holdingsByS.get(meta.symbol)
        ? Number(holdingsByS.get(meta.symbol)!.quantity) * price
        : 0;
      const roomInPosition = Math.max(0, maxPosVal - existingVal);
      spend = Math.min(spend, roomInPosition);

      // Enforce asset class exposure cap
      const classCap = cfg.asset_class_limits[meta.asset_class];
      let classRejected = false;
      if (classCap != null) {
        const classMax = totalValue * classCap;
        const roomInClass = Math.max(0, classMax - (classExposure.get(meta.asset_class) ?? 0));
        if (roomInClass <= 0) classRejected = true;
        spend = Math.min(spend, roomInClass);
      }

      // Enforce per-commodity-group cap (e.g. max Gold %, max Basket %).
      // Layers on top of the overall commodity asset-class cap.
      let commodityGroupRejected: string | null = null;
      let commodityGroupKey: string | null = null;
      if (meta.asset_class === "commodity") {
        const grp = classifyCommoditySymbol(meta.symbol);
        if (grp) {
          commodityGroupKey = grp;
          const grpCap = cfg.commodity_group_limits?.[grp];
          if (grpCap != null) {
            const grpMax = totalValue * grpCap;
            const roomInGroup = Math.max(0, grpMax - (commodityGroupExposure.get(grp) ?? 0));
            if (roomInGroup <= 0) commodityGroupRejected = `commodity-group cap reached for ${grp} (max ${(grpCap * 100).toFixed(0)}%)`;
            spend = Math.min(spend, roomInGroup);
          }
        }
      }

      // Enforce per-currency FX exposure cap for non-base holdings. Cap-only
      // — never inflates spend and never permits borrowing. Applies whether
      // the symbol's asset class is stock/etf/crypto/commodity/fx.
      const buyCcy = inferSymbolCurrency(meta.symbol, portfolioBaseCcy).toUpperCase();
      let fxCurrencyRejected: string | null = null;
      if (buyCcy !== portfolioBaseCcy) {
        const ccyCap = cfg.fx_currency_limits?.[buyCcy];
        if (ccyCap != null) {
          const ccyMax = totalValue * ccyCap;
          const roomInCcy = Math.max(0, ccyMax - (currencyExposure.get(buyCcy) ?? 0));
          if (roomInCcy <= 0) {
            fxCurrencyRejected = `fx-currency cap reached for ${buyCcy} (max ${(ccyCap * 100).toFixed(0)}% of NAV)`;
          }
          spend = Math.min(spend, roomInCcy);
        }
      }



      // Volatility-based sizing: cap spend so position * vol ≈ vol_target * totalValue.
      // Phase 5 — when risk_parity_enabled, scale the vol budget by |alpha|
      // so higher-conviction systematic setups earn a bigger share of the
      // vol budget (still bounded by risk_parity_nav_cap).
      let volCapped = false;
      if (cfg.volatility_sizing) {
        const vol = featureBySymbol.get(meta.symbol)?.vol20d ?? null;
        if (vol && vol > 0) {
          let targetPositionVal = (cfg.vol_target_pct * totalValue) / vol;
          if (cfg.risk_parity_enabled) {
            const alphaMag = Math.abs(alphaCompositeBySymbol.get(meta.symbol) ?? 0);
            const rp = riskParityTargetSpend({
              alphaMag, vol, totalValue,
              targetVolPct: cfg.vol_target_pct,
              navCap: cfg.risk_parity_nav_cap,
            });
            if (rp > 0) targetPositionVal = rp;
          }
          const volRoom = Math.max(0, targetPositionVal - existingVal);
          if (spend > volRoom) {
            spend = volRoom;
            volCapped = true;
            if (cfg.risk_parity_enabled) sizingNotes.push(`risk-parity α=${(alphaCompositeBySymbol.get(meta.symbol) ?? 0).toFixed(2)}`);
          }
        }
      }

      // Portfolio-level correlated cluster cap
      let corrCapped = false;
      const existingExposureBySymbol = new Map<string, number>();
      for (const h of holdingsByS.values()) {
        const p = holdingLivePrice(priceMap, h);
        existingExposureBySymbol.set(engineSymbolKey(h.symbol), p * Number(h.quantity));
      }
      const corrRes = correlatedClusterAllowance({
        symbol: meta.symbol,
        spend,
        totalValue,
        existingExposureBySymbol,
        corr: corrMap,
      });
      if (corrRes.allowed < spend) {
        spend = corrRes.allowed;
        corrCapped = true;
        sizingNotes.push(`corr-cluster ${(corrRes.clusterExposurePct * 100).toFixed(0)}%`);
      }

      if (spend < 1) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: fxCurrencyRejected
            ? fxCurrencyRejected
            : commodityGroupRejected
              ? commodityGroupRejected
              : classRejected
                ? `asset-class cap reached for ${meta.asset_class}`
                : corrCapped
                  ? `correlated-cluster cap reached (${corrRes.cluster.slice(0, 3).join(",")})`
                  : volCapped
                    ? "volatility sizing leaves no room"
                    : "guardrails leave no room to buy",

        });
        continue;
      }

      // Phase 6 — time-of-day filter (haircut or hard-block during auction windows).
      const venue = inferVenueFromSymbol(meta.symbol);
      let todInfo: { multiplier: number; allow: boolean; reason: string } | undefined;
      if (cfg.tod_filter_enabled) {
        const venueCfg = resolveVenueTodConfig(
          {
            avoidOpenMin: cfg.tod_avoid_open_min,
            avoidCloseMin: cfg.tod_avoid_close_min,
            openHaircut: cfg.tod_open_haircut,
            closeHaircut: cfg.tod_close_haircut,
            hardBlockOpenMin: cfg.tod_hard_block_open_min,
            hardBlockCloseMin: cfg.tod_hard_block_close_min,
          },
          venue,
          cfg.tod_venue_overrides,
        );
        todInfo = todExecutionAdjustment({ venue, ...venueCfg });

        if (!todInfo.allow) {
          executed.push({
            symbol: meta.symbol,
            side: "buy",
            quantity: 0,
            price,
            value: 0,
            reason: order.reason,
            rejected: `TOD block: ${todInfo.reason}`,
            tod: todInfo,
          });
          continue;
        }
        if (todInfo.multiplier < 1) {
          spend = spend * todInfo.multiplier;
          sizingNotes.push(`tod x${todInfo.multiplier.toFixed(2)}`);
        }
      }

      // Phase 5 — realistic execution (spread, slippage, commission, liquidity cap).
      // We now factor in Saxo's real published fee schedule: per-venue rate
      // (~8bps for UK/US/EU stocks, ~10bps CHF) with a per-side MINIMUM
      // (£3 UK, $1 US, €3 EU, etc.). Small orders that would be dominated
      // by the fixed floor are rejected outright so profit margins are not
      // silently eaten by fees.
      const featExec = featureBySymbol.get(meta.symbol);
      const tradeCcy = inferSaxoCurrency(meta.symbol);
      let saxoFee = estimateSaxoCommission({
        notional: spend,
        currency: tradeCcy,
        symbol: meta.symbol,
        assetClass: meta.asset_class,
      });
      const MAX_ROUND_TRIP_FEE_BPS = 150; // ≥1.5% round-trip cost blocks the trade.
      if (saxoFee.roundTripBps > MAX_ROUND_TRIP_FEE_BPS) {
        // Auto-rescue: the fee guard is dominated by the per-side minimum on
        // small orders. If we have enough headroom, upsize `spend` to the
        // smallest notional that clears the guard (capped at 2× the AI's
        // original size to respect the model's conviction and at remaining
        // cash / sizing budget).
        const minNotional = (2 * saxoFee.tier.min * 10_000) / MAX_ROUND_TRIP_FEE_BPS;
        const headroom = Math.min(spend * 2, Math.max(0, workingCash - cashFloor));
        if (Number.isFinite(minNotional) && minNotional > spend && minNotional <= headroom) {
          const bumped = Math.ceil(minNotional);
          sizingNotes.push(`fee-rescue ${spend.toFixed(0)}→${bumped}`);
          spend = bumped;
          saxoFee = estimateSaxoCommission({
            notional: spend,
            currency: tradeCcy,
            symbol: meta.symbol,
            assetClass: meta.asset_class,
          });
        }
      }
      if (saxoFee.roundTripBps > MAX_ROUND_TRIP_FEE_BPS) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected:
            `fee guard: Saxo ${saxoFee.tier.venue} min ${saxoFee.tier.currency} ${saxoFee.tier.min}`
            + ` on notional ${spend.toFixed(0)} = ${saxoFee.roundTripBps.toFixed(0)}bps round-trip`
            + ` (limit ${MAX_ROUND_TRIP_FEE_BPS}bps). Order too small to cover Saxo commission.`,
        });
        continue;
      }

      const symTuning = symbolTuning.get(meta.symbol.toUpperCase());
      const feeAdjustedParams = {
        ...(cfg.execution_params ?? {}),
        min_commission: Math.max(
          Number(cfg.execution_params?.min_commission ?? 0),
          saxoFee.tier.min,
        ),
        // Per-symbol microstructure overrides win over user config to reflect
        // the actual liquidity/volatility we measured for this name.
        microstructure: {
          ...(cfg.execution_params?.microstructure ?? {}),
          ...(symTuning ?? {}),
        },
      };

      const outcome = applyBuyExecution({
        requestedSpend: spend,
        price,
        atrPct: featExec?.atr_pct ?? null,
        adv20d: featExec?.adv_20d ?? null,
        params: feeAdjustedParams,
        assetClass: meta.asset_class,
        currency: tradeCcy,
        urgency: "normal",
      });
      const commodityLiq = meta.asset_class === "commodity"
        ? computeCommodityTradeLiquidity({
            requestedSpend: spend,
            price,
            atrPct: featExec?.atr_pct ?? null,
            adv20d: featExec?.adv_20d ?? null,
            liquidityCappedSpend: outcome.liquidityCappedSpend,
          })
        : undefined;
      if (outcome.belowMinTrade || outcome.qty <= 0) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: outcome.notes.join("; ") || "trade too small after execution costs",
          liquidity: commodityLiq,
        });
        continue;
      }
      if (outcome.liquidityCappedSpend != null) sizingNotes.push("liquidity 1% ADV");
      sizingNotes.push(
        `saxo fee ${saxoFee.tier.currency}${saxoFee.commission.toFixed(2)}`
        + ` (${saxoFee.perSideBps.toFixed(0)}bps${saxoFee.minFloorApplied ? " floor" : ""})`,
      );
      const qty = outcome.qty;
      const fillPrice = outcome.fillPrice;

      // Crypto post-sizing pre-trade gate: fee %, whole-unit lot size,
      // venue minimum notional, and venue trading hours. Runs only for
      // crypto BUYs; SELLs are always allowed through so a position can exit.
      if (meta.asset_class === "crypto") {
        const { runCryptoPreTradeChecks } = await import("./crypto-validation.server");
        const pre = runCryptoPreTradeChecks({
          symbol: meta.symbol,
          side: "buy",
          price: fillPrice,
          quantity: qty,
        });
        if (!pre.ok) {
          executed.push({
            symbol: meta.symbol, side: "buy", quantity: 0, price: fillPrice, value: 0,
            reason: order.reason, rejected: pre.reason ?? "crypto pre-trade check failed",
          });
          continue;
        }
      }
      workingCash -= outcome.effectiveSpend;
      if (isNewPosition) newPositions += 1;
      const cur = holdingsByS.get(meta.symbol);
      if (cur) {
        const newQty = Number(cur.quantity) + qty;
        const newCost =
          (Number(cur.avg_cost) * Number(cur.quantity) + qty * fillPrice) / newQty;
        const curHwm = Number((cur as unknown as { high_water_mark?: number | null }).high_water_mark ?? Number(cur.avg_cost));
        holdingsByS.set(meta.symbol, {
          ...cur,
          quantity: newQty,
          avg_cost: newCost,
          high_water_mark: Math.max(curHwm, fillPrice),
        } as Holding);
      } else {
        holdingsByS.set(meta.symbol, {
          id: crypto.randomUUID(),
          portfolio_id: portfolioId,
          symbol: meta.symbol,
          asset_class: meta.asset_class,
          quantity: qty,
          avg_cost: fillPrice,
          updated_at: new Date().toISOString(),
          opened_at: new Date().toISOString(),
          high_water_mark: fillPrice,
        } as Holding);
      }
      classExposure.set(
        meta.asset_class,
        (classExposure.get(meta.asset_class) ?? 0) + outcome.effectiveSpend,
      );
      if (commodityGroupKey) {
        commodityGroupExposure.set(
          commodityGroupKey,
          (commodityGroupExposure.get(commodityGroupKey) ?? 0) + outcome.effectiveSpend,
        );
      }
      if (buyCcy !== portfolioBaseCcy) {
        currencyExposure.set(
          buyCcy,
          (currencyExposure.get(buyCcy) ?? 0) + outcome.effectiveSpend,
        );
      }

      // Phase 6 — slice plan telemetry (attached to executed row).
      const slicePlan = cfg.execution_slicing_enabled
        ? planOrderSlices({
            parentNotional: outcome.effectiveSpend,
            price: fillPrice,
            adv20d: featExec?.adv_20d ?? null,
            participationCap: cfg.execution_participation_cap,
            maxChildNotional: cfg.execution_max_child_notional,
          })
        : undefined;
      if (slicePlan && slicePlan.childCount > 1) {
        sizingNotes.push(`sliced ${slicePlan.childCount}×`);
      }
      // Track sell reductions for group exposure too (mirrors classExposure sell path).
      executed.push({
        symbol: meta.symbol,
        side: "buy",
        quantity: qty,
        price: fillPrice,
        value: outcome.effectiveSpend,
        reason: sizingNotes.length ? `${order.reason} [${sizingNotes.join(", ")}]` : order.reason,
        liquidity: commodityLiq,
        slice_plan: slicePlan
          ? {
              childCount: slicePlan.childCount,
              childNotional: slicePlan.childNotional,
              advParticipationPct: slicePlan.advParticipationPct,
              reason: slicePlan.reason,
            }
          : undefined,
        tod: todInfo,
      });

    }
  }

  // ---- Rebalance-band trims: harvest overweight winners after buy pass ----
  const trims = computeRebalanceTrims({
    totalValue,
    holdings: Array.from(holdingsByS.entries()).map(([key, h]) => ({ symbol: key, quantity: Number(h.quantity) })),
    priceMap,
    targetPerSymbolPct: basePerSymbolPct,
    bandPct: 0.25,
  });
  for (const t of trims) {
    const cur = holdingsByS.get(t.symbol);
    if (!cur) continue;
    let qty = Math.min(Number(cur.quantity), t.qtyToTrim);
    if (qty <= 0) continue;
    // Phase 6 — discretionary trim: gate on TOD and record slice plan.
    const eaPreview = applyExecAlphaSell(t.symbol, qty * t.price, t.price);
    if (!eaPreview.allow) {
      executed.push({
        symbol: t.symbol, side: "sell", quantity: 0, price: t.price, value: 0,
        reason: `rebalance-band trim skipped: ${eaPreview.tod?.reason ?? "auction window"}`,
        rejected: `TOD block: ${eaPreview.tod?.reason ?? "auction window"}`,
        tod: eaPreview.tod,
      });
      continue;
    }
    if (eaPreview.tod && eaPreview.tod.multiplier < 1) qty = qty * eaPreview.tod.multiplier;
    const value = qty * t.price;
    workingCash += value;
    const remaining = Number(cur.quantity) - qty;
    if (remaining <= 1e-8) holdingsByS.delete(t.symbol);
    else holdingsByS.set(t.symbol, { ...cur, quantity: remaining });
    const eaFinal = applyExecAlphaSell(t.symbol, value, t.price);
    executed.push({
      symbol: t.symbol,
      side: "sell",
      quantity: qty,
      price: t.price,
      value,
      reason: `rebalance-band trim: ${(t.currentPct * 100).toFixed(1)}% → target ${(t.targetPct * 100).toFixed(1)}%`,
      tod: eaPreview.tod,
      slice_plan: eaFinal.slicePlan,
    });
  }


  // G. Log counterfactuals for rejected buys — later scored against 5d forward return.
  {
    const orderMeta = new Map(decision.orders.map((o) => [o.symbol, o] as const));
    for (const t of executed) {
      if (t.side !== "buy" || t.quantity > 0 || !t.rejected) continue;
      const om = orderMeta.get(t.symbol);
      logCounterfactual({
        portfolioId,
        asOf,
        symbol: t.symbol,
        side: "buy",
        hypotheticalPrice: t.price || (priceMap.get(t.symbol) ?? 0),
        blockReason: t.rejected,
        conviction: typeof om?.conviction === "number" ? om.conviction : null,
      }).catch(() => { /* ignore */ });
    }
  }

  // ---- Broker-simulator invariant guard ---------------------------------
  // Replays the final executed order list through a pure ledger with
  // strict no-borrow / no-leverage rules. Risk level tunes strictness
  // (see broker-simulator-integration.ts). Diagnostics-only: the guard
  // NEVER mutates persisted state — a mismatch is logged into the
  // decision guardrails for later inspection.
  let brokerSimGuard: ReturnType<typeof runBrokerSimulatorGuard> | null = null;
  try {
    brokerSimGuard = runBrokerSimulatorGuard({
      riskLevel: portfolio.risk_level,
      startingCash: cash,
      startingHoldings: (holdings ?? []).map((h) => ({
        symbol: h.symbol,
        quantity: Number(h.quantity),
        avgCost: Number(h.avg_cost),
      })),
      executed,
      priceMap: Object.fromEntries(priceMap.entries()),
    });
    if (!brokerSimGuard.ledgerMatchesEngine) {
      console.warn(
        "broker-simulator guard flagged divergence",
        {
          portfolioId,
          asOf,
          riskLevel: portfolio.risk_level,
          rejected: brokerSimGuard.rejectedTradeIds.length,
          drift: brokerSimGuard.drift.length,
        },
      );
    }
  } catch (e) {
    console.warn("broker-simulator guard skipped:", e);
  }

  // Persist state


  // ---- AI-proposed FX conversions (book-entry on cash_by_ccy) --------------
  // Applied after buys/sells so wallet math sees the latest cash. Rejected
  // rows (bad rate, circuit open, insufficient balance) are logged into the
  // decision guardrails for later inspection. Never mutates workingCash for
  // non-base currencies — those live in cash_by_ccy only.
  //
  // fx_intents (typed, guardrailed) are compiled first into equivalent
  // FxConversionOrder rows and prepended, so intent-driven proposals get
  // executed before any legacy fx_conversions the model still emits.
  let aiFxApplied: Awaited<ReturnType<typeof applyAiFxConversions>> | null = null;
  const legacyFx = decision.fx_conversions ?? [];
  const rawIntents = decision.fx_intents ?? [];
  let compiledIntents: ReturnType<typeof import("./fx-intents").compileFxIntents> = [];
  if (fxContext && rawIntents.length > 0) {
    const { compileFxIntents, DEFAULT_GUARDRAILS } = await import("./fx-intents");
    const ratesToBase: Record<string, number> = {};
    for (const [pair, q] of fxContext.matrix) {
      const [from, to] = pair.split("/");
      if (to === fxContext.baseCcy) ratesToBase[from] = q.rate;
    }
    ratesToBase[fxContext.baseCcy] = 1;
    compiledIntents = compileFxIntents(rawIntents, {
      baseCcy: fxContext.baseCcy,
      wallet: fxContext.wallet as unknown as Record<string, number>,
      exposureBase: fxContext.exposureByCcy,
      ratesToBase,
      guardrails: { ...DEFAULT_GUARDRAILS, navBase: totalValue },
    });
  }
  const intentOrders = compiledIntents.flatMap((c) => (c.order ? [c.order] : []));
  const aiFxRequested = [...intentOrders, ...legacyFx];
  if (fxContext && aiFxRequested.length > 0) {
    try {
      aiFxApplied = await applyAiFxConversions({
        portfolioId,
        userId: portfolio.user_id,
        baseCcy: fxContext.baseCcy,
        // Start from wallet as it stands at the time of the AI decision.
        // We don't mutate base cash intra-tick for foreign buys (executor
        // handles those separately), so this is the right snapshot.
        wallet: fxContext.wallet,
        conversions: aiFxRequested,
        fxContext,
        buyHalts: halts.any_halt,
        persist: !breakerTripped,
      });
      // Reflect base-ccy delta into workingCash so the persisted current_cash
      // and equity snapshot stay consistent with the wallet update above.
      workingCash += aiFxApplied.baseCashDelta;
    } catch (e) {
      console.warn("ai-fx apply failed", e);
    }
  }

  const admin = supabaseAdmin;
  const executedAt = new Date().toISOString();

  // For live_sim / live_prod portfolios the engine's `executed` list is
  // OPTIMISTIC — it reflects what the AI wants to do, not what the broker
  // actually accepted. Writing those rows into `trades` / `holdings` here
  // silently creates a ghost ledger that diverges from Saxo. For live modes
  // we skip these writes and rely on:
  //   - live-executor  → live_fills (real broker fills)
  //   - live-holdings-sync (called right after this returns) → holdings
  //   - reconcileFillsToTrades (operator button) → trades from live_fills
  const isLivePortfolio =
    portfolio.mode === "live_sim" || portfolio.mode === "live_prod";

  // Phase 6 — Tail hedge executor. Compute the target hedge notional from the
  // current in-memory NAV, then materialise the buy/sell into `executed` +
  // `holdingsByS` so the paper writer below persists it alongside every other
  // fill. Live portfolios are noted only; hedge routing there defers to the
  // broker executor.
  let tailHedgeDecision: import("./hedging/tail-hedge").TailHedgeDecision | null = null;
  let tailHedgeExecution: {
    applied: boolean; reason: string; symbol: string | null; qty: number; notional: number;
  } | null = null;
  let tailHedgeReconciliation:
    | import("./hedging/tail-hedge-reconcile").TailHedgeReconciliation
    | null = null;
  try {
    const { computeTailHedge } = await import("./hedging/tail-hedge");
    const { applyTailHedgeToPaperPortfolio } = await import("./hedging/tail-hedge-executor.server");
    const preHedgeHoldingsValue = Array.from(holdingsByS.values()).reduce((s, h) => {
      const p = holdingLivePrice(priceMap, h);
      return s + p * Number(h.quantity);
    }, 0);
    const preHedgeNav = workingCash + preHedgeHoldingsValue;
    const prev = await admin
      .from("decisions")
      .select("raw")
      .eq("portfolio_id", portfolioId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevNotional = Number(
      (prev.data?.raw as { tail_hedge?: { targetNotional?: number } } | null)
        ?.tail_hedge?.targetNotional ?? 0,
    );
    tailHedgeDecision = computeTailHedge({
      nav: preHedgeNav,
      cape: null,
      regime: effectiveRegime.regime,
      currentHedgeNotional: Number.isFinite(prevNotional) && prevNotional > 0 ? prevNotional : 0,
    });
    const exec = applyTailHedgeToPaperPortfolio({
      decision: tailHedgeDecision,
      holdingsByS,
      workingCash,
      priceMap,
      portfolioId,
      portfolioCurrency: portfolio.currency ?? "GBP",
      isLivePortfolio,
      blockedSymbols: brokerBlockedSymbols,
    });

    workingCash = exec.workingCash;
    if (exec.trade) executed.push(exec.trade);
    if (exec.fallback) {
      const { recordHedgeFallbackEvent } = await import("./hedging/hedge-fallback-audit.server");
      recordHedgeFallbackEvent({
        userId: portfolio.user_id,
        portfolioId,
        currency: portfolio.currency ?? "GBP",
        applied: exec.applied,
        appliedNotional: exec.notional,
        audit: exec.fallback,
      });
    }
    tailHedgeExecution = {
      applied: exec.applied, reason: exec.reason, symbol: exec.symbol,
      qty: exec.qty, notional: exec.notional,
    };

    try {
      const { reconcileTailHedge } = await import("./hedging/tail-hedge-reconcile");
      const hedgeSym = exec.symbol;
      // Observed holding of hedge symbol AFTER paper mutation (for live it's
      // the pre-broker mirror; drift vs advised.targetNotional will resolve
      // on the next broker sync).
      // Match tolerantly: the hedge can be mirrored from the broker under a
      // native spelling ("SGLN:xlon") while hedgeSym is the universe key.
      const observedQty = hedgeSym
        ? Number(
            (holdingsByS.get(hedgeSym) ?? holdingsByS.get(engineSymbolKey(hedgeSym)))?.quantity ?? 0,
          )
        : 0;
      const observedPrice = hedgeSym ? holdingPriceBySymbol(priceMap, hedgeSym) : null;
      tailHedgeReconciliation = reconcileTailHedge({
        decision: tailHedgeDecision,
        applied: {
          applied: exec.applied, reason: exec.reason, symbol: exec.symbol,
          qty: exec.qty, notional: exec.notional,
        },
        observedHedgeQty: observedQty,
        observedHedgePrice: observedPrice,
        isLivePortfolio,
        priorTargetNotional: Number.isFinite(prevNotional) && prevNotional > 0 ? prevNotional : 0,
      });
    } catch (e) {
      console.warn("tail hedge reconcile skipped:", e);
    }
  } catch (e) {
    console.warn("tail hedge apply skipped:", e);
  }


  if (!isLivePortfolio) {
    // Insert trades (only executed ones with quantity > 0)
    const tradesRows = executed
      .filter((t) => t.quantity > 0)
      .map((t) => ({
        portfolio_id: portfolioId,
        symbol: t.symbol,
        asset_class: findSymbol(t.symbol)!.asset_class,
        side: t.side,
        quantity: t.quantity,
        price: t.price,
        value: t.value,
        executed_at: executedAt,
        trade_date: asOf,
        reason: t.reason + (t.rejected ? ` [REJECTED: ${t.rejected}]` : ""),
        instrument_ccy: instrumentCcyFor(t.symbol, t.instrument_ccy ?? null, inferSaxoCurrency(t.symbol)),
      }));
    if (tradesRows.length > 0) await admin.from("trades").insert(tradesRows);

    // Replace holdings: delete then insert (simpler & atomic-enough for paper account)
    await admin.from("holdings").delete().eq("portfolio_id", portfolioId);
    const holdingsRows = Array.from(holdingsByS.values())
      .filter((h) => Number(h.quantity) > 1e-8)
      .map((h) => {
        const hExt = h as unknown as {
          opened_at?: string | null;
          high_water_mark?: number | null;
        };
        return {
          portfolio_id: portfolioId,
          symbol: h.symbol,
          asset_class: h.asset_class,
          quantity: Number(h.quantity),
          avg_cost: Number(h.avg_cost),
          opened_at: hExt.opened_at ?? new Date().toISOString(),
          high_water_mark: hExt.high_water_mark ?? Number(h.avg_cost),
          instrument_ccy: instrumentCcyFor(
            h.symbol,
            (h as unknown as { instrument_ccy?: string | null }).instrument_ccy ?? null,
            inferSaxoCurrency(h.symbol),
          ),
        };
      });
    if (holdingsRows.length > 0) await admin.from("holdings").insert(holdingsRows);
  }


  // Recompute portfolio value with latest holdings through the single
  // valuation kernel: unit-normalised prices in, FX applied, provenance out.
  const tickValuation = await valuePortfolioHoldings({
    holdings: Array.from(holdingsByS.values()).map((h) => ({
      symbol: h.symbol,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
      asset_class: h.asset_class ?? null,
      instrument_ccy:
        (h as unknown as { instrument_ccy?: string | null }).instrument_ccy ?? null,
    })),
    normalizedPrices: priceMap,
    wallet: { [(portfolio.currency || "GBP").toUpperCase()]: workingCash },
    baseCcy: portfolio.currency || "GBP",
  });
  const newHoldingsValue = tickValuation.holdingsValue;
  const newTotal = tickValuation.totalValue;

  // Phase 6 decision + execution telemetry now happens earlier (before the
  // paper-portfolio trades/holdings writer) so hedge fills land in the same
  // batch as every other trade. The decision + execution outcome are
  // persisted in decisions.raw below.



  await admin
    .from("portfolios")
    .update({ current_cash: workingCash, last_run_date: asOf })
    .eq("id", portfolioId);

  await persistCircuit(portfolioId, circuit).catch((e) =>
    console.warn("Circuit persist skipped:", e),
  );


  await writeEquitySnapshot(admin as never, {
    portfolioId,
    snapshotDate: asOf,
    cash: tickValuation.cash,
    holdingsValue: newHoldingsValue,
    totalValue: newTotal,
    currency: portfolio.currency || "GBP",
    source: "trading_engine",
    provenance: tickValuation.provenance,
    brokerLinked: Boolean(
      (portfolio as unknown as { broker_account_id?: string | null }).broker_account_id,
    ),
    positionCount: (holdings ?? []).length,
  });


  await recordIntradayEquity(admin as never, portfolioId, {
    cash: workingCash,
    holdingsValue: newHoldingsValue,
    totalValue: newTotal,
  });

  // Per-currency wallet snapshot for the wallet-history chart.
  try {
    const { readWallet, walletBalance } = await import("@/lib/portfolio-wallet");
    const { getFxMatrix } = await import("@/lib/fx.server");
    const { data: pRow } = await admin
      .from("portfolios")
      .select("currency, current_cash, cash_by_ccy")
      .eq("id", portfolioId)
      .single();
    if (pRow) {
      const baseCcy = (pRow.currency || "GBP").toUpperCase();
      const wallet = readWallet({
        currency: pRow.currency,
        current_cash: Number(pRow.current_cash ?? workingCash),
        cash_by_ccy: (pRow.cash_by_ccy as Record<string, number> | null) ?? null,
      });
      const foreign = Object.keys(wallet).filter((c) => c !== baseCcy);
      const fx = foreign.length
        ? await getFxMatrix(foreign.map((c) => ({ from: c, to: baseCcy })))
        : new Map();
      let baseTotal = walletBalance(wallet, baseCcy);
      for (const c of foreign) {
        const r = fx.get(`${c}${baseCcy}`);
        baseTotal += walletBalance(wallet, c) * (r?.rate ?? 1);
      }
      await admin.from("wallet_snapshots").upsert(
        {
          portfolio_id: portfolioId,
          snapshot_date: asOf,
          cash_by_ccy: wallet as unknown as Record<string, number>,
          base_ccy: baseCcy,
          base_total: baseTotal,
        },
        { onConflict: "portfolio_id,snapshot_date" },
      );
    }
  } catch (e) {
    console.warn("wallet_snapshots upsert skipped:", e);
  }

  // Plain-language explanation of this run (what was bought/sold, or why cash
  // was held). Stored inside `raw` so the decision UI can render it without an
  // extra fetch. Deterministic fallback inside the helper keeps the run
  // succeeding even when the AI gateway is unavailable.
  const { generateRunExplanation } = await import("./run-explanation.server");
  const runExplanation = await generateRunExplanation({
    portfolioName: (portfolio as { name?: string | null }).name ?? null,
    currency: portfolio.currency || "GBP",
    totalValue: newTotal,
    workingCash,
    cashFloor,
    proposedOrders: (decision.orders ?? []).map((o) => ({
      symbol: o.symbol, side: o.side,
    })),
    executed: executed.map((e) => ({
      symbol: e.symbol, side: e.side, quantity: e.quantity,
      value: (e as { value?: number }).value,
      rejected: (e as { rejected?: string | null }).rejected ?? null,
      reason: (e as { reason?: string | null }).reason ?? null,
    })),
    halts: halts?.any_halt
      ? [{ code: halts.daily_loss_halt ? "daily_loss" : "drawdown", reason: halts.reason ?? undefined }]
      : [],
    droppedForCash: droppedForCash.map((d) => `${d.symbol} (${d.reason})`),
    brokerBlocked: brokerBlockedSymbols,
    budgetNotes,
  });

  const decisionInsert = await admin.from("decisions").insert({
    portfolio_id: portfolioId,
    run_date: asOf,
    briefing: decision.briefing,
    rationale: decision.rationale,
    model: "google/gemini-2.5-flash",
    portfolio_value: newTotal,
    raw: asJson({
      orders: decision.orders,
      executed,
      signals: features,
      news: scoredNews.slice(0, 12),
      guardrails: {
        risk_level: portfolio.risk_level,
        max_position_pct: basePerSymbolPct,
        cash_floor_pct: cashFloorPctEff,
        max_new_positions_per_day: risk.maxNewPositionsPerDay,
        cash_floor_value: cashFloor,
        max_position_value: maxPosVal,
        starting_total_value: totalValue,
        starting_cash: cash,
        asset_class_limits: cfg.asset_class_limits,
        per_symbol_limit_pct: cfg.per_symbol_limit_pct,
        stop_loss_pct: cfg.stop_loss_pct,
        take_profit_pct: cfg.take_profit_pct,
        atr_trailing_mult: cfg.atr_trailing_mult,
        max_hold_days: cfg.max_hold_days,
        volatility_sizing: cfg.volatility_sizing,
        vol_target_pct: cfg.vol_target_pct,
        max_daily_loss_pct: cfg.max_daily_loss_pct,
        max_drawdown_halt_pct: cfg.max_drawdown_halt_pct,
        halts,
        affordability: {
          per_symbol_budget: perSymbolBudget,
          min_trade_value: minTradeValue,
          universe_total: fullUniverse.length,
          candidates_kept: candidateSymbols.length,
          dropped_for_cash: droppedForCash,
          broker_blocked: brokerBlockedSymbols,
          notes: budgetNotes,
        },
        broker_simulator: brokerSimGuard
          ? {
              risk_level: portfolio.risk_level,
              options: brokerSimGuard.options,
              ledger_matches_engine: brokerSimGuard.ledgerMatchesEngine,
              rejected_trade_ids: brokerSimGuard.rejectedTradeIds,
              drift: brokerSimGuard.drift,
              final_cash: brokerSimGuard.simulation.finalState.cash,
              final_holdings: brokerSimGuard.simulation.finalState.holdings,
            }
          : { skipped: true },
        ai_fx: fxContext
          ? {
              active: fxContext.active,
              circuit_open: fxContext.circuitOpen,
              circuit_reason: fxContext.circuitReason,
              base_ccy: fxContext.baseCcy,
              exposure_by_ccy: fxContext.exposureByCcy,
              requested: aiFxRequested,
              applied: aiFxApplied?.applied ?? [],
              base_cash_delta: aiFxApplied?.baseCashDelta ?? 0,
              intents_raw: rawIntents,
              intents_compiled: compiledIntents.map((c) => ({
                intent: c.intent,
                order: c.order ?? null,
                skipped: c.skipped ?? null,
                notional_base: c.notionalBase,
              })),
            }
          : { skipped: true },
      },
      regime: regime ?? null,
      algo_regime: algoRegime ?? null,
      fear_index: { score: fearIndex.score, label: fearIndex.label, size_multiplier: fearIndex.sizeMultiplier, reason: fearIndex.reason },
      tail_hedge: tailHedgeDecision,
      tail_hedge_execution: tailHedgeExecution,
      tail_hedge_reconciliation: tailHedgeReconciliation,
      learning: {
        stats: learning.stats,
        lessons: learning.lessons,
        lessons_as_of: learning.lessons_as_of,
      },
      plain_explanation: {
        text: runExplanation.text,
        model: runExplanation.model,
        category: runExplanation.category,
      },

    }),
  }).select("id").single();
  const decisionId = decisionInsert.data?.id ?? null;

  // Fear-index threshold alert (fire-and-forget): notifies when panic blocks
  // fresh buys or elevated/complacent readings changed buy sizing.
  try {
    const { maybeNotifyFearIndex } = await import("./fear-index-notify.server");
    maybeNotifyFearIndex({
      portfolioId,
      userId: portfolio.user_id ?? null,
      fearIndex: {
        score: fearIndex.score,
        label: fearIndex.label,
        sizeMultiplier: fearIndex.sizeMultiplier,
        blockNewBuys: fearIndex.blockNewBuys,
        reason: fearIndex.reason,
      },
      orders: executed.map((o) => ({
        symbol: o.symbol,
        side: o.side,
        value: o.value,
        rejected: o.rejected ?? null,
        reason: o.reason ?? null,
      })),
    });
  } catch (e) {
    console.warn("fear-index alert hook failed", e instanceof Error ? e.message : String(e));
  }

  // Shadow variant B (fire-and-forget): runs an alternate prompt in the background
  // so we can weekly-compare divergences without affecting live execution.
  if (!breakerTripped) {
    (async () => {
      try {
        const { runShadowVariant } = await import("./ab-testing.server");
        await runShadowVariant({
          portfolioId,
          decisionId,
          asOf,
          primary: decision,
          aiArgs: {
            portfolio,
            holdings: holdings ?? [],
            cashValue: cash,
            totalValue,
            features,
            news: scoredNews.slice(0, 15).map((n) => ({
              headline: n.headline, source: n.source, sentiment: n.sentiment,
            })),
            crossAsset: crossAsset ? formatCrossAssetBlock(crossAsset) : "CROSS-ASSET CONTEXT: unavailable.",
            optionsBlock: `${options ? formatOptionsBlock(options) : "OPTIONS-IMPLIED SIGNALS: unavailable."}\n\n${fearBlock}`,
            crossSectional: formatCrossSectionalBlock(rankMap),
            marketEvents: macroPlaybookBlock
              ? `${marketEventsBlock}\n\n${macroPlaybookBlock}`
              : marketEventsBlock,
            events,
            cooling: coolingSymbols,
            asOf,
            regime: effectiveRegime,
            learning,
            attribution: attribution ? formatAttributionBlock(attribution) : null,
            regimeNote: tightened.note,
            hyperparams: hyperparams ?? null,
            calibrationBlock: formatCalibrationBlock(calibration),
          },
        });
      } catch (e) {
        console.warn("Shadow variant skipped:", e);
      }
    })();
  }


  // Route to Saxo for live modes. Paper mode is a no-op inside the helper.
  let routedOrders: unknown = null;
  if (portfolio.mode === "live_sim" || portfolio.mode === "live_prod") {
    try {
      const { routeOrdersToBroker } = await import("@/lib/live-executor.server");
      routedOrders = await routeOrdersToBroker({
        portfolio: { id: portfolioId, mode: portfolio.mode, live_paused: portfolio.live_paused },
        userId: portfolio.user_id,
        asOf,
        decisionId,
        executed,
        algoRegime,
      });
      if (Array.isArray(routedOrders)) {
        for (const result of routedOrders as Array<{
          symbol?: string;
          side?: "buy" | "sell";
          status?: string;
          skipped?: string;
          reason?: string;
        }>) {
          const status = String(result.status ?? "").toLowerCase();
          if (status !== "skipped" && status !== "error") continue;
          const hit = executed.find(
            (t) =>
              t.symbol.toUpperCase() === String(result.symbol ?? "").toUpperCase() &&
              t.side === result.side &&
              !t.rejected,
          );
          if (hit) hit.rejected = result.skipped ?? result.reason ?? `broker routing ${status}`;
        }
      }

    } catch (e) {
      console.error("live routing failed", portfolioId, e);
      routedOrders = { error: e instanceof Error ? e.message : String(e) };
    }
    // Broker is authoritative for live portfolios: overwrite local holdings /
    // cash / today's equity snapshot with what Saxo actually holds so any
    // rejected or errored order can't leave phantom positions behind.
    try {
      const { reconcileLiveHoldingsFromBroker } = await import(
        "@/lib/live-holdings-sync.server"
      );
      const { withOwnedClient } = await import("./_server/owned-client");
      await reconcileLiveHoldingsFromBroker(
        portfolioId,
        withOwnedClient(portfolio.user_id),
      );
    } catch (e) {
      console.warn("live holdings reconcile skipped", portfolioId, e);
    }
  }

  // Per-symbol audit log: capture every buy/sell/hold, the market inputs, the
  // resulting broker order id (when live-routed) and the initial outcome. A
  // DB trigger on live_orders keeps `outcome` in sync as the broker updates
  // status. Fire-and-forget so a logging failure never blocks the tick.
  try {
    const { recordAiDecisionAudit } = await import("./ai-decision-audit.server");
    const heldAfter = Array.from(holdingsByS.values()).map((h) => ({
      symbol: h.symbol,
      quantity: Number(h.quantity),
      asset_class: h.asset_class as string | null,
      instrument_ccy: (h as { instrument_ccy?: string | null }).instrument_ccy ?? null,
    }));
    await recordAiDecisionAudit({
      portfolioId,
      userId: portfolio.user_id,
      decisionId,
      runDate: asOf,
      model: "google/gemini-2.5-flash",
      executed: executed.map((t) => ({
        ...t,
        instrument_ccy: instrumentCcyFor(t.symbol, t.instrument_ccy ?? null, inferSaxoCurrency(t.symbol)),
      })) as unknown as Parameters<typeof recordAiDecisionAudit>[0]["executed"],
      heldAfter,
      features: features as unknown as Record<string, unknown>,
      regime: effectiveRegime,
      rationale: decision.rationale,
    });
  } catch (e) {
    console.warn("ai_decision_audit skipped", portfolioId, e);
  }

  // Self-reflection: refresh distilled lessons periodically. Fire-and-forget so
  // reflection cost never blocks the tick; failures just skip this cycle.

  reflectAndUpdateLessons(portfolioId, asOf, learning).catch((e) =>
    console.warn("Reflection skipped:", e),
  );

  // Signal-decay tracker: refresh rolling 30d hit rates & edge bps by signal.
  updateSignalPerformance(portfolioId, asOf).catch((e) =>
    console.warn("Signal-decay update skipped:", e),
  );

  // K. Calibration loop: recompute Brier score & global sizing multiplier for next cycle.
  computeAndPersistCalibration(portfolioId, asOf).catch((e) =>
    console.warn("Calibration update skipped:", e),
  );


  return { decision, executed, totalValue: newTotal, cash: workingCash, routedOrders };
}


// Snapshot the portfolio value on a date without calling the AI (for backtest fill-in).
export async function snapshotPortfolio(portfolioId: string, asOf: string) {
  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("current_cash, currency, broker_account_id")
    .eq("id", portfolioId)
    .single();
  if (!portfolio) return;
  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("symbol, quantity, avg_cost")
    .eq("portfolio_id", portfolioId);

  const priceMap = await currentPrices(
    (holdings ?? []).map((h) => h.symbol),
    asOf,
  );
  const cash = Number(portfolio.current_cash);
  const baseCcy = ((portfolio as { currency?: string | null }).currency || "GBP").toUpperCase();
  const valuation = await valuePortfolioHoldings({
    holdings: (holdings ?? []).map((h) => ({
      symbol: h.symbol,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
    })),
    normalizedPrices: priceMap,
    wallet: { [baseCcy]: cash },
    baseCcy,
    asOf,
  });
  const hv = valuation.holdingsValue;
  await writeEquitySnapshot(supabaseAdmin as never, {
    portfolioId,
    snapshotDate: asOf,
    cash: valuation.cash,
    holdingsValue: hv,
    totalValue: valuation.totalValue,
    currency: baseCcy,
    source: "trading_engine",
    provenance: valuation.provenance,
    brokerLinked: Boolean(
      (portfolio as unknown as { broker_account_id?: string | null }).broker_account_id,
    ),
    positionCount: (holdings ?? []).length,
  });


  await recordIntradayEquity(supabaseAdmin as never, portfolioId, {
    cash: valuation.cash,
    holdingsValue: hv,
    totalValue: valuation.totalValue,
  });
}
