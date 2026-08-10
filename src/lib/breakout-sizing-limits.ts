import type { SignalTrade } from "@/lib/breakout-backtest";

/**
 * Safety limits for driver-recommended sizing.
 *
 * The driver panel can recommend up to ~1.5× on a high-conviction symbol.
 * Left unchecked, a run of prioritised names would stack leverage the account
 * does not have. These caps are applied AFTER the recommendation and are the
 * last word: no combination of risk setting and expectancy-gap weight can
 * exceed them.
 */
export type SizingLimits = {
  /** Hard ceiling on any single position's size multiplier (1 = baseline). */
  maxPositionSize: number;
  /** Max positions held open at the same time; later overlaps are skipped. */
  maxConcurrentSignals: number;
  /**
   * Ceiling on average capital deployed across the cohort, as a % of a flat-1×
   * baseline. 100 = never stake more, in aggregate, than one unit per signal.
   */
  maxTotalDeployedPct: number;
};

export const DEFAULT_SIZING_LIMITS: SizingLimits = {
  maxPositionSize: 1.5,
  maxConcurrentSignals: 5,
  maxTotalDeployedPct: 100,
};

/**
 * NaN must never reach the caps: a single NaN size poisons the running spend
 * and silently disables the budget cap for every later signal. Treat any
 * non-finite value as "no size" for inputs, and as the default for limits.
 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveSizingLimits(partial?: Partial<SizingLimits>): SizingLimits {
  const l = { ...DEFAULT_SIZING_LIMITS, ...(partial ?? {}) };
  return {
    // Infinity is a legitimate "uncapped" request and is kept as-is; NaN is not.
    maxPositionSize: Math.max(0, finiteOrInf(l.maxPositionSize, DEFAULT_SIZING_LIMITS.maxPositionSize)),
    maxConcurrentSignals: Math.max(
      0,
      Math.floor(finiteOrInf(l.maxConcurrentSignals, DEFAULT_SIZING_LIMITS.maxConcurrentSignals)),
    ),
    maxTotalDeployedPct: Math.max(
      0,
      finiteOrInf(l.maxTotalDeployedPct, DEFAULT_SIZING_LIMITS.maxTotalDeployedPct),
    ),
  };
}

function finiteOrInf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return value;
}

export type LimitReason = "position" | "concurrency" | "budget";

export type LimitedSignal = {
  symbol: string;
  date: string;
  requestedSize: number;
  size: number;
  /** Which caps bit on this signal, in the order they were applied. */
  clamped: LimitReason[];
};

export type LimitReport = {
  limits: SizingLimits;
  /** Per-cap count of signals whose size was reduced by that cap. */
  breaches: Record<LimitReason, number>;
  /** Average requested size × 100 — what the drivers asked for. */
  requestedDeployedPct: number;
  /** Average allowed size × 100 — what the caps permitted. */
  deployedPct: number;
  /** Highest number of simultaneously open sized positions after capping. */
  peakConcurrent: number;
  /** Largest single allowed size multiplier. */
  peakPositionSize: number;
  summary: string;
};

export type LimitedPlan = { signals: LimitedSignal[]; report: LimitReport };

type SizedInput = Pick<SignalTrade, "symbol" | "date" | "barsHeld"> & { size: number };

/**
 * Rank each signal on a shared timeline so overlap can be measured without
 * assuming trading-day arithmetic: a position entered at rank r with n bars
 * held occupies [r, r + n).
 */
function timeline(signals: readonly SizedInput[]): Map<string, number> {
  const dates = [...new Set(signals.map((s) => s.date))].sort();
  return new Map(dates.map((d, i) => [d, i]));
}

/**
 * Apply the caps to an already-sized, chronologically ordered signal list.
 *
 * Order matters and is deliberate:
 *  1. per-position ceiling (a single name can never dominate),
 *  2. concurrency (refuse a new position when the book is full),
 *  3. aggregate budget (trim, partially if needed, once the cohort's average
 *     deployment would breach the ceiling).
 */
export function applySizingLimits(
  signals: readonly SizedInput[],
  partial?: Partial<SizingLimits>,
): LimitedPlan {
  const limits = resolveSizingLimits(partial);
  const ranks = timeline(signals);
  const breaches: Record<LimitReason, number> = { position: 0, concurrency: 0, budget: 0 };

  const total = signals.length;
  const budget = (total * limits.maxTotalDeployedPct) / 100;
  let spent = 0;
  let peakConcurrent = 0;
  let peakPositionSize = 0;

  const open: { until: number; size: number }[] = [];
  const out: LimitedSignal[] = [];

  for (const s of signals) {
    const rank = ranks.get(s.date) ?? 0;
    // NaN is a bug upstream, not a trade: size it 0. An infinite request is a
    // real "as much as allowed" ask and is left for the position cap to clamp.
    const requestedSize = Math.max(0, finiteOrInf(s.size, 0));
    const clamped: LimitReason[] = [];
    let size = requestedSize;

    // 1 — per-position ceiling
    if (size > limits.maxPositionSize) {
      size = limits.maxPositionSize;
      clamped.push("position");
    }

    // 2 — concurrency: drop positions whose hold window has closed first
    for (let i = open.length - 1; i >= 0; i--) if (open[i].until <= rank) open.splice(i, 1);
    if (size > 0 && open.length >= limits.maxConcurrentSignals) {
      size = 0;
      clamped.push("concurrency");
    }

    // 3 — aggregate deployment budget (partial fills allowed)
    if (size > 0) {
      const remaining = budget - spent;
      if (remaining <= 0) {
        size = 0;
        clamped.push("budget");
      } else if (size > remaining) {
        size = remaining;
        clamped.push("budget");
      }
    }

    if (size > 0) {
      spent += size;
      open.push({ until: rank + Math.max(1, finiteOr(s.barsHeld, 1)), size });
      if (open.length > peakConcurrent) peakConcurrent = open.length;
      if (size > peakPositionSize) peakPositionSize = size;
    }

    for (const c of clamped) breaches[c]++;
    out.push({ symbol: s.symbol, date: s.date, requestedSize, size, clamped });
  }

  const requested = signals.reduce((a, s) => a + Math.max(0, finiteOrInf(s.size, 0)), 0);
  const requestedDeployedPct = total ? (requested / total) * 100 : 0;
  const deployedPct = total ? (spent / total) * 100 : 0;
  const anyBreach = breaches.position + breaches.concurrency + breaches.budget;

  const summary = !total
    ? "No signals to limit."
    : anyBreach === 0
      ? `Within safety limits: ${deployedPct.toFixed(0)}% deployed, peak ${peakConcurrent} concurrent, max ${peakPositionSize.toFixed(2)}× per position.`
      : `Caps bit on ${anyBreach} signal${anyBreach === 1 ? "" : "s"} (${breaches.position} size, ${breaches.concurrency} concurrency, ${breaches.budget} budget) — deployment cut from ${requestedDeployedPct.toFixed(0)}% to ${deployedPct.toFixed(0)}% of baseline.`;

  return {
    signals: out,
    report: {
      limits,
      breaches,
      requestedDeployedPct,
      deployedPct,
      peakConcurrent,
      peakPositionSize,
      summary,
    },
  };
}
