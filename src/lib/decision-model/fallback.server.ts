/**
 * Learned-model fallback.
 *
 * When the AI gateway is unreachable we no longer drop straight to the
 * hand-written momentum rules. If a model fitted on this account's own
 * history is on record AND it held up out of sample, we trade its ranking
 * instead — with deliberately tighter limits than a live AI decision,
 * because nothing is sanity-checking the orders in prose.
 */
import { loadLatestModel, scoreCandidates, type StoredModel, type SymbolScore } from "./model.server";
import type { AnyRow } from "./features";

/** Hard ceilings for an unsupervised, model-only decision. */
export const LEARNED_MAX_BUYS = 2;
/** Percent of the whole account any single learned-fallback buy may take. */
export const LEARNED_MAX_NAME_WEIGHT_PCT = 6;
/** Only act on names the model likes clearly, not marginally. */
export const LEARNED_BUY_PERCENTILE = 0.85;
/** Exit holdings the model now ranks in the bottom of the book. */
export const LEARNED_SELL_PERCENTILE = 0.12;

export type LearnedOrder = {
  symbol: string;
  side: "buy" | "sell";
  percent: number;
  conviction: number;
  reason: string;
  signal_weights: Record<string, number>;
};

export type LearnedFallback = {
  model: StoredModel;
  scores: SymbolScore[];
  orders: LearnedOrder[];
  briefing: string;
  rationale: string;
};

function weightsFrom(model: StoredModel): Record<string, number> {
  const bw = model.bucket_weights ?? {};
  const out: Record<string, number> = {
    sma_trend: 0,
    rsi: 0,
    price_change: 0,
    news_sentiment: 0,
    volatility: 0,
  };
  for (const k of Object.keys(out)) out[k] = Math.round(Number(bw[k] ?? 0));
  return out;
}

/**
 * Build a decision purely from the fitted model. Returns null when there is
 * no model, the model failed its out-of-sample test, or today's candidate
 * set is too small to rank meaningfully — in those cases the caller should
 * carry on to the hand-written heuristic.
 */
export async function buildLearnedFallback(args: {
  userId: string | null | undefined;
  rows: AnyRow[];
  holdings: Array<{ symbol: string; quantity: number }>;
  fearLabel?: string | null;
  reason: string;
}): Promise<LearnedFallback | null> {
  if (!args.userId) return null;
  const model = await loadLatestModel(args.userId);
  if (!model || !model.usable) return null;

  const scores = scoreCandidates(model, args.rows);
  if (scores.length < 5) return null;

  const byScore = [...scores].sort((a, b) => b.score - a.score);
  const held = new Set(args.holdings.filter((h) => Number(h.quantity) > 0).map((h) => h.symbol));

  // --- exits first: risk always comes down before it goes up --------------
  const sells: LearnedOrder[] = byScore
    .filter((s) => held.has(s.symbol) && s.percentile <= LEARNED_SELL_PERCENTILE && s.score < 0)
    .map((s) => ({
      symbol: s.symbol,
      side: "sell" as const,
      percent: 100,
      conviction: 0.5,
      reason: `Learned model ranks ${s.symbol} in the bottom ${(LEARNED_SELL_PERCENTILE * 100).toFixed(0)}% of today's book (score ${s.score.toFixed(2)}); exiting while the AI review is unavailable.`,
      signal_weights: weightsFrom(model),
    }));

  // --- buys: capped hard, and suppressed when the crowd is euphoric -------
  const greedy = (args.fearLabel ?? "").toLowerCase().includes("extreme greed");
  const buys: LearnedOrder[] = greedy
    ? []
    : byScore
        .filter((s) => !held.has(s.symbol) && s.percentile >= LEARNED_BUY_PERCENTILE && s.score > 0)
        .slice(0, LEARNED_MAX_BUYS)
        .map((s) => ({
          symbol: s.symbol,
          side: "buy" as const,
          percent: LEARNED_MAX_NAME_WEIGHT_PCT,
          conviction: 0.45,
          reason: `Learned model's top-ranked candidate (score ${s.score.toFixed(2)}, ${(s.percentile * 100).toFixed(0)}th percentile) on weights fitted from this account's own ${model.coverage.dates}-day history.`,
          signal_weights: weightsFrom(model),
        }));

  const orders = [...sells, ...buys];
  const m = model.metrics.test;

  return {
    model,
    scores,
    orders,
    briefing: `The AI review was unavailable (${args.reason.slice(0, 100)}), so the decision came from the model fitted on this account's own trading history — not the generic rule set. It ranked ${scores.length} candidates and proposed ${sells.length} exit${sells.length === 1 ? "" : "s"} and ${buys.length} new position${buys.length === 1 ? "" : "s"}, each capped at ${LEARNED_MAX_NAME_WEIGHT_PCT}% of the account.${greedy ? " Buying was suppressed entirely because the market is in extreme greed." : ""}`,
    rationale: `Fitted model ${model.id.slice(0, 8)} (${model.coverage.samples} observations, ${model.coverage.dates} days, out-of-sample IC ${m.mean_ic?.toFixed(3) ?? "n/a"} at t ${m.ic_t_stat?.toFixed(2) ?? "n/a"}) applied to today's candidate set. Position limits are deliberately tighter than a live AI decision (max ${LEARNED_MAX_BUYS} buys, ${LEARNED_MAX_NAME_WEIGHT_PCT}% each) because no model reviewed the orders in prose. Gateway error: ${args.reason.slice(0, 200)}.`,
  };
}
