// Configurable execution assumptions for every backtest.
//
// Backtests are only as honest as the friction they charge. Until now each
// replay hard-coded its own view of the world: `estimateTradeCosts` assumed a
// 10bps quoted spread and full Saxo commission, `cost-scenarios` carried three
// fixed best/base/worst cases, and the governor replay charged neither
// slippage nor market impact. This module makes those assumptions one
// explicit, shareable, overridable object so a run can be re-priced against
// tighter or nastier execution without touching engine code.
//
// Every field is a knob a real desk argues about:
//
//   fees      — commission multiplier, an explicit per-ticket floor override,
//               UK stamp duty multiplier, PTM levy on/off
//   spread    — the FULL quoted spread in bps (we cross half of it per side),
//               plus an optional per-symbol override table for names whose
//               book is much tighter or wider than the default
//   slippage  — a fixed adverse-move toll per side, plus a size-dependent
//               square-root impact term (bps at a reference participation)
//               and a delay/urgency toll for orders that miss the touch
//   fx        — the spread paid on the funding leg of a foreign-currency buy
//
// Pure, deterministic and I/O-free.

import { estimateTradeCosts } from "../trade-viability-gate";

export type ExecutionAssumptions = {
  /** Multiplier on modelled Saxo commission (1 = the live tier schedule). */
  commissionMult: number;
  /**
   * Per-ticket commission floor in base currency. `null` keeps the venue
   * minimum the live fee model derives; a number replaces it (useful for
   * modelling a renegotiated tariff or a zero-commission venue).
   */
  commissionFloorBase: number | null;
  /** Multiplier on UK stamp duty. 0 models a fully stamp-exempt book. */
  stampMult: number;
  /** Charge the £1 PTM levy above its threshold. */
  ptmLevy: boolean;
  /** Full quoted spread in bps; half is crossed per side. */
  spreadBps: number;
  /** Per-symbol full-spread overrides, keyed by uppercase symbol. */
  spreadBpsBySymbol?: Record<string, number>;
  /** Fixed adverse slippage per side, bps of notional. */
  slippageBps: number;
  /**
   * Size-dependent impact: `impactBps` charged when the ticket equals
   * `impactRefNotionalBase`, scaled by the square root of the size ratio.
   * Set `impactBps: 0` to switch impact off.
   */
  impactBps: number;
  impactRefNotionalBase: number;
  /** Extra toll for orders that do not get filled at the touch, bps. */
  delayBps: number;
  /** Spread paid converting cash for a foreign-currency ticket, bps. */
  fxSpreadBps: number;
};

export type ExecutionAssumptionsInput = Partial<ExecutionAssumptions>;

/**
 * The live estimator's view, expressed as assumptions: Saxo tiered commission
 * with its floor, 10bps quoted spread, full stamp duty, no explicit slippage
 * or impact. Any replay that passes nothing behaves exactly as before.
 */
export const LIVE_MODEL_ASSUMPTIONS: ExecutionAssumptions = {
  commissionMult: 1,
  commissionFloorBase: null,
  stampMult: 1,
  ptmLevy: true,
  spreadBps: 10,
  slippageBps: 0,
  impactBps: 0,
  impactRefNotionalBase: 10_000,
  delayBps: 0,
  fxSpreadBps: 0,
};

/**
 * Named presets. `realistic` is the recommended default for new work: it keeps
 * the live fee schedule but charges the slippage, impact and FX spread the
 * broker cost ingestion actually observed, so a backtest's friction lands in
 * the same range as the invoiced 15-23bps per £1k ticket.
 */
export const ASSUMPTION_PRESETS = {
  frictionless: {
    ...LIVE_MODEL_ASSUMPTIONS,
    commissionMult: 0,
    stampMult: 0,
    ptmLevy: false,
    spreadBps: 0,
  },
  optimistic: {
    ...LIVE_MODEL_ASSUMPTIONS,
    spreadBps: 4,
    stampMult: 0,
    slippageBps: 0,
    impactBps: 2,
    fxSpreadBps: 2,
  },
  live: LIVE_MODEL_ASSUMPTIONS,
  realistic: {
    ...LIVE_MODEL_ASSUMPTIONS,
    spreadBps: 14,
    slippageBps: 3,
    impactBps: 6,
    delayBps: 1,
    fxSpreadBps: 5,
  },
  pessimistic: {
    ...LIVE_MODEL_ASSUMPTIONS,
    commissionMult: 1.25,
    spreadBps: 30,
    slippageBps: 8,
    impactBps: 15,
    delayBps: 4,
    fxSpreadBps: 12,
  },
} as const satisfies Record<string, ExecutionAssumptions>;

