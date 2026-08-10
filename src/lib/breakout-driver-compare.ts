import { topDrivers } from "@/lib/breakout-diagnostics";
import type {
  DriverConfidence,
  SymbolDiagnostic,
  TopDriver,
  TopDrivers,
} from "@/lib/breakout-diagnostics";
import {
  RISK_PROFILES,
  recommendDriverAction,
  type DriverAction,
  type RiskLevel,
} from "@/lib/breakout-driver-actions";

/**
 * Side-by-side diff of two (risk, expectancy-gap weight) settings.
 *
 * "A" is the previous setting the user was on, "B" the current one. Rows are
 * unioned across both rankings so a name entering or leaving the ranked set is
 * visible rather than silently dropped.
 *
 * Every row also carries an attribution of *why* it moved. The score is a
 * closed form — `contributionPct + gapWeight × expectancyGapPct` — so a change
 * in the gap weight explains the score delta exactly, and anything left over in
 * the rank is peers moving past this name. Size changes are explained by the
 * specific risk-profile threshold the row crossed, with the confidence factors
 * that put it on that side of the line.
 */
export type DriverSetting = { risk: RiskLevel; gapWeight: number };

export type DriverCompareSide = {
  /** 1-based rank by absolute score within the ranked set; null if unranked. */
  rank: number | null;
  score: number | null;
  action: DriverAction | null;
  sizeMultiplier: number | null;
  lead: TopDriver["lead"] | null;
  /** Plain-language reason the action layer gave for this side. */
  reason: string | null;
  confidence: DriverConfidence | null;
  /** P&L-share term of the score (weight-independent). */
  shareTerm: number | null;
  /** Raw expectancy gap in percentage points, before the weight. */
  expectancyGapPct: number | null;
  confirmedTrades: number | null;
  tradeSharePct: number | null;
};

/** One additive component of the Δ score. */
export type ScoreFactor = {
  label: string;
  /** Signed contribution to (score B − score A). */
  delta: number;
  detail: string;
};

/** One multiplicative doubt behind the confidence badge. */
export type ConfidenceFactor = {
  label: string;
  /** 0–1 on the current (B) side. */
  value: number;
  detail: string;
};

export type DriverChangeExplanation = {
  headline: string;
  /** Additive decomposition of the Δ score; sums to `scoreDelta`. */
  scoreFactors: ScoreFactor[];
  /** Confidence inputs on the current side, worst first. */
  confidenceFactors: ConfidenceFactor[];
  /** Why the rank moved beyond this row's own score change, if it did. */
  rankReason: string | null;
  /** Which risk threshold the row crossed to change action/size. */
  sizeReason: string | null;
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
  explain: DriverChangeExplanation;
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
      reason: rec.reason,
      confidence: d.confidence,
      shareTerm: d.contributionPct,
      expectancyGapPct: d.expectancyGapPct,
      confirmedTrades: d.confirmedTrades,
      tradeSharePct: d.tradeSharePct,
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
  reason: null,
  confidence: null,
  shareTerm: null,
  expectancyGapPct: null,
  confirmedTrades: null,
  tradeSharePct: null,
};

const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

/**
 * Attribute a row's movement to the two controls.
 *
 * The gap weight is the only score input that differs between sides, so the
 * score delta is `(wB − wA) × expectancyGap` and the P&L-share term is carried
 * unchanged. Risk level never touches the score — it only re-maps the score to
 * an action, which is why a row can hold its rank and still change size.
 */
export function explainDriverChange(
  symbol: string,
  av: DriverCompareSide,
  bv: DriverCompareSide,
  a: DriverSetting,
  b: DriverSetting,
  context: { medianPeerScoreDelta: number },
): DriverChangeExplanation {
  const scoreFactors: ScoreFactor[] = [];
  const gap = bv.expectancyGapPct ?? av.expectancyGapPct ?? 0;
  const share = bv.shareTerm ?? av.shareTerm ?? 0;
  const weightDelta = b.gapWeight - a.gapWeight;

  if (av.rank == null || bv.rank == null) {
    const entering = av.rank == null;
    return {
      headline: entering
        ? `${symbol} only clears the ranking bar at ${b.gapWeight.toFixed(1)}× gap weight`
        : `${symbol} drops out of the ranked set at ${b.gapWeight.toFixed(1)}× gap weight`,
      scoreFactors: [
        {
          label: "Expectancy gap × weight",
          delta: weightDelta * gap,
          detail: `${gap.toFixed(1)}pp gap × ${signed(weightDelta, 1)} weight change`,
        },
      ],
      confidenceFactors: confidenceFactorsFrom(bv.confidence ?? av.confidence),
      rankReason: entering
        ? "Unranked on the previous setting, so there is no rank to compare against."
        : "Ranked previously but not under the current setting.",
      sizeReason: entering
        ? `Enters at ${bv.action} · ${(bv.sizeMultiplier ?? 0).toFixed(2)}×.`
        : `Leaves the set from ${av.action} · ${(av.sizeMultiplier ?? 0).toFixed(2)}×.`,
    };
  }

  scoreFactors.push({
    label: "P&L share",
    delta: 0,
    detail: `${signed(share)} and weight-independent — same on both settings`,
  });
  scoreFactors.push({
    label: "Expectancy gap × weight",
    delta: weightDelta * gap,
    detail:
      weightDelta === 0
        ? `${gap.toFixed(1)}pp gap held at ${b.gapWeight.toFixed(1)}× — no score effect`
        : `${gap.toFixed(1)}pp gap × ${signed(weightDelta, 1)} weight = ${signed(weightDelta * gap)}`,
  });

  const scoreDelta = (bv.score ?? 0) - (av.score ?? 0);
  const rankDelta = av.rank - bv.rank;

  let rankReason: string | null = null;
  if (rankDelta === 0) {
    rankReason =
      scoreDelta === 0
        ? "Score and rank both unchanged."
        : `Score moved ${signed(scoreDelta)} but peers moved with it, so the rank held.`;
  } else {
    const ownVsPeers = scoreDelta - context.medianPeerScoreDelta;
    const direction = rankDelta > 0 ? "up" : "down";
    rankReason =
      Math.abs(ownVsPeers) < 0.05
        ? `Moved ${direction} ${Math.abs(rankDelta)} place${Math.abs(rankDelta) === 1 ? "" : "s"} on peer reshuffling — its own score barely moved relative to the field.`
        : `Moved ${direction} ${Math.abs(rankDelta)} place${Math.abs(rankDelta) === 1 ? "" : "s"}: score change of ${signed(scoreDelta)} versus a ${signed(context.medianPeerScoreDelta)} median across peers.`;
  }

  const sizeReason = explainSizeChange(av, bv, a, b);

  const leadFlipped = av.lead !== bv.lead && bv.lead != null;
  const headlineParts: string[] = [];
  if (weightDelta !== 0) {
    headlineParts.push(
      `gap weight ${a.gapWeight.toFixed(1)}× → ${b.gapWeight.toFixed(1)}× shifts the score ${signed(scoreDelta)}`,
    );
  }
  if (a.risk !== b.risk) headlineParts.push(`risk ${a.risk} → ${b.risk} re-maps the action`);
  if (leadFlipped) headlineParts.push(`now led by ${bv.lead}`);

  return {
    headline: headlineParts.length
      ? `${symbol}: ${headlineParts.join("; ")}.`
      : `${symbol}: unchanged under these settings.`,
    scoreFactors,
    confidenceFactors: confidenceFactorsFrom(bv.confidence),
    rankReason,
    sizeReason,
  };
}

