/**
 * Thesis-break exit.
 *
 * The existing stop stack only fires when price has already travelled the
 * full ATR-scaled stop distance. That is deliberately wide so ordinary noise
 * doesn't churn the book — but it means a position whose *reasoning* has
 * collapsed (news turning hostile, directors selling, trend broken,
 * fundamentals deteriorating, a failed breakout) keeps bleeding until the
 * mechanical stop catches up. Apple and M&S both died that way: the
 * evidence turned first, the stop fired much later.
 *
 * This layer cuts a losing position early when *independent* evidence
 * streams agree the reason for owning it no longer holds. It never fires on
 * a winner, never fires without a loss already on the books, and needs at
 * least two independent deteriorating streams so a single noisy headline
 * can't liquidate a position.
 *
 * Pure and I/O-free.
 */

export type ThesisEvidence = {
  /** Blended news/sentiment score for the symbol, −1..1 (null = unknown). */
  newsScore: number | null;
  /** Sentiment momentum: negative = deteriorating (null = unknown). */
  newsMomentum: number | null;
  /** Insider nudge already computed by the engine, −1..1. */
  insiderNudge: number | null;
  /** Fundamentals score −1..1 (null = unknown); at/below −0.2 counts as weak. */
  fundamentalsScore: number | null;
  /** True when SMA20 is below SMA50 (trend has rolled over). */
  trendBroken: boolean;
  /** True when a breakout entry has since failed back into its base. */
  breakoutFailed: boolean;
};

export type ThesisBreakInputs = {
  /** Unrealised return, e.g. −0.06 for −6%. */
  unrealisedPct: number;
  /** Effective hard-stop distance as a positive fraction (e.g. 0.08). */
  effectiveStopPct: number;
  evidence: ThesisEvidence;
  /** Off by default at the config level; caller passes the flag through. */
  enabled?: boolean;
  /** Minimum agreeing streams before any cut (default 2). */
  minSignals?: number;
  /** Loss needed before the layer arms, as a fraction of the stop (default 0.35). */
  armFractionOfStop?: number;
};

export type ThesisBreakResult = {
  fire: boolean;
  /** 0..1 — a partial trim early, a full exit once conviction is gone. */
  sellFraction: number;
  signals: string[];
  reason: string | null;
};

const NEWS_HOSTILE = -0.2;
const MOMENTUM_FADING = -0.1;
const INSIDER_BEARISH = -0.05;
const FUNDAMENTALS_WEAK = -0.2;

export function evaluateThesisBreak(i: ThesisBreakInputs): ThesisBreakResult {
  const none: ThesisBreakResult = { fire: false, sellFraction: 0, signals: [], reason: null };
  if (i.enabled === false) return none;

  const stop = i.effectiveStopPct > 0 ? i.effectiveStopPct : 0.08;
  const armAt = -stop * (i.armFractionOfStop ?? 0.35);
  if (!(i.unrealisedPct < 0) || i.unrealisedPct > armAt) return none;

  const e = i.evidence;
  const signals: string[] = [];
  if (e.newsScore != null && e.newsScore <= NEWS_HOSTILE) {
    signals.push(`news hostile (${e.newsScore.toFixed(2)})`);
  }
  if (e.newsMomentum != null && e.newsMomentum <= MOMENTUM_FADING) {
    signals.push(`sentiment deteriorating (${e.newsMomentum.toFixed(2)})`);
  }
  if (e.insiderNudge != null && e.insiderNudge <= INSIDER_BEARISH) {
    signals.push(`insider selling (${e.insiderNudge.toFixed(2)})`);
  }
  if (e.fundamentalsScore != null && e.fundamentalsScore <= FUNDAMENTALS_WEAK) {
    signals.push(`weak fundamentals (${e.fundamentalsScore.toFixed(2)})`);
  }
  if (e.trendBroken) signals.push("trend broken (SMA20<SMA50)");
  if (e.breakoutFailed) signals.push("breakout failed back into base");

  const min = Math.max(1, i.minSignals ?? 2);
  if (signals.length < min) return none;

  // Deeper loss and/or more agreeing streams ⇒ take the whole thing off.
  const deep = i.unrealisedPct <= -stop * 0.6;
  const sellFraction = deep || signals.length >= min + 1 ? 1 : 0.5;

  return {
    fire: true,
    sellFraction,
    signals,
    reason:
      `thesis break at ${(i.unrealisedPct * 100).toFixed(2)}% ` +
      `(${sellFraction >= 1 ? "full exit" : "half trim"}): ${signals.join("; ")}`,
  };
}
