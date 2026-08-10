import { topDrivers } from "@/lib/breakout-diagnostics";
import type { SymbolDiagnostic, TopDriver, TopDrivers } from "@/lib/breakout-diagnostics";
import { recommendDriverAction, type DriverAction, type RiskLevel } from "@/lib/breakout-driver-actions";

/**
 * Side-by-side diff of two (risk, expectancy-gap weight) settings.
 *
 * "A" is the previous setting the user was on, "B" the current one. Rows are
 * unioned across both rankings so a name entering or leaving the ranked set is
 * visible rather than silently dropped.
 */
export type DriverSetting = { risk: RiskLevel; gapWeight: number };

export type DriverCompareSide = {
  /** 1-based rank by absolute score within the ranked set; null if unranked. */
  rank: number | null;
  score: number | null;
  action: DriverAction | null;
  sizeMultiplier: number | null;
  lead: TopDriver["lead"] | null;
};

export type DriverCompareRow = {
  symbol: string;
  a: DriverCompareSide;
  b: DriverCompareSide;
  /** Positive = moved up the ranking under B. null when either side is unranked. */
  rankDelta: number | null;
  scoreDelta: number | null;
  sizeDelta: number | null;
  actionChanged: boolean;
  status: "entered" | "left" | "changed" | "same";
};

export type DriverComparison = {
  a: DriverSetting;
  b: DriverSetting;
  rows: DriverCompareRow[];
  changedCount: number;
  summary: string;
};

function sideFrom(drivers: TopDrivers, risk: RiskLevel): Map<string, DriverCompareSide> {
  const ordered = [...drivers.positive, ...drivers.negative].sort(
    (x, y) => Math.abs(y.score) - Math.abs(x.score),
  );
  const map = new Map<string, DriverCompareSide>();
  ordered.forEach((d, i) => {
    const rec = recommendDriverAction(d, risk);
    map.set(d.symbol, {
      rank: i + 1,
      score: d.score,
      action: rec.action,
      sizeMultiplier: rec.sizeMultiplier,
      lead: d.lead,
    });
  });
  return map;
}

const EMPTY: DriverCompareSide = {
  rank: null,
  score: null,
  action: null,
  sizeMultiplier: null,
  lead: null,
};

export function compareDriverSettings(
  symbols: readonly SymbolDiagnostic[],
  a: DriverSetting,
  b: DriverSetting,
  options: { limit?: number; minConfirmed?: number } = {},
): DriverComparison {
  const limit = options.limit ?? 8;
  const rank = (s: DriverSetting) =>
    topDrivers(symbols, {
      limit: 10_000,
      minConfirmed: options.minConfirmed ?? 3,
      gapWeight: s.gapWeight,
    });

  const sideA = sideFrom(rank(a), a.risk);
  const sideB = sideFrom(rank(b), b.risk);

  const rows: DriverCompareRow[] = Array.from(new Set([...sideA.keys(), ...sideB.keys()])).map(
    (symbol) => {
      const av = sideA.get(symbol) ?? EMPTY;
      const bv = sideB.get(symbol) ?? EMPTY;
      const bothRanked = av.rank != null && bv.rank != null;
      const actionChanged = av.action !== bv.action;
      const status: DriverCompareRow["status"] =
        av.rank == null ? "entered" : bv.rank == null ? "left" : actionChanged ? "changed" : "same";
      return {
        symbol,
        a: av,
        b: bv,
        rankDelta: bothRanked ? av.rank! - bv.rank! : null,
        scoreDelta: bothRanked ? bv.score! - av.score! : null,
        sizeDelta: bothRanked ? bv.sizeMultiplier! - av.sizeMultiplier! : null,
        actionChanged,
        status,
      };
    },
  );

  // Biggest movers first: action changes and rank shifts before quiet rows.
  rows.sort((x, y) => {
    const w = (r: DriverCompareRow) =>
      (r.status === "same" ? 0 : 1000) + Math.abs(r.rankDelta ?? 0) + Math.abs(r.sizeDelta ?? 0) * 10;
    return w(y) - w(x);
  });

  const changedCount = rows.filter((r) => r.status !== "same").length;
  const same = a.risk === b.risk && a.gapWeight === b.gapWeight;
  const summary = same
    ? "Both sides are on the same setting — change the risk or the gap weight to see a diff."
    : changedCount === 0
      ? `No driver changed action moving from ${a.risk} @ ${a.gapWeight}× to ${b.risk} @ ${b.gapWeight}×.`
      : `${changedCount} driver${changedCount === 1 ? "" : "s"} changed between ${a.risk} @ ${a.gapWeight}× and ${b.risk} @ ${b.gapWeight}×.`;

  return { a, b, rows: rows.slice(0, limit), changedCount, summary };
}
