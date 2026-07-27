// Phase A — Algo-driven market regime detection.
//
// Modern equity/futures markets are dominated by algorithmic and AI-driven
// participants. That produces recognisable footprints that a slower,
// discretion-driven strategy should adapt to rather than ignore:
//
//   * Volatility bursts     — realised short-window vol spikes vs its 20d baseline
//   * Liquidity vacuums     — volume collapses relative to its rolling median
//   * Whipsaw / mean-revert — many sign flips in short-window returns
//   * Correlation spikes    — cross-sectional correlation of top holdings jumps
//                             (the "all algos exit together" signature)
//   * Gap-and-fade          — overnight gap that reverses in the first bars
//
// All detectors are pure functions on numeric arrays; callers own the
// data-fetching side. The module deliberately avoids any I/O so the whole
// thing is trivial to fuzz and unit-test.

export type BarSeries = {
  /** Close prices, oldest → newest. */
  closes: number[];
  /** Traded volume aligned with `closes`. Optional. */
  volumes?: number[];
};

export type AlgoRegimeInputs = {
  /** Primary index or portfolio bench series (e.g. SPY 5-min or daily). */
  primary: BarSeries;
  /**
   * Optional daily return series per top holding, used to spot correlated
   * de-risking. Keys are symbols, arrays are same-length daily returns.
   */
  crossSection?: Record<string, number[]>;
  /**
   * Overnight gap in %, with the first-N-bars fade in %. Both optional; if
   * omitted the gap-and-fade detector reports `false`.
   */
  overnightGapPct?: number;
  openingFadePct?: number;
  /** Config overrides. */
  config?: Partial<AlgoRegimeConfig>;
};

export type AlgoRegimeConfig = {
  shortVolWindow: number;      // e.g. 5 bars
  longVolWindow: number;       // e.g. 20 bars
  volBurstRatio: number;       // short/long vol ratio to flag a burst
  volumeWindow: number;        // rolling median window for volume
  liquidityVacuumRatio: number; // current / median volume below this = vacuum
  whipsawWindow: number;       // bars to inspect for sign flips
  whipsawFlipsThreshold: number; // >= N flips = whipsaw
  correlationSpikeThreshold: number; // avg pairwise |corr| ≥ this = spike
  gapAtrMultiple: number;      // gap size relative to typical open range
  gapFadeFraction: number;     // fraction of gap retraced to count as fade
};

export const DEFAULT_ALGO_REGIME_CONFIG: AlgoRegimeConfig = {
  shortVolWindow: 5,
  longVolWindow: 20,
  volBurstRatio: 2.5,
  volumeWindow: 20,
  liquidityVacuumRatio: 0.4,
  whipsawWindow: 30,
  whipsawFlipsThreshold: 12,
  correlationSpikeThreshold: 0.7,
  gapAtrMultiple: 1.5,
  gapFadeFraction: 0.5,
};

export type AlgoRegimeTier = "normal" | "elevated" | "extreme";

export type AlgoRegimeSnapshot = {
  volBurst: boolean;
  liquidityVacuum: boolean;
  whipsaw: boolean;
  correlationSpike: boolean;
  gapFade: boolean;
  /** 0..5 count of active signals. */
  score: number;
  tier: AlgoRegimeTier;
  /** Suggested execution/sizing multipliers callers can consume. */
  multipliers: {
    /** Cap on participation rate (fraction of available volume). */
    maxParticipation: number;
    /** Position-size multiplier (0..1). */
    sizeScale: number;
    /** Extra tail-hedge boost as fraction of NAV. */
    tailHedgeBoostPctNav: number;
    /** True → the guard recommends blocking new market buys this tick. */
    blockNewBuys: boolean;
  };
  reason: string;
};

function pctReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i - 1];
    if (p > 0) out.push((closes[i] - p) / p);
  }
  return out;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

export function detectVolBurst(closes: number[], cfg: AlgoRegimeConfig): boolean {
  const r = pctReturns(closes);
  if (r.length < cfg.longVolWindow + cfg.shortVolWindow) return false;
  const short = r.slice(-cfg.shortVolWindow);
  // baseline is the longVolWindow returns *preceding* the short window,
  // so a fresh burst is not diluted by including itself in the baseline.
  const long = r.slice(-(cfg.longVolWindow + cfg.shortVolWindow), -cfg.shortVolWindow);
  const sv = stdev(short);
  const lv = stdev(long);
  if (lv <= 0) return sv > 0;
  return sv / lv >= cfg.volBurstRatio;
}

