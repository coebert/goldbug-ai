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
import { liquidityFrictions, scaleLiquidity, type LiquidityProfile } from "./liquidity-profile";
import {
  computeCommission,
  scaleCommissionModel,
  SCALING_COMMISSION_MODEL,
  type CommissionModel,
} from "./commission-model";
import type { AssetClass } from "./universe.server";

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
  /** Liquidity assumption this scenario was built with, when varied. */
  liquidity?: LiquiditySpec;
  /** Commission schedule this scenario was built with, when varied. */
  commission?: CommissionSpec;
};

/**
 * One point on the commission axis.
 *
 * The sweep used to assume a single flat rate + floor for every asset, which
 * is wrong in both directions: it over-charges large US tickets (which are
 * really per-share) and under-charges small LSE ones (which are floored), and
 * it cannot express volume-tier discounts at all. A spec instead names a
 * tiered `CommissionModel` (venue schedules, per-asset overrides, breakpoints)
 * plus the trailing monthly volume that selects the discount tier.
 *
 * `flat` keeps the legacy behaviour available as an explicit comparison arm.
 */
export type CommissionSpec = {
  label: string;
  model?: CommissionModel;
  /** Trailing 30-day traded notional selecting the volume-discount tier. */
  monthlyVolume?: number;
  currencyBySymbol?: Record<string, string>;
  assetClassBySymbol?: Record<string, AssetClass>;
  /** Legacy flat schedule; when set the tiered model is not used. */
  flat?: { commissionBps: number; minCommission: number };
};

/**
 * Default commission axis: the legacy flat assumption kept for reference,
 * then the tiered model at each volume breakpoint. Ranking across these makes
 * the "which schedule does this rule need to survive?" question explicit.
 */
export const DEFAULT_COMMISSION_SPECS: CommissionSpec[] = [
  { label: "flat 8bps/£3", flat: { commissionBps: 8, minCommission: 3 } },
  { label: "tiered classic", model: SCALING_COMMISSION_MODEL, monthlyVolume: 0 },
  { label: "tiered platinum", model: SCALING_COMMISSION_MODEL, monthlyVolume: 250_000 },
  { label: "tiered vip", model: SCALING_COMMISSION_MODEL, monthlyVolume: 1_000_000 },
];

/**
 * Apply a commission spec to a friction model. A tiered spec REPLACES the
 * flat pair (the simulator ignores `commissionBps`/`minCommission` whenever
 * `commission` is present), so both are never charged at once.
 */
export function applyCommissionSpec(base: Frictions, spec: CommissionSpec): Frictions {
  if (spec.flat) {
    const { commission: _drop, ...rest } = base;
    return {
      ...rest,
      commissionBps: spec.flat.commissionBps,
      minCommission: spec.flat.minCommission,
    };
  }
  const { commissionBps: _bps, minCommission: _min, ...rest } = base;
  return {
    ...rest,
    commission: {
      ...(spec.model ? { model: spec.model } : { model: SCALING_COMMISSION_MODEL }),
      ...(spec.monthlyVolume !== undefined ? { monthlyVolume: spec.monthlyVolume } : {}),
      ...(spec.currencyBySymbol ? { currencyBySymbol: spec.currencyBySymbol } : {}),
      ...(spec.assetClassBySymbol ? { assetClassBySymbol: spec.assetClassBySymbol } : {}),
    },
  };
}

/**
 * A representative instrument used when expressing costs in bps. Tiered
 * schedules differ per venue and asset class, so a single "the ticket costs
 * N bps" number is only meaningful against a stated instrument mix.
 */
export type CostContext = {
  symbol?: string;
  currency?: string;
  assetClass?: AssetClass;
  /** Unit price — drives the per-share component on US-style schedules. */
  unitPrice?: number;
};


/**
 * One point on the liquidity axis. `advScale` multiplies every symbol's
 * measured average daily traded value: 1 = the tape's own liquidity,
 * 0.25 = books a quarter as deep (equivalently, tickets 4x larger
 * relative to the book), 4 = mega-cap depth.
 *
 * When a liquidity spec is attached the simulator estimates spread and
 * slippage PER FILL from participation vs ADV instead of using a flat
 * bps assumption, so the same ticket costs more in thin names.
 */