function explainSizeChange(
  av: DriverCompareSide,
  bv: DriverCompareSide,
  a: DriverSetting,
  b: DriverSetting,
): string | null {
  if (av.action === bv.action && av.sizeMultiplier === bv.sizeMultiplier) {
    return `Stays ${bv.action} at ${(bv.sizeMultiplier ?? 0).toFixed(2)}× — no risk threshold crossed.`;
  }
  const pa = RISK_PROFILES[a.risk];
  const pb = RISK_PROFILES[b.risk];
  const scoreB = bv.score ?? 0;
  const confB = bv.confidence?.score ?? 0;

  if (bv.action === "avoid") {
    return `Score ${scoreB.toFixed(1)} sits at or below the ${pb.label.toLowerCase()} avoid floor of ${pb.avoidAt} (was ${pa.avoidAt}) — dropped to 0×.`;
  }
  if (bv.action === "prioritise") {
    return `Score ${scoreB.toFixed(1)} clears the ${pb.prioritiseAt} priority bar (was ${pa.prioritiseAt}) with confidence ${(confB * 100).toFixed(0)} above the ${(pb.minConfidence * 100).toFixed(0)} bar.`;
  }
  if (bv.action === "downsize") {
    return confB < pb.minConfidence
      ? `Confidence ${(confB * 100).toFixed(0)} falls under the ${(pb.minConfidence * 100).toFixed(0)} bar for ${pb.label.toLowerCase()} (was ${(pa.minConfidence * 100).toFixed(0)}) — partial at ${pb.downsize.toFixed(2)}×.`
      : `Score ${scoreB.toFixed(1)} is negative but above the ${pb.avoidAt} avoid floor — partial at ${pb.downsize.toFixed(2)}×.`;
  }
  return `Baseline trade: score ${scoreB.toFixed(1)} sits between the ${pb.avoidAt} avoid floor and the ${pb.prioritiseAt} priority bar, at ${pb.fullSize.toFixed(2)}× for ${pb.label.toLowerCase()}.`;
}

function confidenceFactorsFrom(conf: DriverConfidence | null): ConfidenceFactor[] {
  if (!conf) return [];
  const factors: ConfidenceFactor[] = [
    {
      label: "Sample",
      value: conf.sampleScore,
      detail: conf.reasons[0] ?? "confirmed-signal count",
    },
    {
      label: "Breadth",
      value: conf.breadthScore,
      detail:
        conf.reasons[1] ?? "P&L share versus this name's share of confirmed trades",
    },
  ];
  const basisReason = conf.reasons.find((r) => r.startsWith("score led by the expectancy gap"));
  if (basisReason) {
    factors.push({ label: "Basis", value: 0.85, detail: basisReason });
  }
  // Worst factor first: that is the one holding the badge down.
  return factors.sort((x, y) => x.value - y.value);
}

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

  const names = Array.from(new Set([...sideA.keys(), ...sideB.keys()]));

  // Median score move across every name ranked on both sides — the yardstick
  // that separates "this name moved" from "the field moved around it".
  const peerDeltas = names
    .map((n) => {
      const av = sideA.get(n);
      const bv = sideB.get(n);
      return av && bv ? bv.score! - av.score! : null;
    })
    .filter((v): v is number => v != null)
    .sort((x, y) => x - y);
  const medianPeerScoreDelta = peerDeltas.length
    ? (peerDeltas[Math.floor((peerDeltas.length - 1) / 2)]! +
        peerDeltas[Math.ceil((peerDeltas.length - 1) / 2)]!) /
      2
    : 0;

  const rows: DriverCompareRow[] = names.map((symbol) => {
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
      explain: explainDriverChange(symbol, av, bv, a, b, { medianPeerScoreDelta }),
    };
  });

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
