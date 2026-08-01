// Pure confidence-calibration maths.
//
// The AI records a 0..1 "conviction" per order. On its own that number means
// nothing to a user. Calibration answers: when the AI said 0.7, how often did
// the trade actually move its way? We bucket historical orders into conviction
// bands, measure the realized hit-rate per band with a Wilson confidence
// interval, and place the current order's conviction inside that history
// (band + percentile), so the panel can say what "confidence" means.

export type CalibrationSample = {
  conviction: number; // 0..1
  hit: boolean; // did the forward move go the trade's way?
  forwardReturn?: number; // signed return in the trade's direction
};

export type CalibrationBand = {
  lower: number;
  upper: number;
  label: string; // "60–80%"
  n: number;
  hits: number;
  hitRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  avgConviction: number | null;
  avgForwardReturn: number | null;
};

export type CalibrationReport = {
  bands: CalibrationBand[];
  totalSamples: number;
  overallHitRate: number | null;
  /** Mean |stated conviction − realized hit-rate| across populated bands. */
  calibrationError: number | null;
  horizonDays: number;
};

export type CalibrationReading = {
  band: CalibrationBand | null;
  /** Percentile of this conviction within the historical conviction distribution (0..100). */
  percentile: number | null;
  /** true when the band has too few samples to quote a hit-rate. */
  insufficient: boolean;
  /** How the stated conviction compares to realized outcomes. */
  verdict: "well-calibrated" | "optimistic" | "conservative" | "unknown";
  sentence: string;
};

export const MIN_BAND_SAMPLES = 8;

export const DEFAULT_BAND_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Wilson score interval — stable for small n, unlike the normal approximation. */
export function wilsonInterval(hits: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (centre - margin) / denom),
    Math.min(1, (centre + margin) / denom),
  ];
}

export function buildCalibration(
  samples: CalibrationSample[],
  opts?: { edges?: number[]; horizonDays?: number },
): CalibrationReport {
  const edges = opts?.edges ?? DEFAULT_BAND_EDGES;
  const clean = samples.filter(
    (s) => Number.isFinite(s.conviction) && s.conviction >= 0 && s.conviction <= 1,
  );

  const bands: CalibrationBand[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lower = edges[i];
    const upper = edges[i + 1];
    const inBand = clean.filter((s) => s.conviction >= lower && s.conviction < upper);
    const n = inBand.length;
    const hits = inBand.filter((s) => s.hit).length;
    const rets = inBand.map((s) => s.forwardReturn).filter((r): r is number => Number.isFinite(r));
    const [ciLow, ciHigh] = n > 0 ? wilsonInterval(hits, n) : [null, null];
    bands.push({
      lower,
      upper: Math.min(upper, 1),
      label: `${Math.round(lower * 100)}–${Math.round(Math.min(upper, 1) * 100)}%`,
      n,
      hits,
      hitRate: n > 0 ? hits / n : null,
      ciLow,
      ciHigh,
      avgConviction: n > 0 ? inBand.reduce((t, s) => t + s.conviction, 0) / n : null,
      avgForwardReturn: rets.length ? rets.reduce((t, r) => t + r, 0) / rets.length : null,
    });
  }

  const populated = bands.filter((b) => b.n >= MIN_BAND_SAMPLES && b.hitRate != null);
  const calibrationError = populated.length
    ? populated.reduce((t, b) => t + Math.abs((b.avgConviction ?? 0) - (b.hitRate ?? 0)), 0) /
      populated.length
    : null;

  return {
    bands,
    totalSamples: clean.length,
    overallHitRate: clean.length ? clean.filter((s) => s.hit).length / clean.length : null,
    calibrationError,
    horizonDays: opts?.horizonDays ?? 5,
  };
}

export function convictionPercentile(
  conviction: number,
  samples: CalibrationSample[],
): number | null {
  const vals = samples
    .map((s) => s.conviction)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const below = vals.filter((v) => v < conviction).length;
  const equal = vals.filter((v) => v === conviction).length;
  return Math.round(((below + equal / 2) / vals.length) * 100);
}

export function readCalibration(
  conviction: number | null,
  report: CalibrationReport,
  samples: CalibrationSample[] = [],
): CalibrationReading {
  if (conviction == null || !Number.isFinite(conviction)) {
    return {
      band: null,
      percentile: null,
      insufficient: true,
      verdict: "unknown",
      sentence:
        "No conviction was recorded for this order, so it cannot be placed against the historical hit-rate.",
    };
  }
  const c = Math.max(0, Math.min(1, conviction));
  const band =
    report.bands.find((b) => c >= b.lower && c < b.upper) ??
    report.bands[report.bands.length - 1] ??
    null;
  const percentile = convictionPercentile(c, samples);
  const insufficient = !band || band.n < MIN_BAND_SAMPLES || band.hitRate == null;

  if (insufficient) {
    return {
      band,
      percentile,
      insufficient: true,
      verdict: "unknown",
      sentence: `Confidence ${c.toFixed(2)} sits in the ${band?.label ?? "—"} band, but only ${band?.n ?? 0} past order${(band?.n ?? 0) === 1 ? "" : "s"} fall there — too few to quote a historical hit-rate (needs ${MIN_BAND_SAMPLES}). Treat it as a relative ranking, not a probability.`,
    };
  }

  const hr = band!.hitRate!;
  const gap = c - hr;
  const verdict: CalibrationReading["verdict"] =
    Math.abs(gap) <= 0.1 ? "well-calibrated" : gap > 0 ? "optimistic" : "conservative";

  const percentileClause =
    percentile != null
      ? ` That is higher than ${percentile}% of past orders on this portfolio.`
      : "";
  const verdictClause =
    verdict === "well-calibrated"
      ? "Stated confidence has broadly matched reality in this band."
      : verdict === "optimistic"
        ? `Stated confidence has run ahead of outcomes here by about ${pct(Math.abs(gap))}.`
        : `Outcomes here have beaten the stated confidence by about ${pct(Math.abs(gap))}.`;

  const sentence =
    `Confidence ${c.toFixed(2)} lands in the ${band!.label} band. Historically ${band!.hits} of ${band!.n} orders in that band ` +
    `moved the trade's way within ${report.horizonDays} trading days — a ${pct(hr)} hit-rate ` +
    `(95% range ${pct(band!.ciLow ?? 0)}–${pct(band!.ciHigh ?? 1)}).${percentileClause} ${verdictClause}`;

  return { band, percentile, insufficient: false, verdict, sentence };
}
