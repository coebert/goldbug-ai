// Measured trading edge, read back from `signal_performance`.
//
// Kelly sizing used a hardcoded `edge = 0.02` while the app was already
// measuring per-signal hit-rate and average edge (bps) every run and
// writing them to `signal_performance` — data that was never read back.
// This module turns those rows into the expected per-trade edge fraction
// the Kelly sizer should actually use.
//
// Pure: the server loader passes rows in.

/** Prior used when there is no (or not enough) measurement. */
export const EDGE_PRIOR = 0.02;
/** Sample count at which the measurement carries half the weight. */
const SHRINK_K = 20;
/** Hard bounds — a wild measurement must not blow up position sizing. */
export const EDGE_MIN = 0.005;
export const EDGE_MAX = 0.06;

export type SignalPerfRow = {
  signal_name: string;
  samples: number | null;
  hit_rate: number | null;
  avg_edge_bps: number | null;
  weight_avg: number | null;
};

export type MeasuredEdge = {
  /** Expected per-trade edge fraction to feed the Kelly sizer. */
  edge: number;
  /** Total samples behind the measurement. */
  samples: number;
  /** Sample-weighted hit rate in [0, 1], or null when unmeasured. */
  hitRate: number | null;
  /** Raw measured edge before shrinkage, or null when unmeasured. */
  rawEdge: number | null;
  /** True when the prior was used unchanged. */
  usedPrior: boolean;
  /** Short note for sizing telemetry. */
  note: string;
};

/**
 * Blend measured per-signal edge into a single expected edge fraction.
 *
 * Signals are weighted by how much they actually drove decisions
 * (`weight_avg`) and by their sample count, then the result is shrunk
 * toward `EDGE_PRIOR` with a Bayesian-style `n / (n + K)` factor so a
 * handful of lucky trades cannot inflate size. Negative measured edge is
 * respected — it pulls sizing down toward `EDGE_MIN` rather than being
 * clipped back up to the prior.
 */
export function measuredEdgeFromSignals(rows: SignalPerfRow[]): MeasuredEdge {
  let weightSum = 0;
  let edgeAcc = 0;
  let hitAcc = 0;
  let samples = 0;

  for (const r of rows) {
    const n = Math.max(0, Number(r.samples ?? 0));
    if (n <= 0) continue;
    // `Number(null)` is 0, so an unmeasured row must be rejected explicitly
    // rather than counted as a zero-edge observation.
    if (r.avg_edge_bps == null) continue;
    const bps = Number(r.avg_edge_bps);
    if (!Number.isFinite(bps)) continue;
    // Influence = how often the signal fired × how much it was weighted.
    const influence = n * Math.max(0.01, Number(r.weight_avg ?? 100) / 100);
    weightSum += influence;
    edgeAcc += (bps / 10_000) * influence;
    const hr = r.hit_rate == null ? Number.NaN : Number(r.hit_rate);
    hitAcc += (Number.isFinite(hr) ? hr : 0.5) * influence;
    samples += n;
  }

  if (weightSum <= 0 || samples <= 0) {
    return {
      edge: EDGE_PRIOR,
      samples: 0,
      hitRate: null,
      rawEdge: null,
      usedPrior: true,
      note: `edge=prior ${(EDGE_PRIOR * 100).toFixed(1)}% (no measurement)`,
    };
  }

  const rawEdge = edgeAcc / weightSum;
  const hitRate = Math.max(0, Math.min(1, hitAcc / weightSum));
  const confidence = samples / (samples + SHRINK_K);
  const blended = EDGE_PRIOR * (1 - confidence) + rawEdge * confidence;
  const edge = Math.max(EDGE_MIN, Math.min(EDGE_MAX, blended));

  return {
    edge,
    samples,
    hitRate,
    rawEdge,
    usedPrior: false,
    note:
      `edge=${(edge * 100).toFixed(2)}% measured ${(rawEdge * 100).toFixed(2)}% ` +
      `hit ${(hitRate * 100).toFixed(0)}% n=${samples}`,
  };
}
