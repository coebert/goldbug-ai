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
  /** Slippage/spread assumption this scenario was built with, when varied. */
  slippage?: SlippageSpec;
  /** Per-trade minimum commission this scenario was built with, when varied. */
  minCommission?: number;
};

/**
 * One point on the execution-cost axis: how much the price moves against
 * us per side. `spreadBps` is the half-spread we cross; `slippageBps` is
 * the extra adverse move (queue position, latency, momentum). They are
 * additive per side. `impactPerUnit` scales with order size and is passed
 * straight through to the simulator.
 */
export type SlippageSpec = {
  label: string;
  /** Adverse move per side, in bps of notional. */
  slippageBps: number;
  /** Half-spread crossed per side, in bps of notional. Default 0. */
  spreadBps?: number;
  /** Size-dependent impact term; when omitted the baseline value is kept. */
  impactPerUnit?: number;
};

/** Total per-side proportional cost implied by a slippage spec, in bps. */
export function slippageBpsOf(spec: SlippageSpec): number {
  const slip = spec.slippageBps ?? 0;
  const spread = spec.spreadBps ?? 0;
  if (!Number.isFinite(slip) || slip < 0) {
    throw new Error(`slippageBpsOf: invalid slippageBps ${spec.slippageBps}`);
  }
  if (!Number.isFinite(spread) || spread < 0) {
    throw new Error(`slippageBpsOf: invalid spreadBps ${spec.spreadBps}`);
  }
  return Number((slip + spread).toFixed(10));
}

/**
 * Tight → brutal execution assumptions, usable as the default slippage
 * axis. Spread and slippage are separated so the labels stay readable.
 */
export const DEFAULT_SLIPPAGE_SPECS: SlippageSpec[] = [
  { label: "tight 2bps", slippageBps: 1, spreadBps: 1, impactPerUnit: 0 },
  { label: "normal 5bps", slippageBps: 3, spreadBps: 2, impactPerUnit: 0.0001 },
  { label: "wide 10bps", slippageBps: 6, spreadBps: 4, impactPerUnit: 0.0002 },
  { label: "stressed 20bps", slippageBps: 13, spreadBps: 7, impactPerUnit: 0.0005 },
];

/**
 * Override only the execution-cost terms of a friction model, leaving
 * commission, minimum fee and tax untouched. This is what makes slippage
 * an independent sweep axis instead of riding on the single cost scale.
 */
export function applySlippage(base: Frictions, spec: SlippageSpec): Frictions {
  const total = slippageBpsOf(spec);
  return {
    ...base,
    slippageBps: total,
    ...(spec.impactPerUnit !== undefined ? { impactPerUnit: spec.impactPerUnit } : {}),
  };
}

/** Override the fixed per-trade minimum commission. */
export function applyMinCommission(base: Frictions, minCommission: number): Frictions {
  if (!Number.isFinite(minCommission) || minCommission < 0) {
    throw new Error(`applyMinCommission: invalid minCommission ${minCommission}`);
  }
  return { ...base, minCommission };
}

/**
 * Full cost grid: commission scale × slippage spec × minimum fee.
 * The commission scale still multiplies every baseline term, but the
 * slippage and minimum-fee overrides are applied afterwards so those two
 * axes are exactly the values requested rather than scaled derivatives.
 */
export function buildCostGrid(
  base: Frictions,
  opts: {
    scales: number[];
    slippage?: SlippageSpec[];
    minCommission?: number[];
  },
): CostScenario[] {
  const slippages = opts.slippage?.length ? opts.slippage : [null];
  const minFees = opts.minCommission?.length ? opts.minCommission : [null];
  const out: CostScenario[] = [];
  for (const scale of opts.scales) {
    for (const spec of slippages) {
      for (const minFee of minFees) {
        let frictions = scaleFrictions(base, scale);
        if (spec) frictions = applySlippage(frictions, spec);
        if (minFee !== null) frictions = applyMinCommission(frictions, minFee);
        const parts = [scale === 1 ? "baseline" : `${(scale * 100).toFixed(0)}% cost`];
        if (spec) parts.push(spec.label);
        if (minFee !== null) parts.push(`min £${minFee}`);
        out.push({
          label: parts.join(" · "),
          scale,
          frictions,
          ...(spec ? { slippage: spec } : {}),
          ...(minFee !== null ? { minCommission: minFee } : {}),
        });
      }
    }
  }
  return out;
}

