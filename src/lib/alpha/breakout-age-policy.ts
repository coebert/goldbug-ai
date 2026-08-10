// Signal-age action mapping for breakout trades.
//
// Measured on 14 liquid US names, Dec 2016 -> Aug 2026, per-bar entries
// (4,091 episodes / 8,497 bar-level observations) with the live detector and
// the live 2 ATR stop / 3 ATR target / 10-bar horizon:
//
//   confirmed, entered at age 2-3 bars   n=1084   -0.29% / trade
//   confirmed, entered at age 4-6 bars   n= 130   -0.86% / trade
//   confirmed, entered at age 7+ bars    n=   4   -0.65% / trade (thin)
//   expectancy decay vs age              -0.130% per bar
//
// and, cutting the same trades by how long the break took to resolve from
// its first "pending" bar:
//
//   pending -> confirmed in 1-2 bars     n=1084   -0.28% / trade
//   pending -> confirmed in 3-4 bars     n= 121   -0.94% / trade
//   pending -> failed    in 5+ bars      n=  28   -0.92% / trade
//
// Two facts fall out and both are actionable at decision time, because the
// only timing input the live detector exposes is `bars_since_breakout`:
//
//   1. Freshness is the edge. Every extra bar of age costs ~0.13%/trade, and
//      a break that took several bars to confirm is roughly three times worse
//      than one that snapped shut immediately. A slow confirmation IS an old
//      signal, so age captures both.
//   2. Beyond three bars there is nothing left to chase. The 4-6 band is
//      measured clearly negative on an adequate sample, so it is vetoed
//      rather than merely trimmed, and anything older inherits the veto.
//
// The realised-hold cut is included for completeness: trades that exited
// inside 5 bars averaged -1.2% to -2.7% while those that ran 6-10 bars
// averaged +0.3%. Losses are concentrated in early stop-outs, not in patient
// holds, which is why the breakout hold guidance is a minimum, not a target.
//
// Pure module: evidence in, decision out. No I/O, no clock.

import type { BreakoutEvidence } from "./breakout";

export type BreakoutAgeBand = {
  /** Inclusive age range, in bars the break has held beyond the level. */
  minAgeBars: number;
  /** Inclusive upper bound; Infinity for the tail band. */
  maxAgeBars: number;
  /** Size multiplier applied to a breakout-driven buy in this band. */
  mult: number;
  /** True when the band is not tradeable at all. */
  veto: boolean;
  /** Sample size behind the band in the study. */
  trades: number;
  /** Measured mean per-trade edge, in % net of costs. */
  expectancyPct: number;
  label: string;
};

export type BreakoutAgePolicy = {
  source: string;
  asOf: string | null;
  /** Ordered, non-overlapping, exhaustive bands. */
  bands: BreakoutAgeBand[];
  /**
   * Minimum bars a breakout-driven position should be given before a
   * discretionary (non-stop) exit — early exits are where the losses sit.
   */
  minHoldBars: number;
  /** Realised hold band with the best measured expectancy. */
  bestHoldBars: [number, number];
};

export const DEFAULT_BREAKOUT_AGE_POLICY: BreakoutAgePolicy = {
  source: "breakout timing study 2026-08 (14 symbols, Dec 2016 - Aug 2026, per-bar ages)",
  asOf: "2026-08-10",
  bands: [
    {
      minAgeBars: 0,
      maxAgeBars: 1,
      mult: 1,
      veto: false,
      trades: 2078,
      expectancyPct: -0.14,
      label: "fresh break",
    },
    {
      minAgeBars: 2,
      maxAgeBars: 3,
      mult: 0.85,
      veto: false,
      trades: 1084,
      expectancyPct: -0.29,
      label: "just confirmed",
    },
    {
      minAgeBars: 4,
      maxAgeBars: 6,
      mult: 0,
      veto: true,
      trades: 130,
      expectancyPct: -0.86,
      label: "late chase",
    },
    {
      minAgeBars: 7,
      maxAgeBars: Infinity,
      mult: 0,
      veto: true,
      trades: 4,
      expectancyPct: -0.65,
      label: "stale",
    },
  ],
  minHoldBars: 6,
  bestHoldBars: [6, 10],
};