export type LiquiditySpec = {
  label: string;
  advScale: number;
  /** Optional extra multiplier on the modelled per-side bps. */
  costScale?: number;
  urgency?: "passive" | "normal" | "aggressive";
};

/** Sensible default depth axis: thin → deep. */
export const DEFAULT_LIQUIDITY_SPECS: LiquiditySpec[] = [
  { label: "thin 0.25x ADV", advScale: 0.25 },
  { label: "as-traded ADV", advScale: 1 },
  { label: "deep 4x ADV", advScale: 4 },
];

/**
 * Attach the liquidity-aware execution model to a friction set, replacing
 * the flat slippage terms (the simulator ignores them when
 * `liquidity` is present).
 */
export function applyLiquidity(
  base: Frictions,
  spec: LiquiditySpec,
  profile: LiquidityProfile,
): Frictions {
  if (!Number.isFinite(spec.advScale) || spec.advScale <= 0) {
    throw new Error(`applyLiquidity: invalid advScale ${spec.advScale}`);
  }
  const scaled = scaleLiquidity(profile, spec.advScale);
  return {
    ...base,
    liquidity: liquidityFrictions(scaled, {
      ...(spec.costScale !== undefined ? { costScale: spec.costScale } : {}),
      ...(spec.urgency ? { urgency: spec.urgency } : {}),
    }),
  };
}


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
 * Full cost grid: commission scale × slippage spec × minimum fee ×
 * liquidity × commission schedule. The commission scale still multiplies
 * every baseline term (including every tier of a tiered schedule), but the
 * slippage, minimum-fee, liquidity and schedule overrides are applied
 * afterwards so those axes are exactly the values requested rather than
 * scaled derivatives.
 *
 * A liquidity axis requires `liquidityProfile`; when present it replaces
 * the flat slippage terms with the participation-aware model.
 */
export function buildCostGrid(
  base: Frictions,
  opts: {
    scales: number[];
    slippage?: SlippageSpec[];
    minCommission?: number[];
    liquidity?: LiquiditySpec[];
    liquidityProfile?: LiquidityProfile;
    commission?: CommissionSpec[];
  },
): CostScenario[] {
  const slippages = opts.slippage?.length ? opts.slippage : [null];
  const minFees = opts.minCommission?.length ? opts.minCommission : [null];
  const liquidities = opts.liquidity?.length ? opts.liquidity : [null];
  const commissions = opts.commission?.length ? opts.commission : [null];
  if (opts.liquidity?.length && !opts.liquidityProfile) {
    throw new Error("buildCostGrid: liquidity axis requires a liquidityProfile");
  }
  const out: CostScenario[] = [];
  for (const scale of opts.scales) {
    for (const spec of slippages) {
      for (const minFee of minFees) {
        for (const liq of liquidities) {
          for (const comm of commissions) {
            // The schedule is chosen first, then the whole model is scaled,
            // so a tiered spec is scaled tier-by-tier rather than having a
            // flat multiplier bolted on afterwards.
            let frictions = scaleFrictions(comm ? applyCommissionSpec(base, comm) : base, scale);

            if (spec) frictions = applySlippage(frictions, spec);
            // A tiered schedule has its own per-tier floors; an explicit
            // min-fee axis only applies to the flat pair.
            if (minFee !== null && !frictions.commission) {
              frictions = applyMinCommission(frictions, minFee);
            }
            if (liq) {
              // Keep the commission scale meaningful for the liquidity model:
              // it multiplies the modelled per-side bps, not ADV.
              frictions = applyLiquidity(
                frictions,
                { ...liq, costScale: (liq.costScale ?? 1) * scale },
                opts.liquidityProfile!,
              );
            }
            const parts = [scale === 1 ? "baseline" : `${(scale * 100).toFixed(0)}% cost`];
            if (comm) parts.push(comm.label);
            if (spec) parts.push(spec.label);
            if (minFee !== null && !frictions.commission) parts.push(`min £${minFee}`);
            if (liq) parts.push(liq.label);
            out.push({
              label: parts.join(" · "),
              scale,
              frictions,
              ...(spec ? { slippage: spec } : {}),
              ...(minFee !== null ? { minCommission: minFee } : {}),
              ...(liq ? { liquidity: liq } : {}),
              ...(comm ? { commission: comm } : {}),
            });
          }
        }
      }
    }
  }
  return out;
}

