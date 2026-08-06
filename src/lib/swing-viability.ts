// Swing-trading viability gate.
//
// Swing trading only pays when the round-trip execution cost of a typical
// ticket is small relative to the edge a days-to-weeks hold can realistically
// capture. The cost-sweep work showed the breakeven is driven almost entirely
// by ticket size: fixed commission minimums (and UK stamp duty) dominate small
// tickets, so a £600 ticket pays multiples of the headline rate while a
// £5,000 ticket pays close to it.
//
// This module is PURE and client-safe. It decides whether the swing profile is
// financially viable for a given account size / ticket size, and downgrades
// the risk config back to "position" when it is not. The engine calls it every
// tick so the answer tracks equity, the risk dial and the venue.

import { estimateSaxoCommission, inferSaxoCurrency } from "./saxo-fees";
import type { RiskConfig } from "./universe.server";

export type SwingViabilityInput = {
  /** Total portfolio equity in the account currency. */
  equity: number;
  /** Fraction of equity a single position may take (0..1). */
  perSymbolPct: number;
  /** Account / venue currency used to pick the Saxo fee tier. */
  currency?: string | null;
  /** Representative symbol, used to infer the currency when not given. */
  symbol?: string | null;
  /** Per-side slippage + half-spread assumption, in bps. */
  slippageBpsPerSide?: number;
  /** Buy-side transaction tax in bps (UK stamp duty = 50bps on GBP shares). */
  transactionTaxBps?: number;
  /**
   * Gross edge, in bps of notional, a swing round trip is expected to capture
   * after win rate is taken into account. Deliberately conservative.
   */
  expectedEdgeBps?: number;
  /** Max share of the expected edge that execution cost may consume (0..1). */
  maxCostShareOfEdge?: number;
};

export type SwingViability = {
  viable: boolean;
  /** Notional of a typical single position. */
  ticket: number;
  /** All-in round-trip cost (commission both sides + slippage + tax), bps. */
  roundTripBps: number;
  /** Cost budget implied by the expected edge, bps. */
  budgetBps: number;
  /** budget − cost. Negative means swing is uneconomic. */
  headroomBps: number;
  /** Cost as a share of the expected edge (0..1+). */
  costShareOfEdge: number;
  /** Smallest ticket at which swing becomes viable, in account currency. */
  minViableTicket: number;
  /** Equity needed for a viable ticket at the current per-symbol cap. */
  minViableEquity: number;
  currency: string;
  reason: string;
};

/** Conservative defaults derived from the cost-sweep / sensitivity studies. */
export const SWING_VIABILITY_DEFAULTS = {
  slippageBpsPerSide: 5,
  expectedEdgeBps: 150,
  maxCostShareOfEdge: 0.25,
} as const;

/** UK share purchases pay 0.5% stamp duty on the buy side. */
export function transactionTaxBpsFor(currency: string): number {
  return currency.toUpperCase() === "GBP" ? 50 : 0;
}

function allInRoundTripBps(
  ticket: number,
  currency: string,
  slippageBpsPerSide: number,
  taxBps: number,
): number {
  if (!(ticket > 0)) return Number.POSITIVE_INFINITY;
  const fee = estimateSaxoCommission({ notional: ticket, currency });
  return fee.roundTripBps + slippageBpsPerSide * 2 + taxBps;
}

export function assessSwingViability(input: SwingViabilityInput): SwingViability {
  const currency = (
    input.currency ?? (input.symbol ? inferSaxoCurrency(input.symbol) : "GBP")
  ).toUpperCase();
  const slip = Math.max(0, input.slippageBpsPerSide ?? SWING_VIABILITY_DEFAULTS.slippageBpsPerSide);
  const taxBps = input.transactionTaxBps ?? transactionTaxBpsFor(currency);
  const edge = Math.max(1, input.expectedEdgeBps ?? SWING_VIABILITY_DEFAULTS.expectedEdgeBps);
  const share = Math.min(
    1,
    Math.max(0.01, input.maxCostShareOfEdge ?? SWING_VIABILITY_DEFAULTS.maxCostShareOfEdge),
  );
  const budgetBps = edge * share;

  const equity = Math.max(0, Number(input.equity) || 0);
  const pct = Math.min(1, Math.max(0, Number(input.perSymbolPct) || 0));
  const ticket = equity * pct;

  const roundTripBps = allInRoundTripBps(ticket, currency, slip, taxBps);
  const costShareOfEdge = roundTripBps / edge;
  const headroomBps = budgetBps - roundTripBps;

  // Smallest ticket clearing the budget. Costs fall monotonically with ticket
  // size (fixed floor amortised), so a bisection over a wide bracket is exact
  // enough for a threshold readout.
  const minViableTicket = (() => {
    const floorCost = allInRoundTripBps(1e9, currency, slip, taxBps);
    if (floorCost > budgetBps) return Number.POSITIVE_INFINITY; // never viable
    let lo = 1;
    let hi = 1e9;
    if (allInRoundTripBps(lo, currency, slip, taxBps) <= budgetBps) return lo;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (allInRoundTripBps(mid, currency, slip, taxBps) <= budgetBps) hi = mid;
      else lo = mid;
    }
    return Math.ceil(hi);
  })();

  const minViableEquity = pct > 0 ? minViableTicket / pct : Number.POSITIVE_INFINITY;
  const viable = ticket > 0 && roundTripBps <= budgetBps;

  const money = (v: number) =>
    Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")}` : "∞";

  const reason = viable
    ? `swing viable: ${money(ticket)} ${currency} ticket costs ${roundTripBps.toFixed(0)}bps round trip vs a ${budgetBps.toFixed(0)}bps budget (${(costShareOfEdge * 100).toFixed(0)}% of expected edge)`
    : ticket <= 0
      ? "swing not viable: no investable ticket (zero equity or per-symbol cap)"
      : `swing not viable: ${money(ticket)} ${currency} ticket costs ${roundTripBps.toFixed(0)}bps round trip vs a ${budgetBps.toFixed(0)}bps budget — needs a ${money(minViableTicket)} ${currency} ticket (~${money(minViableEquity)} equity at the current per-symbol cap)`;

  return {
    viable,
    ticket,
    roundTripBps,
    budgetBps,
    headroomBps,
    costShareOfEdge,
    minViableTicket,
    minViableEquity,
    currency,
    reason,
  };
}

export type SwingGateResult = {
  cfg: RiskConfig;
  /** True when the config asked for swing but the gate forced position. */
  downgraded: boolean;
  /** Null when the config was not in swing mode (nothing to assess). */
  viability: SwingViability | null;
};

/**
 * Enforce the gate: a config in swing mode stays in swing mode only while the
 * economics hold. Otherwise it is downgraded to "position" (longer holds,
 * fewer round trips) with the swing-specific churn/time-stop fields cleared.
 */
export function applySwingViabilityGate(
  cfg: RiskConfig,
  input: SwingViabilityInput,
): SwingGateResult {
  if (cfg.trading_style !== "swing") return { cfg, downgraded: false, viability: null };
  const viability = assessSwingViability(input);
  if (viability.viable) return { cfg, downgraded: false, viability };
  return {
    cfg: {
      ...cfg,
      trading_style: "position",
      swing_min_hold_days: 0,
    },
    downgraded: true,
    viability,
  };
}
