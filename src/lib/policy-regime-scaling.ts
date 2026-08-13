// Market-regime detection for the policy-maker nudge.
//
// The engine already persists a coarse macro label (`bull_quiet` … `crisis`)
// via `regime-detector.server.ts`. This module turns that label plus the raw
// risk signals (VIX, realised vol, index drawdown, credit/bond behaviour) into
// two orthogonal reads the nudge layer can act on:
//
//   posture  risk_on | neutral | risk_off   — what the tape is rewarding
//   vol      calm | normal | elevated | stressed — how violent the tape is
//
// and a bounded multiplier for the policy-maker nudge. Rationale: central-bank
// guidance is close to noise in a calm, trending tape (price already knows),
// and close to the only thing that matters when vol is spiking or the tape is
// de-risking. We also treat the sign asymmetrically — in a risk-off tape a
// hawkish remark should bite harder than a dovish one, and vice versa.
//
// Pure module: no I/O, no clock. Safe to import anywhere (engine, backtests).

export type RegimePosture = "risk_on" | "neutral" | "risk_off";
export type VolRegime = "calm" | "normal" | "elevated" | "stressed";

export type RegimeRiskInputs = {
  /** Persisted macro label, when available. */
  label?: string | null;
  /** Spot VIX level. */
  vix?: number | null;
  /** 20d realised daily stdev of index returns (0.01 = 1%/day). */
  realisedVol20d?: number | null;
  /** Index drawdown from the 1y high, negative (-0.12 = 12% below). */
  drawdownPct?: number | null;
  /** 30d index return, as a fraction. */
  index30dReturn?: number | null;
  /** 20d change in high-yield credit (HYG), as a fraction. */
  credit20dReturn?: number | null;
};

export type RegimeRead = {
  posture: RegimePosture;
  vol: VolRegime;
  /** Multiplier applied to the raw policy nudge, 0.5 … 1.6. */
  scale: number;
  /** 0..1 — how sure we are of the posture read (drives nothing else). */
  confidence: number;
  reason: string;
};

const RISK_OFF_LABELS = new Set(["bear", "crisis", "correction"]);
const RISK_ON_LABELS = new Set(["bull_quiet", "bull_volatile", "recovery"]);

const VOL_SCALE: Record<VolRegime, number> = {
  calm: 0.8,
  normal: 1,
  elevated: 1.25,
  stressed: 1.5,
};

const POSTURE_SCALE: Record<RegimePosture, number> = {
  risk_on: 0.9,
  neutral: 1,
  risk_off: 1.15,
};

export const POLICY_SCALE_MIN = 0.5;
export const POLICY_SCALE_MAX = 1.6;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const num = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v);

/** Volatility regime from VIX first, realised vol as the fallback. */
export function classifyVolRegime(input: RegimeRiskInputs): VolRegime {
  const vix = num(input.vix);
  if (vix != null) {
    if (vix >= 30) return "stressed";
    if (vix >= 22) return "elevated";
    if (vix >= 15) return "normal";
    return "calm";
  }
  const rv = num(input.realisedVol20d);
  if (rv != null) {
    // Daily stdev → rough VIX-equivalent bands (annualise by √252).
    const ann = rv * Math.sqrt(252) * 100;
    if (ann >= 30) return "stressed";
    if (ann >= 22) return "elevated";
    if (ann >= 15) return "normal";
    return "calm";
  }
  const label = (input.label ?? "").toLowerCase();
  if (label === "crisis") return "stressed";
  if (label === "bull_volatile" || label === "correction" || label === "bear") return "elevated";
  if (label === "bull_quiet") return "calm";
  return "normal";
}

/** Risk-on / risk-off posture from the macro label plus corroborating signals. */
export function classifyPosture(input: RegimeRiskInputs): { posture: RegimePosture; confidence: number } {
  let score = 0;
  let weight = 0;

  const label = (input.label ?? "").toLowerCase();
  if (RISK_OFF_LABELS.has(label)) {
    score += label === "correction" ? -0.6 : -1;
    weight += 1;
  } else if (RISK_ON_LABELS.has(label)) {
    score += label === "bull_volatile" ? 0.5 : 1;
    weight += 1;
  }

  const dd = num(input.drawdownPct);
  if (dd != null) {
    score += dd <= -0.15 ? -1 : dd <= -0.07 ? -0.5 : dd >= -0.02 ? 0.6 : 0;
    weight += 0.8;
  }

  const r30 = num(input.index30dReturn);
  if (r30 != null) {
    score += r30 >= 0.03 ? 0.7 : r30 <= -0.03 ? -0.7 : 0;
    weight += 0.6;
  }

  const credit = num(input.credit20dReturn);
  if (credit != null) {
    // Credit leads equities: widening high-yield (HYG down) is a risk-off tell.
    score += credit <= -0.02 ? -0.8 : credit >= 0.01 ? 0.4 : 0;
    weight += 0.6;
  }

  if (weight <= 0) return { posture: "neutral", confidence: 0 };
  const mean = score / weight;
  const posture: RegimePosture = mean >= 0.35 ? "risk_on" : mean <= -0.35 ? "risk_off" : "neutral";
  return { posture, confidence: Number(clamp(Math.abs(mean), 0, 1).toFixed(2)) };
}

/**
 * Detect the regime and derive the policy-nudge multiplier.
 * `scale` is symmetric (sign-agnostic); use `policyNudgeScaleForSign` when the
 * direction of the nudge is known.
 */
export function detectPolicyRegime(input: RegimeRiskInputs): RegimeRead {
  const vol = classifyVolRegime(input);
  const { posture, confidence } = classifyPosture(input);
  const scale = Number(
    clamp(VOL_SCALE[vol] * POSTURE_SCALE[posture], POLICY_SCALE_MIN, POLICY_SCALE_MAX).toFixed(3),
  );
  const reason =
    `${posture.replace("_", "-")} tape, ${vol} volatility` +
    `${input.label ? ` (label ${input.label})` : ""} → policy nudge ×${scale.toFixed(2)}`;
  return { posture, vol, scale, confidence, reason };
}

/**
 * Directional multiplier. In a risk-off tape hawkish (negative) guidance is
 * amplified and dovish guidance discounted; in a risk-on tape the asymmetry
 * flips, more mildly. Always clamped to [POLICY_SCALE_MIN, POLICY_SCALE_MAX].
 */
export function policyNudgeScaleForSign(read: RegimeRead, sign: number): number {
  if (sign === 0) return read.scale;
  const negative = sign < 0;
  let tilt = 1;
  if (read.posture === "risk_off") tilt = negative ? 1.1 : 0.85;
  else if (read.posture === "risk_on") tilt = negative ? 0.95 : 1.05;
  return Number(clamp(read.scale * tilt, POLICY_SCALE_MIN, POLICY_SCALE_MAX).toFixed(3));
}

/** One-line prompt/UI summary of the regime read. */
export function formatPolicyRegimeLine(read: RegimeRead): string {
  return `POLICY-NUDGE REGIME: ${read.posture.replace("_", "-")} / ${read.vol} vol — policy-maker guidance weighted ×${read.scale.toFixed(2)} (confidence ${(read.confidence * 100).toFixed(0)}%).`;
}
