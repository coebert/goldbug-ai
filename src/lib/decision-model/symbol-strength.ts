// Per-symbol historical signal strength.
//
// The learned model produces one cross-sectional score per name per day, but
// that score is NOT equally trustworthy on every instrument: the book has
// years of usable evidence on a FTSE tracker and a handful of noisy days on a
// thinly-traded ETC. "Signal strength" is that per-symbol track record —
// how well the score it was shown actually predicted the cost- and
// risk-adjusted outcome for THAT name.
//
// Pure module: the server side supplies the observations, this file does the
// arithmetic, so the formula is unit-testable without Supabase.

export type StrengthObservation = {
  date: string;
  /** Cross-sectionally normalised model score the engine saw that day. */
  score: number;
  /** Realised label over the horizon (cost/risk-adjusted forward return). */
  y: number;
  /** Observation weight (real-money days count for more). */
  w?: number;
};

export type SymbolStrength = {
  symbol: string;
  samples: number;
  dates: number;
  /** Share of observations where the score's sign matched the outcome's. */
  hitRate: number | null;
  /** Mean realised outcome, in basis points, net of dealing costs. */
  meanNetBps: number | null;
  /** Correlation between the score and the realised outcome for this name. */
  ic: number | null;
  /** t-statistic of score x outcome — is the agreement stable or one lucky week? */
  tStat: number | null;
  /** 0..1 confidence in this name's signal, shrunk for small samples. */
  strength: number;
  from: string | null;
  to: string | null;
};

/** Samples at which a measurement carries roughly half its full weight. */
export const STRENGTH_SHRINK_K = 12;
/** Correlation treated as a full-marks signal. */
export const STRENGTH_IC_FULL = 0.1;
/** t-statistic treated as a full-marks signal. */
export const STRENGTH_T_FULL = 2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa <= 0 || sbb <= 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Summarise one symbol's history into a single 0..1 strength plus the raw
 * evidence behind it. Strength blends how well the score correlated with the
 * outcome and how stable that agreement was, then shrinks the result toward
 * zero when the sample is thin — a name with four observations never
 * outranks one with two hundred on the same measured edge.
 */
export function summariseSymbolStrength(
  symbol: string,
  obs: StrengthObservation[],
): SymbolStrength {
  const rows = obs.filter((o) => Number.isFinite(o.score) && Number.isFinite(o.y));
  const dates = new Set(rows.map((r) => r.date));
  const sorted = [...dates].sort();
  const base: SymbolStrength = {
    symbol,
    samples: rows.length,
    dates: dates.size,
    hitRate: null,
    meanNetBps: null,
    ic: null,
    tStat: null,
    strength: 0,
    from: sorted[0] ?? null,
    to: sorted[sorted.length - 1] ?? null,
  };
  if (rows.length === 0) return base;

  const scores = rows.map((r) => r.score);
  const ys = rows.map((r) => r.y);

  const hits = rows.filter((r) => (r.score >= 0 ? r.y > 0 : r.y < 0)).length;
  base.hitRate = rows.length ? hits / rows.length : null;
  base.meanNetBps = mean(ys) * 10_000;
  base.ic = corr(scores, ys);

  // Agreement series: positive whenever the score pointed the right way.
  const g = rows.map((r) => r.score * r.y);
  const mg = mean(g);
  if (g.length > 2) {
    const sd = Math.sqrt(g.reduce((a, b) => a + (b - mg) * (b - mg), 0) / (g.length - 1));
    base.tStat = sd > 0 ? mg / (sd / Math.sqrt(g.length)) : null;
  }

  const icPart = clamp01((base.ic ?? 0) / STRENGTH_IC_FULL);
  const tPart = clamp01((base.tStat ?? 0) / STRENGTH_T_FULL);
  const shrink = rows.length / (rows.length + STRENGTH_SHRINK_K);
  base.strength = clamp01(shrink * (0.5 * icPart + 0.5 * tPart));
  return base;
}

/** Human label for a strength value — used in the UI and the AI prompt. */
export function strengthLabel(strength: number): "strong" | "moderate" | "weak" | "unproven" {
  if (strength >= 0.6) return "strong";
  if (strength >= 0.35) return "moderate";
  if (strength >= 0.15) return "weak";
  return "unproven";
}

/**
 * Rank today's candidates so the strongest historical signals come first:
 * a name's model score is discounted by how reliable that name's score has
 * historically been. Unmeasured names keep a neutral prior so a brand-new
 * instrument is neither promoted nor buried.
 */
export const NEUTRAL_STRENGTH = 0.35;

export function strengthAdjustedScore(score: number, strength: number | null | undefined): number {
  const s = strength == null || !Number.isFinite(strength) ? NEUTRAL_STRENGTH : strength;
  // Keep the sign; scale magnitude by 0.5..1.5 of the measured reliability.
  return score * (0.5 + s);
}
