// Reconciliation outcome metrics.
//
// Per-tick reconciliation answers "did this tick route cleanly?". This module
// answers the operational question over time: are dropped legs getting worse,
// how much are adverse prints costing, and how often does inventory *nearly*
// get stranded (an intended exit that did not fully leave the book)?
//
// Pure functions only — DB reads and alert writes live in
// `recon-metrics.server.ts`.

import type { LegDiscrepancyCode, LegSeverity } from "./trade-leg-reconciliation";

/** One reconciliation discrepancy as it was observed at a point in time. */
export interface ReconObservation {
  /** ISO timestamp the discrepancy was first raised. */
  at: string;
  code: LegDiscrepancyCode;
  severity: LegSeverity;
  symbol: string;
  side: "buy" | "sell";
  intendedQuantity: number | null;
  executedQuantity: number | null;
  /** Signed (avgFill - intended)/intended in bps. */
  priceDeviationBps: number | null;
  /** How many ticks the same condition persisted (dedup counter). */
  occurrences?: number;
}

export interface ReconBucket {
  /** Bucket start (inclusive) and end (exclusive), ISO. */
  start: string;
  end: string;
  discrepancies: number;
  byCode: Record<LegDiscrepancyCode, number>;
  criticalCount: number;
  droppedLegs: number;
  /** Fills that went against us (buy above intent / sell below intent). */
  adversePrints: number;
  /** Mean magnitude of adverse deviation, bps. */
  adverseBpsMean: number;
  worstAdverseBps: number;
  /** Intended exits that did not fully execute. */
  strandedNearMisses: number;
  /** Quantity on those exits that stayed on the book. */
  strandedQuantity: number;
}

export type ReconAlertCode =
  | "dropped_leg_spike"
  | "stranded_inventory"
  | "adverse_print_drag"
  | "recon_regression";

export interface ReconAlert {
  code: ReconAlertCode;
  severity: LegSeverity;
  title: string;
  detail: string;
  /** Condition-level key so repeat alerts can be deduplicated. */
  key: string;
  value: number;
  threshold: number;
}

export interface ReconMetricsSummary {
  windowDays: number;
  bucketHours: number;
  buckets: ReconBucket[];
  totals: Omit<ReconBucket, "start" | "end">;
  /** Latest bucket vs the mean of the earlier buckets. */
  trend: {
    droppedLegsLatest: number;
    droppedLegsBaseline: number;
    strandedLatest: number;
    strandedBaseline: number;
    adverseBpsLatest: number;
    adverseBpsBaseline: number;
  };
  alerts: ReconAlert[];
}

export interface ReconMetricThresholds {
  /** Dropped legs in the latest bucket that trigger a spike alert. */
  droppedLegSpike: number;
  /** Stranded near-misses in the latest bucket that trigger an alert. */
  strandedNearMiss: number;
  /** Mean adverse deviation (bps) over the window that counts as drag. */
  adverseBpsMean: number;
  /** Minimum adverse prints before the drag alert is meaningful. */
  adversePrintMin: number;
  /** Latest-vs-baseline multiple that counts as a regression. */
  regressionMultiple: number;
}

export const DEFAULT_RECON_THRESHOLDS: ReconMetricThresholds = {
  droppedLegSpike: 2,
  strandedNearMiss: 1,
  adverseBpsMean: 120,
  adversePrintMin: 3,
  regressionMultiple: 2,
};

const CODES: LegDiscrepancyCode[] = [
  "dropped_leg",
  "side_mismatch",
  "quantity_short",
  "quantity_over",
  "price_deviation",
  "stale_pending",
  "phantom_leg",
];

/** Codes that mean an intended exit did not fully leave the book. */
const STRANDING_CODES = new Set<LegDiscrepancyCode>([
  "dropped_leg",
  "quantity_short",
  "stale_pending",
  "side_mismatch",
]);

function emptyByCode(): Record<LegDiscrepancyCode, number> {
  return CODES.reduce(
    (acc, c) => {
      acc[c] = 0;
      return acc;
    },
    {} as Record<LegDiscrepancyCode, number>,
  );
}

/** Adverse magnitude in bps: buys printed high, sells printed low. Else 0. */
export function adverseBps(o: {
  side: "buy" | "sell";
  priceDeviationBps: number | null;
}): number {
  const bps = Number(o.priceDeviationBps ?? 0);
  if (!Number.isFinite(bps) || bps === 0) return 0;
  const adverse = o.side === "buy" ? bps > 0 : bps < 0;
  return adverse ? Math.abs(bps) : 0;
}

/**
 * Quantity that stayed on the book because an intended exit under-executed.
 * Zero for buys and for anything that fully executed.
 */
export function strandedQuantity(o: ReconObservation): number {
  if (o.side !== "sell" || !STRANDING_CODES.has(o.code)) return 0;
  const intended = Number(o.intendedQuantity ?? 0);
  if (!(intended > 0)) return 0;
  const executed = Math.max(0, Number(o.executedQuantity ?? 0));
  return Math.max(0, intended - executed);
}

function accumulate(bucket: ReconBucket, o: ReconObservation, adverseSum: number[]): void {
  bucket.discrepancies += 1;
  bucket.byCode[o.code] += 1;
  if (o.severity === "critical") bucket.criticalCount += 1;
  if (o.code === "dropped_leg") bucket.droppedLegs += 1;

  const adv = adverseBps(o);
  if (o.code === "price_deviation" && adv > 0) {
    bucket.adversePrints += 1;
    adverseSum.push(adv);
    bucket.worstAdverseBps = Math.max(bucket.worstAdverseBps, adv);
  }

  const stranded = strandedQuantity(o);
  if (stranded > 0) {
    bucket.strandedNearMisses += 1;
    bucket.strandedQuantity += stranded;
  }
}