export type AssumptionPresetId = keyof typeof ASSUMPTION_PRESETS;

/**
 * What a backtest gets when the caller expresses no opinion. Nobody should
 * have to pick a preset to get an honest answer, and `live` (no slippage, no
 * impact, no FX spread) flatters every result — so unspecified runs price
 * against `realistic`. Server-side callers can do better still by awaiting
 * `loadAutoAssumptions()`, which calibrates these fields from our own bars,
 * invoiced fees and realised fills.
 */
export const DEFAULT_BACKTEST_PRESET: AssumptionPresetId = "realistic";

export const ASSUMPTION_PRESET_IDS = Object.keys(
  ASSUMPTION_PRESETS,
) as AssumptionPresetId[];

const clampNonNeg = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

/**
 * Build a complete, sane assumption set from a preset plus overrides. Invalid
 * or negative numbers fall back to the base value rather than poisoning a run
 * with NaN friction.
 */
export function resolveAssumptions(
  input?: ExecutionAssumptionsInput | AssumptionPresetId,
  preset: AssumptionPresetId = "live",
): ExecutionAssumptions {
  if (typeof input === "string") return { ...ASSUMPTION_PRESETS[input] };
  const base = ASSUMPTION_PRESETS[preset];
  const o = input ?? {};
  return {
    commissionMult: clampNonNeg(o.commissionMult, base.commissionMult),
    commissionFloorBase:
      o.commissionFloorBase === null
        ? null
        : typeof o.commissionFloorBase === "number" &&
            Number.isFinite(o.commissionFloorBase) &&
            o.commissionFloorBase >= 0
          ? o.commissionFloorBase
          : base.commissionFloorBase,
    stampMult: clampNonNeg(o.stampMult, base.stampMult),
    ptmLevy: typeof o.ptmLevy === "boolean" ? o.ptmLevy : base.ptmLevy,
    spreadBps: clampNonNeg(o.spreadBps, base.spreadBps),
    spreadBpsBySymbol: o.spreadBpsBySymbol
      ? Object.fromEntries(
          Object.entries(o.spreadBpsBySymbol)
            .filter(([, v]) => Number.isFinite(v) && v >= 0)
            .map(([k, v]) => [k.toUpperCase(), v]),
        )
      : base.spreadBpsBySymbol,
    slippageBps: clampNonNeg(o.slippageBps, base.slippageBps),
    impactBps: clampNonNeg(o.impactBps, base.impactBps),
    impactRefNotionalBase: Math.max(
      1,
      clampNonNeg(o.impactRefNotionalBase, base.impactRefNotionalBase),
    ),
    delayBps: clampNonNeg(o.delayBps, base.delayBps),
    fxSpreadBps: clampNonNeg(o.fxSpreadBps, base.fxSpreadBps),
  };
}

/** Full quoted spread for a symbol under these assumptions. */
export function spreadBpsFor(a: ExecutionAssumptions, symbol: string): number {
  return a.spreadBpsBySymbol?.[symbol.toUpperCase()] ?? a.spreadBps;
}

/** Square-root market impact for a ticket, in bps of notional. */
export function impactBpsFor(a: ExecutionAssumptions, notionalBase: number): number {
  if (a.impactBps <= 0 || !(notionalBase > 0)) return 0;
  return a.impactBps * Math.sqrt(notionalBase / a.impactRefNotionalBase);
}

export type PricedTicket = {
  notional: number;
  commission: number;
  stampDuty: number;
  ptmLevy: number;
  halfSpread: number;
  slippage: number;
  impact: number;
  delay: number;
  fxSpread: number;
  /** Everything above, in base currency, for this side only. */
  totalCost: number;
  totalBps: number;
  /** This side plus the modelled cost of the eventual closing side. */
  roundTripBps: number;
  /**
   * Price the fill is assumed to happen at: the bar close moved against us by
   * the half-spread, slippage, impact and delay tolls.
   */
  fillPrice: number;
};

export type TicketInput = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  assetClass?: string | null;
  /** True when the ticket needs an FX funding leg. */
  foreign?: boolean;
};

/**
 * Price one ticket under the given assumptions. Commission tiers, the fixed
 * floor and stamp-duty exemptions keep their real non-linear shape by
 * delegating to the live estimator and re-weighting its components, so a
 * multiplier of 1 with a 10bps spread reproduces production exactly.
 */
