// Turns the executive-post event study into coefficients the trading engine
// actually consumes, and applies them when nudging a symbol's news score.
//
// Pure module: the deterministic part (shrinkage, stance selection) is testable
// on its own, and the AI's suggested adjustments are merged through the same
// clamps so a hallucinated number can never widen the engine's risk.

import { EXEC_POST_MAX_NUDGE, TRACKED_EXECUTIVES, type ExecPostSignal } from "./exec-posts";
import type { ExecPostStat, ExecPostStudySummary } from "./exec-post-study";

/** What the AI decided to do with a given person's posts. */
export type ExecPostStance = "follow" | "fade" | "ignore";

export type ExecPostCoefficient = {
  executive_id: string;
  executive_name: string;
  stance: ExecPostStance;
  /** 0..1 multiplier on the person's base weight. */
  weight: number;
  /** Hard cap on the nudge this person can contribute, 0..EXEC_POST_MAX_NUDGE. */
  max_nudge: number;
  /** Decay of the signal, in hours. */
  half_life_hours: number;
  /** Posts required before the signal counts at full confidence. */
  min_posts: number;
  /** 0..1 — how much evidence stands behind the coefficient. */
  confidence: number;
  /** Plain-language justification shown in the UI. */
  note: string;
};

export type ExecPostLessonSet = {
  generated_at: string;
  window_days: number;
  sample_size: number;
  model: string | null;
  narrative: string;
  lessons: string[];
  coefficients: ExecPostCoefficient[];
};

export const EXEC_POST_HALF_LIFE_MIN = 6;
export const EXEC_POST_HALF_LIFE_MAX = 96;

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Neutral starting point: follow at the historical default strength. */
export function defaultCoefficient(executiveId: string): ExecPostCoefficient {
  const exec = TRACKED_EXECUTIVES.find((e) => e.id === executiveId);
  return {
    executive_id: executiveId,
    executive_name: exec?.name ?? executiveId,
    stance: "follow",
    weight: exec?.weight ?? 0.6,
    max_nudge: EXEC_POST_MAX_NUDGE,
    half_life_hours: 36,
    min_posts: 1,
    confidence: 0,
    note: "No study evidence yet — using the catalogued default weight.",
  };
}

export function defaultCoefficients(): ExecPostCoefficient[] {
  return TRACKED_EXECUTIVES.map((e) => defaultCoefficient(e.id));
}

/**
 * Deterministic learning step.
 *
 * - Evidence is shrunk toward the prior with n/(n+k): eight events is where a
 *   person's own record starts to outweigh their catalogued weight.
 * - A losing record (hit rate well under a coin flip) with real evidence flips
 *   the stance to `fade` — the post is treated as a contrarian marker.
 * - A record that is both weak and noisy is set to `ignore` so it stops
 *   consuming risk budget.
 * - Persistence sets the half-life: moves that fully round-trip inside the
 *   week decay fast, moves that stick decay slowly.
 */
export function deriveCoefficient(stat: ExecPostStat): ExecPostCoefficient {
  const base = defaultCoefficient(stat.executive_id);
  const k = 8;
  const shrink = stat.samples / (stat.samples + k);
  const edge = stat.hit_rate_1d - 0.5;
  const confidence = Number(clamp(shrink, 0, 1).toFixed(3));

  let stance: ExecPostStance = "follow";
  let note = "";

  if (stat.samples >= 6 && stat.hit_rate_1d <= 0.38 && stat.mean_signed_1d < 0) {
    stance = "fade";
    note = `Posts led price the wrong way ${Math.round((1 - stat.hit_rate_1d) * 100)}% of the time over ${stat.samples} events — treated as a contrarian marker.`;
  } else if (stat.samples >= 6 && stat.mean_abs_1d < 0.35 && Math.abs(edge) < 0.06) {
    stance = "ignore";
    note = `Average next-day move of only ${stat.mean_abs_1d.toFixed(2)}% with no directional edge — not worth a nudge.`;
  } else {
    note = `Followed: ${Math.round(stat.hit_rate_1d * 100)}% next-day hit rate on ${stat.samples} events, mean ${stat.mean_signed_1d >= 0 ? "+" : ""}${stat.mean_signed_1d.toFixed(2)}% in the post's direction.`;
  }

  // Strength scales with the demonstrated edge, shrunk toward the prior.
  const edgeMult = clamp(1 + edge * 2, 0.35, 1.6);
  const weight =
    stance === "ignore" ? 0 : Number(clamp(base.weight * (1 - shrink + shrink * edgeMult), 0, 1).toFixed(3));

  // Reversal-heavy names get a tighter cap; a big adverse excursion means the
  // nudge should not be able to size a position on its own.
  const reversalPenalty = clamp(1 - stat.reversal_rate, 0.4, 1);
  const maxNudge =
    stance === "ignore"
      ? 0
      : Number(clamp(EXEC_POST_MAX_NUDGE * reversalPenalty, 0, EXEC_POST_MAX_NUDGE).toFixed(4));

  // persistence 1 => the move holds all week; -1 => it fully reverses.
  const halfLife = Number(
    clamp(
      12 + (stat.persistence + 1) * 24,
      EXEC_POST_HALF_LIFE_MIN,
      EXEC_POST_HALF_LIFE_MAX,
    ).toFixed(1),
  );

  return {
    ...base,
    stance,
    weight,
    max_nudge: maxNudge,
    half_life_hours: halfLife,
    min_posts: stat.mean_abs_1d > 1.5 ? 1 : 2,
    confidence,
    note,
  };
}

