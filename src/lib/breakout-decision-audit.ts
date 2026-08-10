// Per-order breakout audit record.
//
// The breakout regime gate (src/lib/alpha/breakout-regime-policy.ts) decides
// whether a breakout-driven buy runs at full size, gets trimmed, or is dropped
// entirely. That decision reads three separate pieces of evidence:
//
//   * the expectancy CELL for (cohort x regime bucket) from the live table,
//   * the VOLATILITY context (VIX, 20d realised vol, regime label),
//   * the SIGNAL AGE band (freshness decay / stale-chase veto).
//
// At runtime those collapse into a single multiplier and a terse note. This
// module snapshots all three inputs plus the exact outcome so the Analytics
// page can show, per order, *why* a breakout was taken, downsized, or skipped
// — without re-deriving anything after the fact.
//
// Pure module: inputs in, plain record out. No I/O, no clock.

import type { BreakoutEvidence } from "./alpha/breakout";
import type {
  BreakoutRegimeDecision,
  ExpectancyCell,
} from "./alpha/breakout-regime-policy";

export type BreakoutDecisionAudit = {
  /** "trade" | "downsize" | "skip" — what the gate did. */
  action: "trade" | "downsize" | "skip";
  /** True when the gate actually bound on this order (breakout-driven buy). */
  applies: boolean;
  /** Final multiplier applied to the ticket (0 when skipped). */
  applied_multiplier: number;
  /** Multiplier the raw breakout evidence alone asked for. */
  raw_multiplier: number;

  // --- signal -------------------------------------------------------------
  state: string | null;
  direction: "up" | "down" | null;
  cohort: "confirmed" | "pending" | "failed" | null;
  quality: number | null;
  penetration_atr: number | null;
  volume_ratio: number | null;
  base_width_pct: number | null;
  base_bars: number | null;
  level: number | null;
  false_breakout_rate: number | null;

  // --- expectancy cell ----------------------------------------------------
  regime: string | null;
  regime_bucket: "bull" | "bear" | "sideways";
  cell_trades: number | null;
  cell_expectancy_pct: number | null;
  cell_win_rate_pct: number | null;
  /** "proven positive" | "proven negative" | "unproven" | "no sample". */
  cell_verdict: string;
  table_source: string | null;
  table_as_of: string | null;

  // --- volatility inputs --------------------------------------------------
  vix: number | null;
  realised_vol_20d: number | null;
  high_vol: boolean;

  // --- signal age ---------------------------------------------------------
  age_bars: number | null;
  age_band: string | null;
  age_multiplier: number | null;
  age_veto: boolean;

  /** Machine reason from the gate. */
  reason: string;
  /** The gate's own note (what lands in the sizing trail). */
  note: string;
  /** One-sentence plain-language explanation for the UI. */
  explanation: string;
};

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

export function cellVerdict(
  cell: ExpectancyCell | null,
  minTrades: number,
  minExpectancyPct: number,
): string {
  if (!cell) return "no sample";
  if (cell.trades < minTrades) return "unproven";
  return cell.expectancyPct > minExpectancyPct ? "proven positive" : "proven negative";
}

function pctStr(x: number | null): string {
  if (x == null) return "n/a";
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

/** Plain-language, one-sentence explanation of the gate's outcome. */
export function explainBreakoutDecision(a: Omit<BreakoutDecisionAudit, "explanation">): string {
  if (!a.applies) return "Not a breakout-driven buy — the breakout gate did not apply.";

  const cellPhrase =
    a.cell_trades == null
      ? "no measured history for this cohort in this regime"
      : `history for ${a.cohort} breakouts in a ${a.regime_bucket} tape is ${pctStr(a.cell_expectancy_pct)} per trade over ${a.cell_trades} trades`;

  const volBits: string[] = [];
  if (a.vix != null) volBits.push(`VIX ${a.vix.toFixed(1)}`);
  if (a.realised_vol_20d != null)
    volBits.push(`20d realised vol ${(a.realised_vol_20d * 100).toFixed(2)}%/day`);
  const volPhrase = volBits.length ? ` Volatility read: ${volBits.join(", ")}${a.high_vol ? " (treated as high-vol)" : ""}.` : "";

  const agePhrase =
    a.age_bars != null
      ? ` Signal was ${a.age_bars} bar${a.age_bars === 1 ? "" : "s"} old${a.age_band ? ` (${a.age_band})` : ""}.`
      : "";

  if (a.action === "skip") {
    return `Skipped: ${a.reason}. ${cellPhrase.charAt(0).toUpperCase()}${cellPhrase.slice(1)}.${volPhrase}${agePhrase}`;
  }
  if (a.action === "downsize") {
    return `Downsized to ${Math.round(a.applied_multiplier * 100)}% of the intended size because ${a.reason}. ${cellPhrase.charAt(0).toUpperCase()}${cellPhrase.slice(1)}.${volPhrase}${agePhrase}`;
  }
  return `Traded at ${Math.round(a.applied_multiplier * 100)}% size — ${a.reason}. ${cellPhrase.charAt(0).toUpperCase()}${cellPhrase.slice(1)}.${volPhrase}${agePhrase}`;
}

export function buildBreakoutDecisionAudit(args: {
  decision: BreakoutRegimeDecision;
  breakout: BreakoutEvidence | null | undefined;
  regime: string | null | undefined;
  vix: number | null | undefined;
  realisedVol20d: number | null | undefined;
  tableSource?: string | null;
  tableAsOf?: string | null;
  minTrades?: number;
  minExpectancyPct?: number;
}): BreakoutDecisionAudit {
  const d = args.decision;
  const b = args.breakout ?? null;
  const base: Omit<BreakoutDecisionAudit, "explanation"> = {
    action: d.action,
    applies: d.applies,
    applied_multiplier: num(d.mult) ?? 0,
    raw_multiplier: num(d.rawMult) ?? 1,

    state: b?.state ?? null,
    direction: b?.direction ?? null,
    cohort: d.cohort,
    quality: num(b?.quality),
    penetration_atr: num(b?.penetration_atr),
    volume_ratio: num(b?.volume_ratio),
    base_width_pct: num(b?.base_width_pct),
    base_bars: num(b?.base_bars),
    level: num(b?.level),
    false_breakout_rate: num(b?.false_breakout_rate),

    regime: args.regime ?? null,
    regime_bucket: d.bucket,
    cell_trades: d.cell ? d.cell.trades : null,
    cell_expectancy_pct: d.cell ? d.cell.expectancyPct : null,
    cell_win_rate_pct: d.cell ? d.cell.winRatePct : null,
    cell_verdict: cellVerdict(d.cell, args.minTrades ?? 25, args.minExpectancyPct ?? 0),
    table_source: args.tableSource ?? null,
    table_as_of: args.tableAsOf ?? null,

    vix: num(args.vix),
    realised_vol_20d: num(args.realisedVol20d),
    high_vol: !!d.highVol,

    age_bars: num(d.age?.ageBars),
    age_band: d.age?.band?.label ?? null,
    age_multiplier: num(d.age?.mult),
    age_veto: !!d.age?.veto,

    reason: d.reason,
    note: d.note,
  };
  return { ...base, explanation: explainBreakoutDecision(base) };
}
