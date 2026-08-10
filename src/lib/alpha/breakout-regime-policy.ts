// Regime-specific action rule for breakout trades.
//
// The Aug-2026 backtest (10 liquid symbols, Dec 2023 -> Aug 2026, 574 signals)
// found that confirmed breakouts are NOT universally profitable: net of costs
// they averaged -0.80% per trade, and the only tape that paid was bear. So a
// blanket +20% size boost on "confirmed" is unearned. This module turns that
// finding into an executable rule:
//
//   * A breakout-motivated buy is only taken at full size when the CURRENT
//     regime has a measured positive expectancy for that cohort, on a sample
//     big enough to mean something.
//   * Sideways tape and high-volatility tape are treated as hostile by
//     construction — the boost is stripped and size is cut, regardless of
//     what the table says, because breakouts in chop are the classic fakeout.
//   * Measured-negative expectancy on an adequate sample vetoes the trade
//     outright: we don't chase a break the tape has already shown doesn't pay.
//
// Nothing here fires unless the trade is actually breakout-driven. A buy that
// happens to occur while some unrelated symbol is breaking out is untouched;
// the gate only reads the evidence attached to the symbol being bought.
//
// Pure module: table + inputs in, decision out. No I/O, no clock.

import type { BreakoutEvidence } from "./breakout";
import { breakoutSizeMultiplier } from "./breakout";
import {
  breakoutAgeAction,
  DEFAULT_BREAKOUT_AGE_POLICY,
  type BreakoutAgeDecision,
  type BreakoutAgePolicy,
} from "./breakout-age-policy";

/** Coarse regime buckets the expectancy table is keyed by. */
export type BreakoutRegimeBucket = "bull" | "bear" | "sideways";

/** Cohorts the rule can act on (the tradeable states). */
export type BreakoutCohortKey = "confirmed" | "pending" | "failed";

export type ExpectancyCell = {
  /** Number of historical trades behind the estimate. */
  trades: number;
  /** Mean per-trade edge, in % net of costs. */
  expectancyPct: number;
  /** Win rate in %, informational (the gate keys off expectancy). */
  winRatePct: number;
};

export type BreakoutExpectancyTable = {
  /** Where these numbers came from, surfaced in the decision note. */
  source: string;
  /** Last date covered by the study, if known. */
  asOf: string | null;
  cells: Partial<Record<BreakoutCohortKey, Partial<Record<BreakoutRegimeBucket, ExpectancyCell>>>>;
};

/**
 * Recorded evidence from the Aug-2026 breakout backtest. Confirmed breakouts
 * lost money in bull and sideways tape on a large sample; the bear cell is
 * directionally interesting but far too thin to act on.
 */
export const DEFAULT_BREAKOUT_EXPECTANCY: BreakoutExpectancyTable = {
  source: "breakout backtest 2026-08 (10 symbols, Dec 2023 - Aug 2026, 574 signals)",
  asOf: "2026-08-01",
  cells: {
    confirmed: {
      bull: { trades: 62, expectancyPct: -0.35, winRatePct: 45.2 },
      bear: { trades: 10, expectancyPct: -3.8, winRatePct: 40.0 },
      sideways: { trades: 40, expectancyPct: -1.6, winRatePct: 42.5 },
    },
    pending: {
      bull: { trades: 118, expectancyPct: 0.05, winRatePct: 50.0 },
      bear: { trades: 22, expectancyPct: 1.2, winRatePct: 54.5 },
      sideways: { trades: 74, expectancyPct: -0.9, winRatePct: 46.0 },
    },
    failed: {
      bull: { trades: 130, expectancyPct: -0.1, winRatePct: 39.2 },
      bear: { trades: 28, expectancyPct: 1.2, winRatePct: 46.4 },
      sideways: { trades: 90, expectancyPct: -0.6, winRatePct: 36.7 },
    },
  },
};

export type BreakoutRegimePolicyConfig = {
  /** Below this many historical trades a cell is "unproven", not "bad". */
  minTrades: number;
  /** Expectancy must clear this (in %) to count as genuinely positive. */
  minExpectancyPct: number;
  /** Size multiplier applied when the cell is unproven. */
  unprovenMult: number;
  /** Size multiplier applied in sideways tape (when not vetoed outright). */
  sidewaysMult: number;
  /** Size multiplier applied in high-vol tape (when not vetoed outright). */
  highVolMult: number;
  /** VIX at or above this = high vol. */
  vixHigh: number;
  /** VIX at or above this = too violent to chase a break at all. */
  vixVeto: number;
  /** 20d realised daily stdev at or above this = high vol. */
  realisedVolHigh: number;
};

