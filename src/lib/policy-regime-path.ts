// How a persisted regime scale was resolved on replay.
//
// The engine writes `raw.policy_regime` on every run. Production blobs are not
// always clean: old runs predate the field, some carry a posture but no scale,
// and a few carry junk (strings, NaN, values outside the bound). The explain
// panel must reproduce the engine's multiplier exactly, so it walks one of a
// small number of resolution paths. This module names those paths so the UI can
// show which one each case took instead of silently degrading to ×1.
//
// Pure module: no I/O, no clock.

import {
  POLICY_SCALE_MAX,
  POLICY_SCALE_MIN,
  policyNudgeScaleForSign,
  policyScaleForRegime,
  type RegimePosture,
  type RegimeRead,
  type VolRegime,
} from "@/lib/policy-regime-scaling";

export type RegimeScalePath =
  /** Persisted scale was finite and in-bound; used verbatim. */
  | "exact"
  /** Scale was missing/unusable but posture+vol were readable; recomputed from the table. */
  | "recomputed"
  /** A usable scale existed but a bound bit — either the stored value or the sign tilt. */
  | "clamped"
  /** Nothing usable persisted; the neutral ×1 fallback applied. */
  | "fallback";

export const REGIME_PATH_LABEL: Record<RegimeScalePath, string> = {
  exact: "Exact",
  recomputed: "Recomputed",
  clamped: "Clamped",
  fallback: "Fallback ×1",
};

export const REGIME_PATH_HINT: Record<RegimeScalePath, string> = {
  exact: "The run's stored multiplier was valid and used as-is.",
  recomputed: "The stored multiplier was missing or unusable, so it was rebuilt from the stored regime.",
  clamped: "A bound was hit — the stored value or its directional tilt exceeded the allowed range.",
  fallback: "No usable regime was stored for this run, so the nudge was left unscaled.",
};

const POSTURES: RegimePosture[] = ["risk_on", "neutral", "risk_off"];
const VOLS: VolRegime[] = ["calm", "normal", "elevated", "stressed"];

export type RegimeScaleDiagnostic = {
  path: RegimeScalePath;
  /** Multiplier before the directional tilt. */
  scale: number;
  /** Multiplier actually applied to the nudge, after the sign tilt and clamp. */
  appliedScale: number;
  /** What was stored, when it was a finite number. */
  storedScale: number | null;
  posture: RegimePosture;
  vol: VolRegime;
  /** True when posture/vol had to be defaulted. */
  postureDefaulted: boolean;
  volDefaulted: boolean;
  /** True when the directional tilt (not the stored value) hit a bound. */
  signClamped: boolean;
  /** Sign of the nudge the scale was resolved for (0 = unsigned probe). */
  sign: number;
  notes: string[];
};

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Coerce a JSONB value to a string without ever throwing. `String(x)` blows up
 * on null-prototype objects and Symbols, both of which show up in dirty blobs.
 */
function safeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

/** Coerce to a finite number, or null. Never NaN, never Infinity, never throws. */
function safeNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "boolean" || typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}


/**
 * Resolve a persisted `policy_regime` blob into the multiplier the engine used,
 * and record which path got us there.
 */
export function resolveRegimeScalePath(blob: unknown, sign = 0): RegimeScaleDiagnostic {
  const notes: string[] = [];
  const obj =
    blob && typeof blob === "object" && !Array.isArray(blob)
      ? (blob as Record<string, unknown>)
      : null;

  if (!obj) {
    if (blob != null) notes.push("Stored regime was not an object.");
    else notes.push("No regime recorded on this run.");
    return {
      path: "fallback",
      scale: 1,
      appliedScale: 1,
      storedScale: null,
      posture: "neutral",
      vol: "normal",
      postureDefaulted: true,
      volDefaulted: true,
      signClamped: false,
      sign,
      notes,
    };
  }

  const rawPosture = safeString(obj.posture);
  const rawVol = safeString(obj.vol);
  const postureOk = (POSTURES as string[]).includes(rawPosture);
  const volOk = (VOLS as string[]).includes(rawVol);
  const posture = (postureOk ? rawPosture : "neutral") as RegimePosture;
  const vol = (volOk ? rawVol : "normal") as VolRegime;
  if (!postureOk) notes.push(`Posture ${rawPosture ? `"${rawPosture}"` : "missing"} — defaulted to neutral.`);
  if (!volOk) notes.push(`Volatility band ${rawVol ? `"${rawVol}"` : "missing"} — defaulted to normal.`);

  const storedRaw = obj.scale;
  const stored = safeNumber(storedRaw);


  let path: RegimeScalePath;
  let scale: number;

  if (stored == null) {
    if (postureOk || volOk) {
      scale = policyScaleForRegime(posture, vol);
      path = "recomputed";
      notes.push(
        `Stored multiplier ${storedRaw == null ? "missing" : "unusable"} — rebuilt ×${scale.toFixed(2)} from ${posture.replace("_", "-")}/${vol}.`,
      );
    } else {
      scale = 1;
      path = "fallback";
      notes.push("Nothing usable in the stored regime — nudge left unscaled.");
    }
  } else if (stored < POLICY_SCALE_MIN || stored > POLICY_SCALE_MAX) {
    scale = Math.max(POLICY_SCALE_MIN, Math.min(POLICY_SCALE_MAX, stored));
    path = "clamped";
    notes.push(`Stored ×${stored.toFixed(2)} was outside the allowed range — clamped to ×${scale.toFixed(2)}.`);
  } else {
    scale = stored;
    path = "exact";
  }

  const read: RegimeRead = { posture, vol, scale, confidence: 0, reason: String(obj.reason ?? "") };
  const appliedScale = sign === 0 ? scale : policyNudgeScaleForSign(read, sign);
  const untilted = sign === 0 ? scale : scale * tiltFor(posture, sign);
  const signClamped =
    sign !== 0 && Math.abs(untilted - appliedScale) > 1e-9 && path !== "fallback";
  if (signClamped) {
    notes.push(
      `Directional tilt pushed the multiplier to the ${appliedScale <= POLICY_SCALE_MIN ? "floor" : "ceiling"} (×${appliedScale.toFixed(2)}).`,
    );
    path = "clamped";
  }

  return {
    path,
    scale,
    appliedScale,
    storedScale: stored,
    posture,
    vol,
    postureDefaulted: !postureOk,
    volDefaulted: !volOk,
    signClamped,
    sign,
    notes,
  };
}

/** Mirror of the tilt inside `policyNudgeScaleForSign`, used to spot bound hits. */
function tiltFor(posture: RegimePosture, sign: number): number {
  const negative = sign < 0;
  if (posture === "risk_off") return negative ? 1.1 : 0.85;
  if (posture === "risk_on") return negative ? 0.95 : 1.05;
  return 1;
}

/** Roll per-case paths into counts for a summary strip. */
export function summariseRegimePaths(
  paths: RegimeScalePath[],
): Array<{ path: RegimeScalePath; count: number }> {
  const order: RegimeScalePath[] = ["exact", "recomputed", "clamped", "fallback"];
  const counts = new Map<RegimeScalePath, number>();
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  return order
    .filter((p) => counts.has(p))
    .map((p) => ({ path: p, count: counts.get(p) ?? 0 }));
}