export function detectLiquidityVacuum(volumes: number[] | undefined, cfg: AlgoRegimeConfig): boolean {
  if (!volumes || volumes.length < cfg.volumeWindow + 1) return false;
  const cur = volumes[volumes.length - 1];
  const hist = volumes.slice(-cfg.volumeWindow - 1, -1);
  const med = median(hist);
  if (med <= 0) return false;
  return cur / med <= cfg.liquidityVacuumRatio;
}

export function detectWhipsaw(closes: number[], cfg: AlgoRegimeConfig): boolean {
  const r = pctReturns(closes);
  if (r.length < cfg.whipsawWindow) return false;
  const w = r.slice(-cfg.whipsawWindow);
  let flips = 0;
  for (let i = 1; i < w.length; i++) {
    if (Math.sign(w[i]) !== 0 && Math.sign(w[i - 1]) !== 0 && Math.sign(w[i]) !== Math.sign(w[i - 1])) {
      flips++;
    }
  }
  return flips >= cfg.whipsawFlipsThreshold;
}

export function detectCorrelationSpike(
  crossSection: Record<string, number[]> | undefined,
  cfg: AlgoRegimeConfig,
): boolean {
  if (!crossSection) return false;
  const syms = Object.keys(crossSection);
  if (syms.length < 2) return false;
  let sum = 0, n = 0;
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      sum += Math.abs(pearson(crossSection[syms[i]], crossSection[syms[j]]));
      n++;
    }
  }
  const avg = n > 0 ? sum / n : 0;
  return avg >= cfg.correlationSpikeThreshold;
}

export function detectGapFade(
  gapPct: number | undefined,
  fadePct: number | undefined,
  closes: number[],
  cfg: AlgoRegimeConfig,
): boolean {
  if (gapPct == null || fadePct == null) return false;
  // Typical daily move proxy: stdev of recent returns.
  const r = pctReturns(closes);
  if (r.length < cfg.longVolWindow) return false;
  const typical = stdev(r.slice(-cfg.longVolWindow));
  if (typical <= 0) return false;
  const bigGap = Math.abs(gapPct) >= cfg.gapAtrMultiple * typical * 100;
  const faded = Math.sign(gapPct) !== Math.sign(fadePct)
    && Math.abs(fadePct) >= cfg.gapFadeFraction * Math.abs(gapPct);
  return bigGap && faded;
}

function tierFromScore(score: number): AlgoRegimeTier {
  if (score >= 3) return "extreme";
  if (score >= 1) return "elevated";
  return "normal";
}

function multipliersFor(tier: AlgoRegimeTier) {
  switch (tier) {
    case "extreme":
      return { maxParticipation: 0.02, sizeScale: 0.4, tailHedgeBoostPctNav: 0.01, blockNewBuys: true };
    case "elevated":
      return { maxParticipation: 0.05, sizeScale: 0.7, tailHedgeBoostPctNav: 0.005, blockNewBuys: false };
    default:
      return { maxParticipation: 0.15, sizeScale: 1.0, tailHedgeBoostPctNav: 0.0, blockNewBuys: false };
  }
}

export function detectAlgoRegime(inputs: AlgoRegimeInputs): AlgoRegimeSnapshot {
  const cfg: AlgoRegimeConfig = { ...DEFAULT_ALGO_REGIME_CONFIG, ...(inputs.config ?? {}) };
  const closes = inputs.primary.closes ?? [];
  const volBurst = detectVolBurst(closes, cfg);
  const liquidityVacuum = detectLiquidityVacuum(inputs.primary.volumes, cfg);
  const whipsaw = detectWhipsaw(closes, cfg);
  const correlationSpike = detectCorrelationSpike(inputs.crossSection, cfg);
  const gapFade = detectGapFade(inputs.overnightGapPct, inputs.openingFadePct, closes, cfg);

  const active: string[] = [];
  if (volBurst) active.push("vol_burst");
  if (liquidityVacuum) active.push("liquidity_vacuum");
  if (whipsaw) active.push("whipsaw");
  if (correlationSpike) active.push("correlation_spike");
  if (gapFade) active.push("gap_fade");

  const score = active.length;
  const tier = tierFromScore(score);
  const multipliers = multipliersFor(tier);

  return {
    volBurst,
    liquidityVacuum,
    whipsaw,
    correlationSpike,
    gapFade,
    score,
    tier,
    multipliers,
    reason: active.length ? `active: ${active.join(", ")}` : "no algo-regime signals",
  };
}
