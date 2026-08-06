// Pure helpers for the ticket-size × cost-assumption backtest sweep.
//
// The question this answers: "at what all-in transaction cost does swing
// trading stop destroying money?" We run the same tape at several cost
// scales (a multiplier on commission / slippage / impact) and several
// ticket sizes (per-name weight, which changes how badly the fixed
// commission minimum bites), then interpolate where the net result
// crosses a target (zero, or buy & hold).
//
// Everything here is deterministic and side-effect free so it can be unit
// tested without touching a broker, a network, or the database.

import type { Frictions } from "./broker-simulator";

export type TicketSpec = {
  /** Human label, e.g. "5 x 18%". */
  label: string;
  /** Max concurrently held names. */
  maxNames: number;
  /** Target weight of equity per new position (0..1). */
  perNameWeight: number;
};

export type CostScenario = {
  label: string;
  /** Multiplier applied to the baseline friction model. */
  scale: number;
  frictions: Frictions;
};

/**
 * Scale a friction model. All cost terms move together so a single
 * "cost scale" axis is meaningful: 1.0 = today's Saxo-like assumptions,
 * 0.25 = a quarter of those costs, 0 = frictionless.
 */
export function scaleFrictions(base: Frictions, scale: number): Frictions {
  if (!Number.isFinite(scale) || scale < 0) {
    throw new Error(`scaleFrictions: invalid scale ${scale}`);
  }
  const s = (v: number | undefined) =>
    v === undefined ? undefined : Number((v * scale).toFixed(10));
  return {
    ...(base.commissionBps !== undefined ? { commissionBps: s(base.commissionBps)! } : {}),
    ...(base.minCommission !== undefined ? { minCommission: s(base.minCommission)! } : {}),
    ...(base.buyTaxBps !== undefined ? { buyTaxBps: s(base.buyTaxBps)! } : {}),
    ...(base.slippageBps !== undefined ? { slippageBps: s(base.slippageBps)! } : {}),
    ...(base.impactPerUnit !== undefined ? { impactPerUnit: s(base.impactPerUnit)! } : {}),
  };
}

/** Build the cost axis from a baseline model and a list of scales. */
export function buildCostScenarios(base: Frictions, scales: number[]): CostScenario[] {
  return scales.map((scale) => ({
    label: scale === 1 ? "baseline" : `${(scale * 100).toFixed(0)}% cost`,
    scale,
    frictions: scaleFrictions(base, scale),
  }));
}

/**
 * All-in round-trip cost of one position, in basis points of notional,
 * for a given ticket value. Commission is the greater of the bps rate and
 * the fixed minimum — which is exactly why small tickets are lethal.
 */
export function roundTripCostBps(frictions: Frictions, ticketValue: number): number {
  if (!(ticketValue > 0)) return Number.POSITIVE_INFINITY;
  const bps = frictions.commissionBps ?? 0;
  const min = frictions.minCommission ?? 0;
  const commissionPerSide = Math.max((bps / 10_000) * ticketValue, min);
  const slippagePerSide = ((frictions.slippageBps ?? 0) / 10_000) * ticketValue;
  const buyTax = ((frictions.buyTaxBps ?? 0) / 10_000) * ticketValue;
  const total = 2 * commissionPerSide + 2 * slippagePerSide + buyTax;
  return (total / ticketValue) * 10_000;
}

export type SweepCell = {
  ticket: TicketSpec;
  scenario: CostScenario;
  style: string;
  riskLevel: string;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  trades: number;
  feeDragPct: number;
  sharpe: number;
  maxDrawdownPct: number;
};

export type BreakevenTarget = "zero" | "benchmark";

/** Score used for the breakeven search: positive = viable. */
export function cellScore(cell: SweepCell, target: BreakevenTarget): number {
  return target === "zero"
    ? cell.totalReturnPct
    : cell.totalReturnPct - cell.benchmarkReturnPct;
}

export type BreakevenResult = {
  /**
   * Cost scale at which the score crosses zero (linear interpolation
   * between the bracketing scales). `null` when the strategy never
   * crosses within the swept range.
   */
  scale: number | null;
  /** "always" = viable even at the highest cost swept; "never" = viable nowhere. */
  verdict: "interpolated" | "always" | "never";
  /** Round-trip cost in bps implied by the breakeven scale for this ticket. */
  roundTripBps: number | null;
};

/**
 * Find the breakeven cost scale for one series of cells that share a
 * ticket size, style and risk level, differing only by cost scale.
 * The score is assumed monotonically decreasing in cost; we take the
 * lowest crossing so a noisy tape cannot report an optimistic outlier.
 */
export function findBreakevenScale(
  cells: SweepCell[],
  opts: {
    target?: BreakevenTarget;
    /** Baseline (scale = 1) friction model, used to express the answer in bps. */
    baseFrictions?: Frictions;
    /** Notional of one position, used with `baseFrictions`. */
    ticketValue?: number;
  } = {},
): BreakevenResult {
  const target = opts.target ?? "zero";
  const sorted = [...cells].sort((a, b) => a.scenario.scale - b.scenario.scale);
  if (sorted.length === 0) return { scale: null, verdict: "never", roundTripBps: null };

  const bpsAt = (scale: number): number | null =>
    opts.baseFrictions && opts.ticketValue !== undefined
      ? roundTripCostBps(scaleFrictions(opts.baseFrictions, scale), opts.ticketValue)
      : null;

  const scores = sorted.map((c) => cellScore(c, target));
  if (scores.every((s) => s > 0)) {
    const last = sorted.at(-1)!;
    return {
      scale: last.scenario.scale,
      verdict: "always",
      roundTripBps: bpsAt(last.scenario.scale),
    };
  }
  if (scores.every((s) => s <= 0)) return { scale: null, verdict: "never", roundTripBps: null };

  for (let i = 1; i < sorted.length; i++) {
    const lo = scores[i - 1]!;
    const hi = scores[i]!;
    if (lo > 0 && hi <= 0) {
      const a = sorted[i - 1]!.scenario.scale;
      const b = sorted[i]!.scenario.scale;
      const t = lo / (lo - hi);
      const scale = a + t * (b - a);
      return { scale, verdict: "interpolated", roundTripBps: bpsAt(scale) };
    }
  }
  return { scale: null, verdict: "never", roundTripBps: null };
}

/** Ticket notional implied by a sleeve weight and account size. */
export function ticketValue(startingCash: number, ticket: TicketSpec): number {
  return startingCash * ticket.perNameWeight;
}

/** Compact one-line summary of a breakeven result, for CLI output. */
export function formatBreakeven(r: BreakevenResult): string {
  if (r.verdict === "never") return "never viable in swept range";
  if (r.verdict === "always") return `viable at all swept costs (≤ ${r.scale?.toFixed(2)}x)`;
  const bpsPart = r.roundTripBps === null ? "" : ` (~${r.roundTripBps.toFixed(0)} bps round trip)`;
  return `breakeven at ${(r.scale! * 100).toFixed(0)}% of baseline cost${bpsPart}`;
}