export type BreakoutAgeDecision = {
  /** Multiplier this layer contributes (1 = no opinion). */
  mult: number;
  /** True when the age layer alone blocks the trade. */
  veto: boolean;
  ageBars: number;
  band: BreakoutAgeBand | null;
  applies: boolean;
  reason: string;
};

export function ageBandFor(
  ageBars: number,
  policy: BreakoutAgePolicy = DEFAULT_BREAKOUT_AGE_POLICY,
): BreakoutAgeBand | null {
  return policy.bands.find((b) => ageBars >= b.minAgeBars && ageBars <= b.maxAgeBars) ?? null;
}

/**
 * Score a breakout-driven buy on signal age alone.
 *
 * Only chases are gated: an upside break being bought, in a state the engine
 * would size up (`pending` / `confirmed`). Sells, downside evidence and
 * non-breakout trades pass through untouched with mult 1.
 */
export function breakoutAgeAction(input: {
  breakout: BreakoutEvidence | null | undefined;
  side: "buy" | "sell";
  policy?: BreakoutAgePolicy;
}): BreakoutAgeDecision {
  const policy = input.policy ?? DEFAULT_BREAKOUT_AGE_POLICY;
  const b = input.breakout;
  const pass = (reason: string): BreakoutAgeDecision => ({
    mult: 1,
    veto: false,
    ageBars: b?.bars_since_breakout ?? 0,
    band: null,
    applies: false,
    reason,
  });

  if (input.side === "sell") return pass("sells are not age-gated");
  if (!b || b.direction !== "up") return pass("not an upside breakout chase");
  if (b.state !== "confirmed" && b.state !== "pending" && b.state !== "extended") {
    return pass(`state ${b?.state ?? "none"} is not a chase`);
  }

  const ageBars = Math.max(0, Math.round(b.bars_since_breakout ?? 0));
  const band = ageBandFor(ageBars, policy);
  if (!band) return pass("no age band matched");

  return {
    mult: band.veto ? 0 : band.mult,
    veto: band.veto,
    ageBars,
    band,
    applies: true,
    reason: band.veto
      ? `break is ${ageBars} bars old (${band.label}) — measured ${band.expectancyPct.toFixed(2)}%/trade on n=${band.trades}, not chased`
      : `break is ${ageBars} bars old (${band.label}) — size x${band.mult.toFixed(2)}`,
  };
}

/** Minimum sensible hold for a breakout-driven entry, in trading bars. */
export function breakoutMinHoldBars(
  policy: BreakoutAgePolicy = DEFAULT_BREAKOUT_AGE_POLICY,
): number {
  return policy.minHoldBars;
}

/** Build a live policy from a measured timing study's recommendation. */
export function agePolicyFromRecommendation(
  rules: readonly {
    minAgeBars: number;
    maxAgeBars: number;
    mult: number;
    veto: boolean;
    trades: number;
    expectancyPct: number;
  }[],
  meta: { source: string; asOf?: string | null; minHoldBars?: number; bestHoldBars?: [number, number] },
): BreakoutAgePolicy {
  return {
    source: meta.source,
    asOf: meta.asOf ?? null,
    bands: rules
      .slice()
      .sort((a, b) => a.minAgeBars - b.minAgeBars)
      .map((r) => ({
        minAgeBars: r.minAgeBars,
        maxAgeBars: r.maxAgeBars,
        mult: r.veto ? 0 : r.mult,
        veto: r.veto,
        trades: r.trades,
        expectancyPct: r.expectancyPct,
        label: `age ${r.minAgeBars}-${Number.isFinite(r.maxAgeBars) ? r.maxAgeBars : "+"}`,
      })),
    minHoldBars: meta.minHoldBars ?? DEFAULT_BREAKOUT_AGE_POLICY.minHoldBars,
    bestHoldBars: meta.bestHoldBars ?? DEFAULT_BREAKOUT_AGE_POLICY.bestHoldBars,
  };
}