/** Coefficients for every tracked executive, study-informed where possible. */
export function deriveCoefficients(summary: ExecPostStudySummary): ExecPostCoefficient[] {
  const byId = new Map(summary.by_executive.map((s) => [s.executive_id, s]));
  return TRACKED_EXECUTIVES.map((exec) => {
    const stat = byId.get(exec.id);
    return stat ? deriveCoefficient(stat) : defaultCoefficient(exec.id);
  });
}

export type ExecPostCoefficientAdjustment = {
  executive_id: string;
  stance?: ExecPostStance;
  weight?: number;
  max_nudge?: number;
  half_life_hours?: number;
  min_posts?: number;
  note?: string;
};

/**
 * Merges the AI's suggested adjustments into the derived coefficients. Every
 * field is clamped to the engine's risk envelope, and unknown executive ids
 * are dropped — the model can re-weight, it cannot invent new authority.
 */
export function mergeCoefficientAdjustments(
  derived: ExecPostCoefficient[],
  adjustments: ExecPostCoefficientAdjustment[] | null | undefined,
): ExecPostCoefficient[] {
  if (!adjustments || adjustments.length === 0) return derived;
  const byId = new Map(derived.map((c) => [c.executive_id, { ...c }]));

  for (const adj of adjustments) {
    const cur = byId.get(adj.executive_id);
    if (!cur) continue;
    if (adj.stance === "follow" || adj.stance === "fade" || adj.stance === "ignore") {
      cur.stance = adj.stance;
    }
    if (adj.weight != null) cur.weight = Number(clamp(adj.weight, 0, 1).toFixed(3));
    if (adj.max_nudge != null) {
      cur.max_nudge = Number(clamp(adj.max_nudge, 0, EXEC_POST_MAX_NUDGE).toFixed(4));
    }
    if (adj.half_life_hours != null) {
      cur.half_life_hours = Number(
        clamp(adj.half_life_hours, EXEC_POST_HALF_LIFE_MIN, EXEC_POST_HALF_LIFE_MAX).toFixed(1),
      );
    }
    if (adj.min_posts != null) cur.min_posts = Math.round(clamp(adj.min_posts, 1, 5));
    if (adj.note && adj.note.trim()) cur.note = adj.note.trim().slice(0, 240);
    if (cur.stance === "ignore") {
      cur.weight = 0;
      cur.max_nudge = 0;
    }
    byId.set(adj.executive_id, cur);
  }

  return Array.from(byId.values());
}

/** Half-life the signal builder should use, given what has been learned. */
export function learnedHalfLifeHours(coefficients: ExecPostCoefficient[]): number {
  const active = coefficients.filter((c) => c.stance !== "ignore");
  if (active.length === 0) return 36;
  const avg = active.reduce((a, c) => a + c.half_life_hours, 0) / active.length;
  return Number(clamp(avg, EXEC_POST_HALF_LIFE_MIN, EXEC_POST_HALF_LIFE_MAX).toFixed(1));
}

/**
 * Lesson-aware replacement for `execPostSentimentNudge`.
 *
 * Each contributing executive's stance decides the sign (`fade` inverts the
 * post's sentiment), their learned weight and cap decide the magnitude, and
 * `min_posts` gates thin evidence. With no lessons supplied this reduces to
 * the catalogued default behaviour.
 */
export function learnedExecPostNudge(
  symbol: string,
  signals: ExecPostSignal[],
  coefficients: ExecPostCoefficient[] | null | undefined,
): { nudge: number; stance: ExecPostStance | null; executives: string[] } {
  const sig = signals.find((s) => s.symbol === symbol.toUpperCase());
  if (!sig || sig.posts === 0) return { nudge: 0, stance: null, executives: [] };

  const ids =
    sig.executive_ids && sig.executive_ids.length > 0
      ? sig.executive_ids
      : TRACKED_EXECUTIVES.filter((e) => sig.executives.includes(e.name)).map((e) => e.id);

  const coeffs = (coefficients && coefficients.length > 0 ? coefficients : defaultCoefficients())
    .filter((c) => ids.includes(c.executive_id));
  const usable = coeffs.length > 0 ? coeffs : ids.map((id) => defaultCoefficient(id));

  const contributing = usable.filter(
    (c) => c.stance !== "ignore" && c.weight > 0 && sig.posts >= c.min_posts,
  );
  if (contributing.length === 0) {
    return { nudge: 0, stance: usable[0]?.stance ?? null, executives: [] };
  }

  // Fade flips the sign; follow keeps it. When a symbol is touched by both,
  // the weighted sum resolves the disagreement rather than one side winning.
  let num = 0;
  let denom = 0;
  let cap = 0;
  for (const c of contributing) {
    const sign = c.stance === "fade" ? -1 : 1;
    num += sig.score * sign * c.weight;
    denom += c.weight;
    cap = Math.max(cap, c.max_nudge);
  }
  const directional = denom > 0 ? num / denom : 0;

  const confidence = Math.min(1, 0.5 + 0.25 * (sig.posts - 1));
  const raw = directional * confidence * cap;
  const nudge = Number(clamp(raw, -cap, cap).toFixed(4));

  const dominant = contributing.reduce((a, b) => (b.weight > a.weight ? b : a));
  return {
    nudge,
    stance: dominant.stance,
    executives: contributing.map((c) => c.executive_name),
  };
}