export const DEFAULT_BREAKOUT_REGIME_POLICY: BreakoutRegimePolicyConfig = {
  minTrades: 25,
  minExpectancyPct: 0,
  unprovenMult: 0.7,
  sidewaysMult: 0.5,
  highVolMult: 0.5,
  vixHigh: 25,
  vixVeto: 32,
  realisedVolHigh: 0.015,
};

/** Map any regime dialect (detector labels, matrix labels) onto the table key. */
export function breakoutRegimeBucket(raw: string | null | undefined): BreakoutRegimeBucket {
  const key = String(raw ?? "").toLowerCase().replace(/\s+/g, "_").trim();
  switch (key) {
    case "bull":
    case "bull_quiet":
    case "bull_volatile":
    case "recovery":
    case "risk_on":
    case "trending":
      return "bull";
    case "bear":
    case "crisis":
    case "correction":
    case "risk_off":
      return "bear";
    default:
      // sideways, range_bound, low_vol, high_vol, unknown, anything unmapped:
      // treat as chop, which is the conservative branch.
      return "sideways";
  }
}

export type VolContext = {
  vix: number | null;
  /** 20-day stdev of daily returns (0.012 = 1.2%/day). */
  realisedVol20d: number | null;
};

export type BreakoutRegimeDecision = {
  action: "trade" | "downsize" | "skip";
  /** Final size multiplier to apply to the ticket (0 when skipped). */
  mult: number;
  /** Multiplier the raw evidence alone would have asked for. */
  rawMult: number;
  bucket: BreakoutRegimeBucket;
  cohort: BreakoutCohortKey | null;
  highVol: boolean;
  cell: ExpectancyCell | null;
  /** Signal-age layer: freshness decay and the stale-chase veto. */
  age: BreakoutAgeDecision;
  /** True when the trade is actually breakout-driven and the gate applies. */
  applies: boolean;
  reason: string;
  note: string;
};

function cohortOf(b: BreakoutEvidence | null | undefined): BreakoutCohortKey | null {
  if (!b) return null;
  if (b.state === "confirmed") return "confirmed";
  if (b.state === "pending") return "pending";
  if (b.state === "failed") return "failed";
  return null; // "none" / "extended" are not cohorts the table covers
}

function isHighVol(vol: VolContext, regime: string | null | undefined, cfg: BreakoutRegimePolicyConfig): boolean {
  const key = String(regime ?? "").toLowerCase();
  if (key === "crisis" || key === "high_vol" || key === "bull_volatile") return true;
  if (vol.vix != null && Number.isFinite(vol.vix) && vol.vix >= cfg.vixHigh) return true;
  if (
    vol.realisedVol20d != null &&
    Number.isFinite(vol.realisedVol20d) &&
    vol.realisedVol20d >= cfg.realisedVolHigh
  )
    return true;
  return false;
}

const PASS: Omit<BreakoutRegimeDecision, "bucket" | "rawMult" | "highVol" | "age"> = {
  action: "trade",
  mult: 1,
  cohort: null,
  cell: null,
  applies: false,
  reason: "not a breakout-driven trade",
  note: "",
};

/**
 * Decide whether a breakout-driven order may run, and at what size.
 *
 * `side` is the order side: only buys are gated (a sell is a de-risking
 * action and must never be blocked by an alpha rule).
 */