function newBucket(start: number, end: number): ReconBucket {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    discrepancies: 0,
    byCode: emptyByCode(),
    criticalCount: 0,
    droppedLegs: 0,
    adversePrints: 0,
    adverseBpsMean: 0,
    worstAdverseBps: 0,
    strandedNearMisses: 0,
    strandedQuantity: 0,
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeReconMetrics(input: {
  observations: ReconObservation[];
  nowMs?: number;
  windowDays?: number;
  bucketHours?: number;
  thresholds?: Partial<ReconMetricThresholds>;
}): ReconMetricsSummary {
  const now = input.nowMs ?? Date.now();
  const windowDays = Math.max(1, input.windowDays ?? 14);
  const bucketHours = Math.max(1, input.bucketHours ?? 24);
  const th = { ...DEFAULT_RECON_THRESHOLDS, ...(input.thresholds ?? {}) };

  const bucketMs = bucketHours * 3600_000;
  const windowMs = windowDays * 86400_000;
  const endMs = Math.ceil(now / bucketMs) * bucketMs;
  const startMs = endMs - Math.ceil(windowMs / bucketMs) * bucketMs;
  const count = Math.round((endMs - startMs) / bucketMs);

  const buckets: ReconBucket[] = [];
  const adverseByBucket: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    buckets.push(newBucket(startMs + i * bucketMs, startMs + (i + 1) * bucketMs));
    adverseByBucket.push([]);
  }

  const totals = newBucket(startMs, endMs);
  const totalsAdverse: number[] = [];

  for (const o of input.observations) {
    const t = Date.parse(o.at);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    const idx = Math.min(count - 1, Math.max(0, Math.floor((t - startMs) / bucketMs)));
    accumulate(buckets[idx]!, o, adverseByBucket[idx]!);
    accumulate(totals, o, totalsAdverse);
  }

  buckets.forEach((b, i) => {
    b.adverseBpsMean = round1(mean(adverseByBucket[i]!));
  });
  totals.adverseBpsMean = round1(mean(totalsAdverse));

  const latest = buckets[buckets.length - 1] ?? newBucket(startMs, endMs);
  const earlier = buckets.slice(0, -1);
  const trend = {
    droppedLegsLatest: latest.droppedLegs,
    droppedLegsBaseline: round1(mean(earlier.map((b) => b.droppedLegs))),
    strandedLatest: latest.strandedNearMisses,
    strandedBaseline: round1(mean(earlier.map((b) => b.strandedNearMisses))),
    adverseBpsLatest: latest.adverseBpsMean,
    adverseBpsBaseline: round1(
      mean(earlier.filter((b) => b.adversePrints > 0).map((b) => b.adverseBpsMean)),
    ),
  };

  const alerts: ReconAlert[] = [];
  if (latest.droppedLegs >= th.droppedLegSpike) {
    alerts.push({
      code: "dropped_leg_spike",
      severity: "critical",
      title: `${latest.droppedLegs} dropped legs in the latest window`,
      detail:
        `${latest.droppedLegs} intended legs never reached the broker without an engine veto ` +
        `(baseline ${trend.droppedLegsBaseline} per window). Routing is losing orders.`,
      key: `dropped_leg_spike|${latest.start}`,
      value: latest.droppedLegs,
      threshold: th.droppedLegSpike,
    });
  }
  if (latest.strandedNearMisses >= th.strandedNearMiss) {
    alerts.push({
      code: "stranded_inventory",
      severity: "critical",
      title: `Inventory nearly stranded on ${latest.strandedNearMisses} exit${latest.strandedNearMisses === 1 ? "" : "s"}`,
      detail:
        `${round1(latest.strandedQuantity)} units of intended exits did not leave the book ` +
        `in the latest window — the position stayed on risk after the engine tried to cut it.`,
      key: `stranded_inventory|${latest.start}`,
      value: latest.strandedNearMisses,
      threshold: th.strandedNearMiss,
    });
  }
  if (totals.adversePrints >= th.adversePrintMin && totals.adverseBpsMean >= th.adverseBpsMean) {
    alerts.push({
      code: "adverse_print_drag",
      severity: "warning",
      title: `Adverse prints averaging ${totals.adverseBpsMean}bps`,
      detail:
        `${totals.adversePrints} fills over ${windowDays}d printed against the intent, ` +
        `worst ${round1(totals.worstAdverseBps)}bps. That is direct execution drag.`,
      key: `adverse_print_drag|${windowDays}d`,
      value: totals.adverseBpsMean,
      threshold: th.adverseBpsMean,
    });
  }
  const baselineAll = mean(earlier.map((b) => b.discrepancies));
  if (
    earlier.length >= 2 &&
    baselineAll > 0 &&
    latest.discrepancies >= baselineAll * th.regressionMultiple &&
    latest.discrepancies >= 3
  ) {
    alerts.push({
      code: "recon_regression",
      severity: "warning",
      title: "Reconciliation mismatches jumped versus baseline",
      detail:
        `${latest.discrepancies} mismatches in the latest window against a baseline of ` +
        `${round1(baselineAll)} — something changed in routing or at the broker.`,
      key: `recon_regression|${latest.start}`,
      value: latest.discrepancies,
      threshold: round1(baselineAll * th.regressionMultiple),
    });
  }

  return { windowDays, bucketHours, buckets, totals, trend, alerts };
}
