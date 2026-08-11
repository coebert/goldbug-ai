// Links chart annotations to the trading decisions taken around the same date,
// so a note on the chart can be read next to what the engine actually did.
//
// Pure matching only — the data fetch lives in the server function.

import { engineSymbolKey } from "./price-symbol";
import type { ChartAnnotation } from "./chart-annotations";

export interface DecisionRecord {
  id: string;
  symbol: string;
  action: string;
  outcome: string;
  decidedAt: string;
  runDate: string;
  notional: number | null;
  instrumentCcy: string | null;
  rationale: string | null;
  portfolioLabel?: string | null;
}

export interface LinkedDecision extends DecisionRecord {
  /** Whole days between the decision date and the annotated chart date. */
  dayGap: number;
  /** True when the decision is on the charted instrument itself. */
  sameInstrument: boolean;
  /** Higher = more likely to be the decision this note explains. */
  influence: number;
}

export interface AnnotationWithDecisions extends ChartAnnotation {
  decisions: LinkedDecision[];
}

/** Days either side of an annotated move that a decision can be linked to. */
export const LINK_WINDOW_DAYS = 3;
const MAX_PER_ANNOTATION = 4;

function dayIndex(value: string): number {
  const iso = value.length >= 10 ? value.slice(0, 10) : value;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.NaN;
}

function actionWeight(action: string): number {
  const a = action.toLowerCase();
  if (a === "buy" || a === "sell") return 1;
  return 0.25; // hold
}

function outcomeWeight(outcome: string): number {
  const o = outcome.toLowerCase();
  if (o === "filled") return 1;
  if (o === "partial" || o === "placed") return 0.8;
  if (o === "pending") return 0.6;
  return 0.35; // skipped / rejected / cancelled / error / hold
}

/**
 * Score how strongly one decision relates to one annotated chart event.
 * Same-instrument decisions dominate; otherwise recency, a real buy/sell and
 * an actually-executed outcome rank a decision above routine holds.
 */
export function scoreInfluence(
  annotationDate: string,
  chartSymbol: string,
  decision: DecisionRecord,
): { dayGap: number; sameInstrument: boolean; influence: number } | null {
  const a = dayIndex(annotationDate);
  const d = dayIndex(decision.decidedAt || decision.runDate);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
  const dayGap = Math.abs(a - d);
  if (dayGap > LINK_WINDOW_DAYS) return null;

  const sameInstrument = engineSymbolKey(decision.symbol) === engineSymbolKey(chartSymbol);
  const proximity = 1 - dayGap / (LINK_WINDOW_DAYS + 1);
  const size = decision.notional && decision.notional > 0 ? Math.min(1, decision.notional / 5000) : 0;

  const influence =
    (sameInstrument ? 2 : 0) +
    proximity * 1.2 +
    actionWeight(decision.action) * 1.5 +
    outcomeWeight(decision.outcome) * 0.8 +
    size * 0.5;

  return { dayGap, sameInstrument, influence: Number(influence.toFixed(4)) };
}

/** Attach the most influential decisions to each annotation. */
export function linkDecisionsToAnnotations(
  annotations: ChartAnnotation[],
  chartSymbol: string,
  decisions: DecisionRecord[],
): AnnotationWithDecisions[] {
  return annotations.map((annotation) => {
    const linked: LinkedDecision[] = [];
    for (const decision of decisions) {
      const scored = scoreInfluence(annotation.date, chartSymbol, decision);
      if (!scored) continue;
      linked.push({ ...decision, ...scored });
    }
    linked.sort(
      (x, y) =>
        y.influence - x.influence ||
        x.dayGap - y.dayGap ||
        (y.notional ?? 0) - (x.notional ?? 0) ||
        x.symbol.localeCompare(y.symbol),
    );
    return { ...annotation, decisions: linked.slice(0, MAX_PER_ANNOTATION) };
  });
}