export function priceTicket(
  t: TicketInput,
  assumptions: ExecutionAssumptions,
): PricedTicket {
  const a = assumptions;
  const notional = Math.max(0, t.quantity) * Math.max(0, t.price);
  const spread = spreadBpsFor(a, t.symbol);
  const base = estimateTradeCosts({
    symbol: t.symbol,
    side: t.side,
    quantity: Math.max(0, t.quantity),
    price: Math.max(0, t.price),
    assetClass: t.assetClass ?? null,
    spreadBps: spread,
  });

  let commission = base.commission * a.commissionMult;
  if (a.commissionFloorBase !== null && notional > 0) {
    commission = Math.max(commission, a.commissionFloorBase);
  }
  const stampDuty = base.stampDuty * a.stampMult;
  const ptmLevy = a.ptmLevy ? base.ptmLevy : 0;
  const halfSpread = base.halfSpread;

  const slippage = (notional * a.slippageBps) / 10_000;
  const impact = (notional * impactBpsFor(a, notional)) / 10_000;
  const delay = (notional * a.delayBps) / 10_000;
  const fxSpread = t.foreign ? (notional * a.fxSpreadBps) / 10_000 : 0;

  const totalCost =
    commission + stampDuty + ptmLevy + halfSpread + slippage + impact + delay + fxSpread;
  const bps = (v: number) => (notional > 0 ? (v / notional) * 10_000 : 0);

  // The closing side pays everything again except stamp duty.
  const exitCost = totalCost - stampDuty;

  // Execution price: the market-facing tolls (not the taxes/commission) move
  // the price against us.
  const priceTollBps =
    spread / 2 + a.slippageBps + impactBpsFor(a, notional) + a.delayBps;
  const dir = t.side === "buy" ? 1 : -1;
  const fillPrice = Math.max(0, t.price * (1 + (dir * priceTollBps) / 10_000));

  return {
    notional,
    commission,
    stampDuty,
    ptmLevy,
    halfSpread,
    slippage,
    impact,
    delay,
    fxSpread,
    totalCost,
    totalBps: bps(totalCost),
    roundTripBps: bps(totalCost + exitCost),
    fillPrice,
  };
}

/** One-line description for reports and card subtitles. */
export function describeAssumptions(a: ExecutionAssumptions): string {
  const parts = [
    a.commissionMult === 1
      ? "Saxo tiered commission"
      : `${a.commissionMult.toFixed(2)}x commission`,
    a.commissionFloorBase !== null ? `£${a.commissionFloorBase} floor` : null,
    `${a.spreadBps}bps spread`,
    a.slippageBps > 0 ? `${a.slippageBps}bps slippage` : "no extra slippage",
    a.impactBps > 0
      ? `${a.impactBps}bps impact @ £${a.impactRefNotionalBase.toLocaleString("en-GB")}`
      : "no impact",
    a.delayBps > 0 ? `${a.delayBps}bps delay` : null,
    a.stampMult === 0 ? "stamp-exempt" : `${(a.stampMult * 0.5).toFixed(2)}% stamp`,
    a.fxSpreadBps > 0 ? `${a.fxSpreadBps}bps FX` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * Parse CLI-style overrides, e.g.
 * `--assumptions realistic --spread-bps 20 --slippage-bps 5 --no-stamp`.
 */
export function assumptionsFromFlags(argv: string[]): ExecutionAssumptions {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
    const inline = argv.find((x) => x.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : undefined;
  };
  const num = (name: string): number | undefined => {
    const raw = val(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const presetRaw = val("assumptions");
  // `auto` is resolved against live data by the caller; without that data it
  // degrades to the same realistic baseline every unflagged run gets.
  const preset: AssumptionPresetId =
    presetRaw && (ASSUMPTION_PRESET_IDS as string[]).includes(presetRaw)
      ? (presetRaw as AssumptionPresetId)
      : DEFAULT_BACKTEST_PRESET;

  return resolveAssumptions(
    {
      commissionMult: num("commission-mult"),
      commissionFloorBase: num("commission-floor"),
      stampMult: argv.includes("--no-stamp") ? 0 : num("stamp-mult"),
      ptmLevy: argv.includes("--no-ptm") ? false : undefined,
      spreadBps: num("spread-bps"),
      slippageBps: num("slippage-bps"),
      impactBps: num("impact-bps"),
      impactRefNotionalBase: num("impact-ref"),
      delayBps: num("delay-bps"),
      fxSpreadBps: num("fx-spread-bps"),
    },
    preset,
  );
}