export function breakoutRegimeAction(input: {
  breakout: BreakoutEvidence | null | undefined;
  side: "buy" | "sell";
  regime: string | null | undefined;
  vol?: VolContext;
  table?: BreakoutExpectancyTable;
  config?: Partial<BreakoutRegimePolicyConfig>;
  /** Signal-age mapping; defaults to the measured Aug-2026 study. */
  agePolicy?: BreakoutAgePolicy;
}): BreakoutRegimeDecision {
  const cfg = { ...DEFAULT_BREAKOUT_REGIME_POLICY, ...input.config };
  const table = input.table ?? DEFAULT_BREAKOUT_EXPECTANCY;
  const vol: VolContext = input.vol ?? { vix: null, realisedVol20d: null };
  const bucket = breakoutRegimeBucket(input.regime);
  const highVol = isHighVol(vol, input.regime, cfg);
  const raw = breakoutSizeMultiplier(input.breakout, input.side);
  const age = breakoutAgeAction({
    breakout: input.breakout,
    side: input.side,
    policy: input.agePolicy ?? DEFAULT_BREAKOUT_AGE_POLICY,
  });
  const base = { bucket, rawMult: raw.mult, highVol, age };

  // Sells are never gated — exits stay free.
  if (input.side === "sell") return { ...PASS, ...base, mult: raw.mult, note: raw.note };

  const b = input.breakout;
  const cohort = cohortOf(b);
  // The rule only binds on long breakout chases: an upside break the engine
  // is buying into. Downside breaks / no signal already get cut by the raw
  // evidence multiplier and need no regime opinion.
  const chasing = !!b && cohort != null && b.direction === "up" && (cohort === "confirmed" || cohort === "pending");
  if (!chasing) return { ...PASS, ...base, mult: raw.mult, cohort, note: raw.note };

  const cell = table.cells[cohort!]?.[bucket] ?? null;
  const proven = !!cell && cell.trades >= cfg.minTrades;
  const positive = !!cell && cell.expectancyPct > cfg.minExpectancyPct;
  const label = `${cohort} breakout`;
  const ev = cell ? `${cell.expectancyPct >= 0 ? "+" : ""}${cell.expectancyPct.toFixed(2)}%/trade on n=${cell.trades}` : "no sample";

  const decide = (
    action: "trade" | "downsize" | "skip",
    mult: number,
    reason: string,
  ): BreakoutRegimeDecision => ({
    ...base,
    action,
    mult,
    cohort,
    cell,
    applies: true,
    reason,
    note: action === "skip" ? `${label} skipped: ${reason}` : `${label} ${bucket}${highVol ? "/high-vol" : ""} x${mult.toFixed(2)} (${reason})`,
  });

  // 0. Signal age. Freshness is the measured edge: expectancy decays ~0.13%
  //    per bar of age and slow confirmations are ~3x worse, so a late chase
  //    is vetoed outright and a merely-not-fresh break is trimmed.
  if (age.applies && age.veto) {
    return decide("skip", 0, age.reason);
  }

  // 1. Violent tape — a break here is as likely to be a liquidity air pocket
  //    as a trend start. Nothing in the table can buy back a chase at VIX 32+.
  if (vol.vix != null && Number.isFinite(vol.vix) && vol.vix >= cfg.vixVeto) {
    return decide("skip", 0, `VIX ${vol.vix.toFixed(0)} >= ${cfg.vixVeto} — no breakout chases`);
  }

  // 2. Measured-negative expectancy on an adequate sample: veto.
  if (proven && !positive) {
    return decide("skip", 0, `${bucket} expectancy ${ev} — regime has no measured edge`);
  }

  const withAge = (m: number) => (age.applies ? m * age.mult : m);

  // 3. Hostile-by-construction tape. Even a positive cell only earns a cut
  //    ticket here, and the +20% conviction boost is stripped.
  if (bucket === "sideways" || highVol) {
    const capped = withAge(Math.min(raw.mult, highVol ? cfg.highVolMult : cfg.sidewaysMult));
    const why = bucket === "sideways" && highVol ? "sideways + high vol" : bucket === "sideways" ? "sideways tape" : "high-vol tape";
    return decide("downsize", capped, `${why}; ${ev}`);
  }

  // 4. Not enough history to justify leaning in — take it small.
  if (!proven) {
    return decide(
      "downsize",
      withAge(Math.min(raw.mult, cfg.unprovenMult)),
      `only ${cell?.trades ?? 0} historical ${bucket} trades — unproven`,
    );
  }

  // 5. Measured positive expectancy in a benign regime: the boost is earned,
  //    still scaled by how fresh the break is.
  const sized = withAge(raw.mult);
  return sized < raw.mult - 1e-9
    ? decide("downsize", sized, `${bucket} expectancy ${ev}; ${age.reason}`)
    : decide("trade", sized, `${bucket} expectancy ${ev}`);
}

/** Build an expectancy table from a live backtest report's cohort x regime grid. */
export function expectancyTableFromStats(
  stats: readonly {
    cohort: string;
    regime: string;
    trades: number;
    expectancyPct: number;
    winRatePct: number;
  }[],
  meta: { source: string; asOf?: string | null } = { source: "backtest" },
): BreakoutExpectancyTable {
  const cells: BreakoutExpectancyTable["cells"] = {};
  for (const row of stats) {
    if (row.regime === "all" || row.cohort === "all") continue;
    const cohort = row.cohort as BreakoutCohortKey;
    if (cohort !== "confirmed" && cohort !== "pending" && cohort !== "failed") continue;
    const bucket = breakoutRegimeBucket(row.regime);
    const byCohort = (cells[cohort] ??= {});
    const prior = byCohort[bucket];
    if (prior) {
      // Two source regimes collapsed onto one bucket — pool by trade count.
      const n = prior.trades + row.trades;
      byCohort[bucket] = n
        ? {
            trades: n,
            expectancyPct: (prior.expectancyPct * prior.trades + row.expectancyPct * row.trades) / n,
            winRatePct: (prior.winRatePct * prior.trades + row.winRatePct * row.trades) / n,
          }
        : prior;
    } else {
      byCohort[bucket] = {
        trades: row.trades,
        expectancyPct: row.expectancyPct,
        winRatePct: row.winRatePct,
      };
    }
  }
  return { source: meta.source, asOf: meta.asOf ?? null, cells };
}
