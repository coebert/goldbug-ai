// Pure shaping for the per-signal weight history: turn raw
// `signal_weight_history` rows into a day-by-day series plus a per-signal
// summary (share of total weight, drift over the window, adaptation strength).

export type SignalWeightRow = {
  as_of: string;
  model_kind: string;
  base_weight: number;
  multiplier: number;
  effective_weight: number;
  regime: string | null;
  reason: string | null;
};

export type SignalWeightPoint = {
  date: string;
  regime: string | null;
  /** Share of the day's total effective weight, 0..1, keyed by model kind. */
  shares: Record<string, number>;
  /** Raw effective weight keyed by model kind. */
  weights: Record<string, number>;
  multipliers: Record<string, number>;
};

export type SignalWeightSummary = {
  kind: string;
  /** Mean share across the window, 0..1. */
  avgShare: number;
  firstShare: number;
  lastShare: number;
  /** lastShare - firstShare. */
  deltaShare: number;
  lastWeight: number;
  lastMultiplier: number;
  /** Mean |multiplier - 1| — how hard adaptation pushed this signal. */
  adaptation: number;
  days: number;
};

export type SignalWeightHistory = {
  portfolio_id: string;
  windowDays: number;
  kinds: string[];
  points: SignalWeightPoint[];
  summary: SignalWeightSummary[];
  /** Kind with the largest average share, or null when there is no data. */
  topDriver: string | null;
};

export const SIGNAL_WINDOW_OPTIONS = [5, 14, 30] as const;
export const SIGNAL_WINDOW_MIN = 5;
export const SIGNAL_WINDOW_MAX = 30;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const SIGNAL_LABELS: Record<string, string> = {
  trend: "Trend",
  mean_reversion: "Mean reversion",
  quality: "Quality",
  carry: "Carry",
  breakout: "Breakout",
};

export function signalLabel(kind: string): string {
  return SIGNAL_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/**
 * Collapse rows into one point per day. When a day carries several runs for
 * the same signal the latest row wins (rows are keyed by day upstream, this
 * is only defensive against duplicates).
 */
export function buildSignalWeightHistory(
  portfolioId: string,
  rows: SignalWeightRow[],
  windowDays: number,
): SignalWeightHistory {
  const byDay = new Map<string, { regime: string | null; kinds: Map<string, SignalWeightRow> }>();

  for (const row of rows) {
    const date = String(row.as_of ?? "").slice(0, 10);
    if (!date || !row.model_kind) continue;
    let day = byDay.get(date);
    if (!day) {
      day = { regime: row.regime ?? null, kinds: new Map() };
      byDay.set(date, day);
    }
    day.kinds.set(row.model_kind, row);
  }

  const dates = [...byDay.keys()].sort().slice(-Math.max(1, windowDays));
  const kindSet = new Set<string>();
  const points: SignalWeightPoint[] = [];

  for (const date of dates) {
    const day = byDay.get(date)!;
    const weights: Record<string, number> = {};
    const multipliers: Record<string, number> = {};
    let total = 0;
    for (const [kind, row] of day.kinds) {
      kindSet.add(kind);
      const w = Math.max(0, num(row.effective_weight));
      weights[kind] = w;
      multipliers[kind] = num(row.multiplier) || 1;
      total += w;
    }
    const shares: Record<string, number> = {};
    for (const [kind, w] of Object.entries(weights)) {
      shares[kind] = total > 0 ? w / total : 0;
    }
    points.push({ date, regime: day.regime, shares, weights, multipliers });
  }

  const kinds = [...kindSet].sort();
  const summary: SignalWeightSummary[] = kinds.map((kind) => {
    const seen = points.filter((p) => kind in p.weights);
    const shares = seen.map((p) => p.shares[kind] ?? 0);
    const avgShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
    const first = shares[0] ?? 0;
    const last = shares[shares.length - 1] ?? 0;
    const lastPoint = seen[seen.length - 1];
    const adaptation = seen.length
      ? seen.reduce((a, p) => a + Math.abs((p.multipliers[kind] ?? 1) - 1), 0) / seen.length
      : 0;
    return {
      kind,
      avgShare,
      firstShare: first,
      lastShare: last,
      deltaShare: last - first,
      lastWeight: lastPoint ? (lastPoint.weights[kind] ?? 0) : 0,
      lastMultiplier: lastPoint ? (lastPoint.multipliers[kind] ?? 1) : 1,
      adaptation,
      days: seen.length,
    };
  });

  summary.sort((a, b) => b.avgShare - a.avgShare);

  return {
    portfolio_id: portfolioId,
    windowDays,
    kinds,
    points,
    summary,
    topDriver: summary[0]?.kind ?? null,
  };
}
