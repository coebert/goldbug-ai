// Core trading engine. Called once per "tick" (day) for a portfolio.
// Uses AI SDK -> Lovable AI Gateway with structured output.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { HISTORICAL_PLAYBOOK } from "./historical-playbook.server";
import {
  buildLearningContext,
  formatLearningBlock,
  reflectAndUpdateLessons,
  type LearningContext,
} from "./learning.server";
import {
  getDailyCandles,
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
import { getNewsForDate } from "./news.server";
import {
  ensureSentimentScored,
  aggregatedSentimentForSymbol,
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
import {
  parseCircuit,
  evaluateBreaker,
  persistCircuit,
  tightenForRegime,
} from "./circuit-breaker.server";
import { applyBuyExecution, applySellExecution } from "./execution-realism.server";
import {
  filterUniverse,
  findSymbol,
  riskProfile,
  parseRiskConfig,
  type UniverseSymbol,
} from "./universe.server";
import {
  detectAndPersistRegime,
  regimeDescription,
  humanRegime,
  type PersistedRegime,
} from "./regime-detector.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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


const DecisionSchema = z.object({
  briefing: z.string(),
  rationale: z.string(),
  orders: z.array(OrderSchema),
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
    cooling: boolean;
  }> = [];
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
        cooling: false,
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
};

async function callAiForDecision(args: {
  portfolio: Portfolio;
  holdings: Holding[];
  cashValue: number;
  totalValue: number;
  features: Awaited<ReturnType<typeof buildCandidateFeatures>>;
  news: Array<{ headline: string; source: string | null; sentiment: number | null }>;
  crossAsset: string; // preformatted block
  events: Array<{ event_date: string; kind: string; symbol: string | null; title: string; impact: string }>;
  cooling: string[];
  asOf: string;
  regime: PersistedRegime;
  learning: LearningContext;
  attribution?: string | null;
  regimeNote?: string | null;
}): Promise<DecisionOutput> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.6-flash");

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
- Keep at least ${(risk.cashFloorPct * 100).toFixed(0)}% of portfolio value in cash.
- Open at most ${risk.maxNewPositionsPerDay} NEW positions per day.
- Asset-class exposure caps: ${classLimitsStr}.
- Highly correlated buys are portfolio-capped at 35% of value (guardrails will scale down).
- Positions with a ${cfg.stop_loss_pct > 0 ? `${(cfg.stop_loss_pct * 100).toFixed(0)}% drop from avg cost are auto-sold (stop-loss)` : "no stop-loss configured"}.
- Positions with a ${cfg.take_profit_pct > 0 ? `${(cfg.take_profit_pct * 100).toFixed(0)}% gain from avg cost are auto-sold (take-profit)` : "no take-profit configured"}.
${cfg.volatility_sizing ? `- Position sizing scales inversely to 20d volatility to target ~${(cfg.vol_target_pct * 100).toFixed(2)}% daily risk per position.` : ""}
- Only trade the provided symbols.

${regimeBlock}

${args.crossAsset}

${eventsBlock}
${coolingBlock}

${formatLearningBlock(args.learning)}

${args.attribution ?? ""}
${args.regimeNote ? `REGIME RISK ADJUSTMENT: ${args.regimeNote}` : ""}

${HISTORICAL_PLAYBOOK}

Style: ${args.portfolio.risk_level} risk. Explain concisely. Prefer inaction if uncertain.
Prefer high-conviction entries with MULTI-TIMEFRAME confirmation (daily trend AND weekly_trend_up), and be cautious when MACD or Bollinger width disagree with headline sentiment.`;


  const user = `Date: ${args.asOf}
Portfolio value: ${args.totalValue.toFixed(2)} ${args.portfolio.currency}
Cash: ${args.cashValue.toFixed(2)} ${args.portfolio.currency}
Current holdings: ${JSON.stringify(holdingsSummary)}

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
      news_sentiment  — weighted LLM sentiment for this symbol
      volatility      — 20d vol, ATR%, Bollinger width
If no action is warranted, return an empty orders array.`;


  try {
    const { output } = await generateText({
      model,
      system,
      prompt: user,
      output: Output.object({ schema: DecisionSchema }),
    });
    return output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {

      return {
        briefing: "AI response could not be parsed; taking no action today.",
        rationale: error.text?.slice(0, 500) ?? "Parse error",
        orders: [],
      };
    }
    throw error;
  }
}

async function currentPrices(symbols: string[], asOf: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      const p = await getPriceOn(s, asOf);
      if (p != null) out.set(s, p);
    }),
  );
  return out;
}

export async function runDailyTick(portfolioId: string, asOf: string, opts?: { skipNews?: boolean }) {
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

  const universe = filterUniverse(classesFromUniverse(portfolio.universe));

  // Prices for holdings + top candidates
  const candidateSymbols = universe.slice(0, 22); // keep prompt bounded
  const allSymbols = Array.from(
    new Set([...(holdings ?? []).map((h) => h.symbol), ...candidateSymbols.map((c) => c.symbol)]),
  );
  const priceMap = await currentPrices(allSymbols, asOf);

  const cash = Number(portfolio.current_cash);
  const holdingsValue = (holdings ?? []).reduce((sum, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return sum + p * Number(h.quantity);
  }, 0);
  const totalValue = cash + holdingsValue;

  // Circuit breaker: evaluate BEFORE spending on the AI call. If tripped,
  // we still run auto-liquidation stops but skip the AI + any new buys.
  const priorCircuit = parseCircuit(portfolio.circuit_breaker);
  const circuit = await evaluateBreaker(portfolioId, asOf, priorCircuit).catch(() => priorCircuit);
  const breakerTripped = circuit.paused;

  const features = await buildCandidateFeatures(candidateSymbols, asOf);

  const [rawNews, regime, learning, crossAsset, cooldowns, events, attribution] = await Promise.all([
    opts?.skipNews ? Promise.resolve([]) : getNewsForDate(asOf).catch(() => []),
    detectAndPersistRegime(asOf).catch((e) => {
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
        lessons: [], lessons_as_of: null, samples: [],
      } satisfies LearningContext;
    }),
    getCrossAssetSnapshot(asOf).catch(() => null),
    refreshCooldownsFromRecentTrades(portfolioId, asOf).catch(() => ({})),
    upcomingEvents(asOf, candidateSymbols.map((c) => c.symbol)).catch(() => []),
    computeAttribution(portfolioId, asOf).catch(() => null),
  ]);


  // Score news sentiment (LLM pass, cached), then aggregate per-symbol
  const scoredNews = rawNews.length > 0
    ? await ensureSentimentScored(asOf, rawNews).catch(() => rawNews.map((n) => ({
        ...n, sentiment: null, entities: [] as string[], source_weight: 0.4,
      })))
    : [];

  for (const f of features) {
    const agg = aggregatedSentimentForSymbol(f.symbol, f.name, scoredNews, asOf);
    f.news_score = agg.contributors > 0 ? Number(agg.score.toFixed(3)) : null;
    f.news_contributors = agg.contributors;
    f.cooling = isSymbolCooling(cooldowns, f.symbol, asOf);
  }

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
  const tightened = tightenForRegime(baseCfg, portfolio.risk_level, effectiveRegime);
  const cfg = tightened.cfg;
  const cashFloor = totalValue * risk.cashFloorPct;
  const basePerSymbolPct = tightened.per_symbol_effective_pct;
  const maxPosVal = totalValue * basePerSymbolPct;

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
        crossAsset: crossAsset ? formatCrossAssetBlock(crossAsset) : "CROSS-ASSET CONTEXT: unavailable.",
        events,
        cooling: coolingSymbols,
        asOf,
        regime: effectiveRegime,
        learning,
        attribution: attribution ? formatAttributionBlock(attribution) : null,
        regimeNote: tightened.note,
      });


  // Feature lookup for later use (volatility sizing, asset class)
  const featureBySymbol = new Map(features.map((f) => [f.symbol, f] as const));


  let workingCash = cash;
  const holdingsByS = new Map((holdings ?? []).map((h) => [h.symbol, { ...h }] as const));
  const executed: ExecutedTrade[] = [];
  let newPositions = 0;

  // ---- Auto-liquidation: stop-loss / take-profit BEFORE the AI runs ----
  if (cfg.stop_loss_pct > 0 || cfg.take_profit_pct > 0) {
    for (const [sym, h] of Array.from(holdingsByS.entries())) {
      const price = priceMap.get(sym);
      const qty = Number(h.quantity);
      const cost = Number(h.avg_cost);
      if (!price || !(qty > 0) || !(cost > 0)) continue;
      const change = (price - cost) / cost;
      let trigger: string | null = null;
      if (cfg.stop_loss_pct > 0 && change <= -cfg.stop_loss_pct) {
        trigger = `stop-loss triggered (${(change * 100).toFixed(2)}% ≤ -${(cfg.stop_loss_pct * 100).toFixed(1)}%)`;
      } else if (cfg.take_profit_pct > 0 && change >= cfg.take_profit_pct) {
        trigger = `take-profit triggered (+${(change * 100).toFixed(2)}% ≥ +${(cfg.take_profit_pct * 100).toFixed(1)}%)`;
      }
      if (!trigger) continue;
      const value = qty * price;
      workingCash += value;
      holdingsByS.delete(sym);
      executed.push({
        symbol: sym,
        side: "sell",
        quantity: qty,
        price,
        value,
        reason: trigger,
      });
    }
  }

  // Recompute per-asset-class exposure after auto-liquidation, based on live prices.
  const classExposure = new Map<string, number>();
  for (const h of holdingsByS.values()) {
    const price = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    classExposure.set(
      h.asset_class,
      (classExposure.get(h.asset_class) ?? 0) + price * Number(h.quantity),
    );
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
      const qty = Number(cur.quantity) * pct;
      const value = qty * price;
      workingCash += value;
      const remaining = Number(cur.quantity) - qty;
      if (remaining <= 1e-8) holdingsByS.delete(meta.symbol);
      else holdingsByS.set(meta.symbol, { ...cur, quantity: remaining });
      classExposure.set(
        meta.asset_class,
        Math.max(0, (classExposure.get(meta.asset_class) ?? 0) - value),
      );
      executed.push({
        symbol: meta.symbol,
        side: "sell",
        quantity: qty,
        price,
        value,
        reason: order.reason,
      });
    } else {
      // BUY
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
      const spendableCash = Math.max(0, workingCash - cashFloor);
      let spend = spendableCash * pct;
      const sizingNotes: string[] = [];

      // Conviction-weighted Kelly cap (only shrinks; never grows above requested %)
      if (typeof order.conviction === "number") {
        const feat = featureBySymbol.get(meta.symbol);
        const convSpend = convictionSizedSpend({
          baseSize: spend,
          conviction: order.conviction,
          volPct: feat?.vol20d ?? null,
        });
        if (convSpend < spend) {
          spend = convSpend;
          sizingNotes.push(`kelly@conv=${order.conviction.toFixed(2)}`);
        }
      }

      // Loss cooldown: halve size while cooling
      if (isSymbolCooling(cooldowns, meta.symbol, asOf)) {
        spend *= 0.5;
        sizingNotes.push("cooldown x0.5");
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

      // Volatility-based sizing: cap spend so position * vol ≈ vol_target * totalValue
      let volCapped = false;
      if (cfg.volatility_sizing) {
        const vol = featureBySymbol.get(meta.symbol)?.vol20d ?? null;
        if (vol && vol > 0) {
          const targetPositionVal = (cfg.vol_target_pct * totalValue) / vol;
          const volRoom = Math.max(0, targetPositionVal - existingVal);
          if (spend > volRoom) {
            spend = volRoom;
            volCapped = true;
          }
        }
      }

      // Portfolio-level correlated cluster cap
      let corrCapped = false;
      const existingExposureBySymbol = new Map<string, number>();
      for (const h of holdingsByS.values()) {
        const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
        existingExposureBySymbol.set(h.symbol, p * Number(h.quantity));
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
          rejected: classRejected
            ? `asset-class cap reached for ${meta.asset_class}`
            : corrCapped
              ? `correlated-cluster cap reached (${corrRes.cluster.slice(0, 3).join(",")})`
              : volCapped
                ? "volatility sizing leaves no room"
                : "guardrails leave no room to buy",
        });
        continue;
      }

      // Phase 5 — realistic execution (spread, slippage, commission, liquidity cap)
      const featExec = featureBySymbol.get(meta.symbol);
      const outcome = applyBuyExecution({
        requestedSpend: spend,
        price,
        atrPct: featExec?.atr_pct ?? null,
        adv20d: featExec?.adv_20d ?? null,
        params: cfg.execution_params ?? undefined,
      });
      if (outcome.belowMinTrade || outcome.qty <= 0) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: outcome.notes.join("; ") || "trade too small after execution costs",
        });
        continue;
      }
      if (outcome.liquidityCappedSpend != null) sizingNotes.push("liquidity 1% ADV");
      const qty = outcome.qty;
      const fillPrice = outcome.fillPrice;
      workingCash -= outcome.effectiveSpend;
      if (isNewPosition) newPositions += 1;
      const cur = holdingsByS.get(meta.symbol);
      if (cur) {
        const newQty = Number(cur.quantity) + qty;
        const newCost =
          (Number(cur.avg_cost) * Number(cur.quantity) + qty * fillPrice) / newQty;
        holdingsByS.set(meta.symbol, { ...cur, quantity: newQty, avg_cost: newCost });
      } else {
        holdingsByS.set(meta.symbol, {
          id: crypto.randomUUID(),
          portfolio_id: portfolioId,
          symbol: meta.symbol,
          asset_class: meta.asset_class,
          quantity: qty,
          avg_cost: fillPrice,
          updated_at: new Date().toISOString(),
        } as Holding);
      }
      classExposure.set(
        meta.asset_class,
        (classExposure.get(meta.asset_class) ?? 0) + outcome.effectiveSpend,
      );
      executed.push({
        symbol: meta.symbol,
        side: "buy",
        quantity: qty,
        price: fillPrice,
        value: outcome.effectiveSpend,
        reason: sizingNotes.length ? `${order.reason} [${sizingNotes.join(", ")}]` : order.reason,
      });

    }
  }



  // Persist state
  const admin = supabaseAdmin;
  const executedAt = new Date().toISOString();

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
    }));
  if (tradesRows.length > 0) await admin.from("trades").insert(tradesRows);

  // Replace holdings: delete then insert (simpler & atomic-enough for paper account)
  await admin.from("holdings").delete().eq("portfolio_id", portfolioId);
  const holdingsRows = Array.from(holdingsByS.values())
    .filter((h) => Number(h.quantity) > 1e-8)
    .map((h) => ({
      portfolio_id: portfolioId,
      symbol: h.symbol,
      asset_class: h.asset_class,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
    }));
  if (holdingsRows.length > 0) await admin.from("holdings").insert(holdingsRows);

  // Recompute portfolio value with latest holdings
  const newHoldingsValue = Array.from(holdingsByS.values()).reduce((sum, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return sum + p * Number(h.quantity);
  }, 0);
  const newTotal = workingCash + newHoldingsValue;

  await admin
    .from("portfolios")
    .update({ current_cash: workingCash, last_run_date: asOf })
    .eq("id", portfolioId);

  await persistCircuit(portfolioId, circuit).catch((e) =>
    console.warn("Circuit persist skipped:", e),
  );


  await admin.from("equity_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: asOf,
      cash: workingCash,
      holdings_value: newHoldingsValue,
      total_value: newTotal,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );

  await admin.from("decisions").insert({
    portfolio_id: portfolioId,
    run_date: asOf,
    briefing: decision.briefing,
    rationale: decision.rationale,
    model: "google/gemini-3.6-flash",
    portfolio_value: newTotal,
    raw: {
      orders: decision.orders,
      executed,
      signals: features,
      news: scoredNews.slice(0, 12),
      guardrails: {
        risk_level: portfolio.risk_level,
        max_position_pct: basePerSymbolPct,
        cash_floor_pct: risk.cashFloorPct,
        max_new_positions_per_day: risk.maxNewPositionsPerDay,
        cash_floor_value: cashFloor,
        max_position_value: maxPosVal,
        starting_total_value: totalValue,
        starting_cash: cash,
        asset_class_limits: cfg.asset_class_limits,
        per_symbol_limit_pct: cfg.per_symbol_limit_pct,
        stop_loss_pct: cfg.stop_loss_pct,
        take_profit_pct: cfg.take_profit_pct,
        volatility_sizing: cfg.volatility_sizing,
        vol_target_pct: cfg.vol_target_pct,
      },
      regime: regime ?? null,
      learning: {
        stats: learning.stats,
        lessons: learning.lessons,
        lessons_as_of: learning.lessons_as_of,
      },
    } as unknown as never,
  });

  // Self-reflection: refresh distilled lessons periodically. Fire-and-forget so
  // reflection cost never blocks the tick; failures just skip this cycle.
  reflectAndUpdateLessons(portfolioId, asOf, learning).catch((e) =>
    console.warn("Reflection skipped:", e),
  );

  return { decision, executed, totalValue: newTotal, cash: workingCash };
}

// Snapshot the portfolio value on a date without calling the AI (for backtest fill-in).
export async function snapshotPortfolio(portfolioId: string, asOf: string) {
  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("current_cash")
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
  const hv = (holdings ?? []).reduce((s, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return s + p * Number(h.quantity);
  }, 0);
  const cash = Number(portfolio.current_cash);
  await supabaseAdmin.from("equity_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: asOf,
      cash,
      holdings_value: hv,
      total_value: cash + hv,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );
}
