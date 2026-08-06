// AI decision call (Lovable AI Gateway) for the trading engine — extracted verbatim.
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createLovableAiGatewayProvider } from "../ai-gateway.server";
import { HISTORICAL_PLAYBOOK } from "../historical-playbook.server";
import { HEDGE_FUND_PLAYBOOK } from "../hedge-fund-playbook.server";
import { COMMODITY_PLAYBOOK } from "../commodity-playbook.server";
import { CRYPTO_PLAYBOOK } from "../crypto-playbook.server";
import { formatLearningBlock, type LearningContext } from "../learning.server";
import { logCounterfactual } from "../counterfactuals.server";
import { formatHyperparamBlock, type TunedHyperparams } from "../hyperparam-tuning.server";
import {
  riskProfile,
  parseRiskConfig,
  effectiveCashFloorPct,
  buildDiversificationTiltBlock,
} from "../universe.server";
import { tradingStylePrompt } from "../trading-style";
import { regimeDescription, humanRegime, type PersistedRegime } from "../regime-detector.server";
import { DecisionSchema, type DecisionOutput, type Portfolio, type Holding } from "./types";
import { formatCandidateTable, activeAssetClasses } from "./features-prompt";
import type { buildCandidateFeatures } from "./candidate-features.server";

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
  /** Sector cycle: which sectors are growing / stagnating / shrinking. */
  sectorCycleBlock?: string | null;
  /** Explicit target-exposure block from the cash-allocation policy. */
  cashPolicyBlock?: string | null;




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

  // Asset-class playbooks are ~1.3k tokens each and are dead weight when the
  // portfolio holds nothing in that class and today's candidate list contains
  // none either — a stock/ETF-only tick can never act on them. Class limits
  // are checked too, so a class the portfolio is allowed to enter keeps its
  // playbook even before the first position exists.
  const activeClasses = activeAssetClasses(
    args.features as unknown as readonly unknown[],
    args.holdings as unknown as ReadonlyArray<{ symbol?: string; asset_class?: string | null }>,
  );
  const classAllowed = (cls: string) =>
    activeClasses.has(cls) || Number((cfg.asset_class_limits as Record<string, number>)[cls] ?? 0) > 0;
  const commodityBlock = classAllowed("commodity") ? COMMODITY_PLAYBOOK : "";
  const cryptoBlock = classAllowed("crypto") ? CRYPTO_PLAYBOOK : "";


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
- Positions with a ${cfg.stop_loss_pct > 0 ? `${(cfg.stop_loss_pct * 100).toFixed(0)}% drop from avg cost are auto-sold (stop-loss)${cfg.atr_scaled_stop_enabled ? `, and that stop tightens automatically to ${cfg.initial_stop_atr_mult}×ATR (floor ${(cfg.atr_scaled_stop_floor_pct * 100).toFixed(0)}%) for low-volatility names` : ""}` : "no stop-loss configured"}.
- Positions with a ${cfg.take_profit_pct > 0 ? `${(cfg.take_profit_pct * 100).toFixed(0)}% gain from avg cost are auto-sold (take-profit)` : "no take-profit configured"}.
- ${cfg.atr_trailing_mult > 0 ? `An ATR trailing stop at ${cfg.atr_trailing_mult}×ATR below each position's high-water mark auto-sells on breach.` : "No ATR trailing stop configured."}
- ${cfg.max_hold_days > 0 ? `Positions held longer than ${cfg.max_hold_days} days are auto-exited (time-based exit).` : "No time-based exit configured."}
${cfg.volatility_sizing ? `- Position sizing scales inversely to 20d volatility to target ~${(cfg.vol_target_pct * 100).toFixed(2)}% daily risk per position.` : ""}
- Only trade the provided symbols.

${tradingStylePrompt(cfg)}

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
${args.sectorCycleBlock ?? ""}

${args.cashPolicyBlock ?? ""}


${HISTORICAL_PLAYBOOK}

${HEDGE_FUND_PLAYBOOK}

${commodityBlock}

${cryptoBlock}

${args.cryptoSignalsBlock ?? ""}

${args.fxSystemBlock ?? ""}

${buildDiversificationTiltBlock({ tilt: cfg.diversification_tilt, cfg })}


COMPANY FINANCIALS — MANDATORY REVIEW BEFORE ANY EQUITY BUY:
- The "fund" block on each candidate row carries that company's publicly disclosed financial position: reported margins and returns on capital, revenue and earnings growth, balance-sheet gearing, liquidity and free cash flow, valuation multiples, dividend cover, short interest, published analyst consensus and the next scheduled results date.
- Never buy a stock on price action, momentum or headlines alone. Read its financials first and say in your rationale what the numbers show — cite at least one concrete figure (e.g. P/E, net margin, revenue growth, debt/equity, free cash flow) for every equity buy.
- Treat listed RISK items as disclosed facts, not opinions. Loss-making, negative free cash flow, leverage above 2x debt/equity, uncovered dividends or a current ratio below 0.8 each require an explicit, stated reason to buy anyway, and should reduce the size you take.
- Where fundamentals contradict the technical/sentiment signal, prefer the financials for holding-period decisions and the technicals only for timing.
- A stretched valuation (very high P/E, PEG or EV/EBITDA versus growth) is a reason to size down or wait, not a reason to chase.
- "cov" tells you how much the company has disclosed. Low coverage or "-" means unknown, NOT good: do not treat missing financials as clean financials, and prefer names where the numbers are visible.
- With results due within 5 days ("nxt_results" / "results due" flag), avoid initiating a new position unless the thesis is explicitly event-driven.
- ETFs, commodities, FX and crypto have no company accounts; "fund -" is expected there and is not a negative.

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

${formatCandidateTable(args.features as unknown as readonly unknown[])}

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
      const { buildHeuristicDecision } = await import("../heuristic-decision");
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