/** Stable identity for a scenario, safe as a map key across all three axes. */
export function scenarioKey(sc: CostScenario): string {
  return [sc.scale, sc.slippage?.label ?? "-", sc.minCommission ?? "-"].join("|");
}


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
    /**
     * Execution-cost / minimum-fee assumptions that were held fixed across
     * the series. They are re-applied after scaling so the bps read-out
     * does not scale terms the sweep never varied.
     */
    fixedSlippage?: SlippageSpec;
    fixedMinCommission?: number;
  } = {},
): BreakevenResult {
  const target = opts.target ?? "zero";
  const sorted = [...cells].sort((a, b) => a.scenario.scale - b.scenario.scale);
  if (sorted.length === 0) return { scale: null, verdict: "never", roundTripBps: null };

  const bpsAt = (scale: number): number | null => {
    if (!opts.baseFrictions || opts.ticketValue === undefined) return null;
    let f = scaleFrictions(opts.baseFrictions, scale);
    if (opts.fixedSlippage) f = applySlippage(f, opts.fixedSlippage);
    if (opts.fixedMinCommission !== undefined) f = applyMinCommission(f, opts.fixedMinCommission);
    return roundTripCostBps(f, opts.ticketValue);
  };


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

/**
 * Baseline frictions for one series, i.e. the baseline model with the
 * series' own slippage and minimum-fee overrides applied. Using this for
 * the bps read-out keeps the breakeven answer honest when the sweep
 * varied execution costs independently of the commission scale.
 */
export function seriesBaseFrictions(base: Frictions, sample: CostScenario | undefined): Frictions {
  if (!sample) return base;
  let f = base;
  if (sample.slippage) f = applySlippage(f, sample.slippage);
  if (sample.minCommission !== undefined) f = applyMinCommission(f, sample.minCommission);
  return f;
}

export type BreakevenGroup = {
  ticket: TicketSpec;
  style: string;
  riskLevel: string;
  slippageLabel: string;
  minCommission: number | null;
  ticketValue: number;
  baselineRoundTripBps: number;
  vsZero: BreakevenResult;
  vsBenchmark: BreakevenResult;
};

/**
 * Breakeven per (risk, style, ticket, slippage, minimum fee) series — the
 * cells within a group differ only by commission scale, which is what
 * `findBreakevenScale` interpolates over.
 */
export function breakevenGrid(
  cells: SweepCell[],
  opts: { baseFrictions: Frictions; startingCash: number },
): BreakevenGroup[] {
  const groups = new Map<string, SweepCell[]>();
  for (const c of cells) {
    const key = [
      c.riskLevel,
      c.style,
      c.ticket.label,
      c.scenario.slippage?.label ?? "-",
      c.scenario.minCommission ?? "-",
    ].join("|");
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const out: BreakevenGroup[] = [];
  for (const series of groups.values()) {
    const first = series[0]!;
    const tv = ticketValue(opts.startingCash, first.ticket);
    const seriesBase = seriesBaseFrictions(opts.baseFrictions, first.scenario);
    const fixed = {
      ...(first.scenario.slippage ? { fixedSlippage: first.scenario.slippage } : {}),
      ...(first.scenario.minCommission !== undefined
        ? { fixedMinCommission: first.scenario.minCommission }
        : {}),
    };
    out.push({
      ticket: first.ticket,
      style: first.style,
      riskLevel: first.riskLevel,
      slippageLabel: first.scenario.slippage?.label ?? "baseline",
      minCommission: first.scenario.minCommission ?? null,
      ticketValue: tv,
      baselineRoundTripBps: roundTripCostBps(seriesBase, tv),
      vsZero: findBreakevenScale(series, {
        baseFrictions: opts.baseFrictions,
        ticketValue: tv,
        ...fixed,
      }),
      vsBenchmark: findBreakevenScale(series, {
        target: "benchmark",
        baseFrictions: opts.baseFrictions,
        ticketValue: tv,
        ...fixed,
      }),
    });
  }
  return out;
}