/** Stable identity for a scenario, safe as a map key across all five axes. */
export function scenarioKey(sc: CostScenario): string {
  return [
    sc.scale,
    sc.slippage?.label ?? "-",
    sc.minCommission ?? "-",
    sc.liquidity?.label ?? "-",
    sc.commission?.label ?? "-",
  ].join("|");
}

/** Scale only the tiered commission schedule of a friction model. */
export function scaleCommissionFrictions(base: Frictions, scale: number): Frictions {
  if (!base.commission) return base;
  const model = base.commission.model ?? SCALING_COMMISSION_MODEL;
  return {
    ...base,
    commission: { ...base.commission, model: scaleCommissionModel(model, scale) },
  };
}

/**
 * Scale a friction model. All cost terms move together so a single
 * "cost scale" axis is meaningful: 1.0 = today's Saxo-like assumptions,
 * 0.25 = a quarter of those costs, 0 = frictionless. A tiered commission
 * schedule is scaled tier-by-tier so its shape (breakpoints, per-asset
 * routing, discount ladder) survives the scaling.
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
    // The liquidity model rides the same cost axis via its bps multiplier
    // (ADV itself is a market property and must not be scaled here).
    ...(base.liquidity
      ? { liquidity: { ...base.liquidity, costScale: (base.liquidity.costScale ?? 1) * scale } }
      : {}),
    ...(base.commission
      ? {
          commission: {
            ...base.commission,
            model: scaleCommissionModel(
              base.commission.model ?? SCALING_COMMISSION_MODEL,
              scale,
            ),
          },
        }
      : {}),
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

/** Per-side commission charged on one ticket, in trade currency. */
export function commissionPerSide(
  frictions: Frictions,
  ticketValue: number,
  ctx?: CostContext,
): number {
  if (frictions.commission) {
    const c = frictions.commission;
    const symbol = ctx?.symbol ?? "";
    const currency = ctx?.currency ?? c.currencyBySymbol?.[symbol];
    const assetClass = ctx?.assetClass ?? c.assetClassBySymbol?.[symbol];
    const unitPrice = ctx?.unitPrice;
    return computeCommission({
      notional: ticketValue,
      quantity: unitPrice && unitPrice > 0 ? ticketValue / unitPrice : 0,
      symbol,
      ...(currency ? { currency } : {}),
      ...(assetClass ? { assetClass } : {}),
      ...(c.monthlyVolume !== undefined ? { monthlyVolume: c.monthlyVolume } : {}),
      ...(c.model ? { model: c.model } : {}),
    }).commission;
  }
  const bps = frictions.commissionBps ?? 0;
  const min = frictions.minCommission ?? 0;
  return Math.max((bps / 10_000) * ticketValue, min);
}

/**
 * All-in round-trip cost of one position, in basis points of notional,
 * for a given ticket value. With a tiered schedule the commission comes
 * from the venue/asset tier that this notional actually lands in (floor,
 * per-share component, cap and volume discount included); with the legacy
 * flat pair it is the greater of the bps rate and the fixed minimum —
 * which is exactly why small tickets are lethal.
 */
export function roundTripCostBps(
  frictions: Frictions,
  ticketValue: number,
  ctx?: CostContext,
): number {
  if (!(ticketValue > 0)) return Number.POSITIVE_INFINITY;
  const commission = commissionPerSide(frictions, ticketValue, ctx);
  const slippagePerSide = ((frictions.slippageBps ?? 0) / 10_000) * ticketValue;
  const buyTax = ((frictions.buyTaxBps ?? 0) / 10_000) * ticketValue;
  const total = 2 * commission + 2 * slippagePerSide + buyTax;
  return (total / ticketValue) * 10_000;
}

/**
 * Round-trip cost averaged over an instrument mix. Tiered schedules charge
 * differently per venue and asset class, so a portfolio-level bps number is
 * only honest as a mean over the names actually traded.
 */
export function blendedRoundTripBps(
  frictions: Frictions,
  ticketValue: number,
  contexts: readonly CostContext[],
): number {
  if (contexts.length === 0) return roundTripCostBps(frictions, ticketValue);
  const vals = contexts.map((c) => roundTripCostBps(frictions, ticketValue, c));
  const finite = vals.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return Number.POSITIVE_INFINITY;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
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
    /** Commission schedule held fixed across the series, when swept. */
    fixedCommission?: CommissionSpec;
    /** Instrument mix used to price a tiered schedule in bps. */
    costContexts?: readonly CostContext[];
  } = {},
): BreakevenResult {
  const target = opts.target ?? "zero";
  const sorted = [...cells].sort((a, b) => a.scenario.scale - b.scenario.scale);
  if (sorted.length === 0) return { scale: null, verdict: "never", roundTripBps: null };

  const bpsAt = (scale: number): number | null => {
    if (!opts.baseFrictions || opts.ticketValue === undefined) return null;
    const withSchedule = opts.fixedCommission
      ? applyCommissionSpec(opts.baseFrictions, opts.fixedCommission)
      : opts.baseFrictions;
    let f = scaleFrictions(withSchedule, scale);
    if (opts.fixedSlippage) f = applySlippage(f, opts.fixedSlippage);
    if (opts.fixedMinCommission !== undefined && !f.commission) {
      f = applyMinCommission(f, opts.fixedMinCommission);
    }
    return blendedRoundTripBps(f, opts.ticketValue, opts.costContexts ?? []);
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
 * series' own commission schedule, slippage and minimum-fee overrides
 * applied. Using this for the bps read-out keeps the breakeven answer
 * honest when the sweep varied those axes independently of the cost scale.
 */
export function seriesBaseFrictions(base: Frictions, sample: CostScenario | undefined): Frictions {
  if (!sample) return base;
  let f = sample.commission ? applyCommissionSpec(base, sample.commission) : base;
  if (sample.slippage) f = applySlippage(f, sample.slippage);
  if (sample.minCommission !== undefined && !f.commission) {
    f = applyMinCommission(f, sample.minCommission);
  }
  return f;
}

export type BreakevenGroup = {
  ticket: TicketSpec;
  style: string;
  riskLevel: string;
  slippageLabel: string;
  minCommission: number | null;
  /** Liquidity assumption for the series, when the axis was swept. */
  liquidityLabel: string | null;
  /** Commission schedule for the series, when the axis was swept. */
  commissionLabel: string | null;
  ticketValue: number;
  baselineRoundTripBps: number;
  vsZero: BreakevenResult;
  vsBenchmark: BreakevenResult;
};

/**
 * Breakeven per (risk, style, ticket, slippage, minimum fee, liquidity,
 * commission schedule) series — the cells within a group differ only by
 * cost scale, which is what `findBreakevenScale` interpolates over.
 */
export function breakevenGrid(
  cells: SweepCell[],
  opts: {
    baseFrictions: Frictions;
    startingCash: number;
    /** Instrument mix used to price tiered schedules in bps. */
    costContexts?: readonly CostContext[];
  },
): BreakevenGroup[] {
  const groups = new Map<string, SweepCell[]>();
  for (const c of cells) {
    const key = [
      c.riskLevel,
      c.style,
      c.ticket.label,
      c.scenario.slippage?.label ?? "-",
      c.scenario.minCommission ?? "-",
      c.scenario.liquidity?.label ?? "-",
      c.scenario.commission?.label ?? "-",
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
    const contexts = opts.costContexts ?? [];
    const fixed = {
      ...(first.scenario.slippage ? { fixedSlippage: first.scenario.slippage } : {}),
      ...(first.scenario.minCommission !== undefined
        ? { fixedMinCommission: first.scenario.minCommission }
        : {}),
      ...(first.scenario.commission ? { fixedCommission: first.scenario.commission } : {}),
      ...(contexts.length ? { costContexts: contexts } : {}),
    };
    out.push({
      ticket: first.ticket,
      style: first.style,
      riskLevel: first.riskLevel,
      slippageLabel: first.scenario.slippage?.label ?? "baseline",
      minCommission: first.scenario.minCommission ?? null,
      liquidityLabel: first.scenario.liquidity?.label ?? null,
      commissionLabel: first.scenario.commission?.label ?? null,
      ticketValue: tv,
      baselineRoundTripBps: blendedRoundTripBps(seriesBase, tv, contexts),
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
