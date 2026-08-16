/**
 * Loss post-mortem memory.
 *
 * Turns realised round-trips into a decaying, per-symbol memory of *how* the
 * book actually lost money, so the engine (a) hesitates before re-entering a
 * name that has repeatedly cost it, (b) carries a tighter initial stop into
 * those names, and (c) can show the reasoning in plain English.
 *
 * Deliberately deterministic and bounded — this is a nudge, not a veto, and
 * it decays so a single bad month can't blacklist a symbol forever.
 *
 * Pure and I/O-free; the caller supplies the round-trips.
 */

export type RoundTrip = {
  symbol: string;
  /** ISO date the position was closed. */
  exitDate: string;
  /** Realised return, e.g. −0.07 for −7%. */
  returnPct: number;
  /** Calendar days held. */
  holdDays: number;
  /** Free-text exit reason recorded on the sell (used for cause attribution). */
  exitReason: string | null;
  /** Round-trip costs (fees + tax + spread) as a fraction of the position. */
  costPct?: number | null;
};

export type LossCause =
  | "stop_too_wide"
  | "held_too_long"
  | "cost_drag"
  | "thesis_break"
  | "adverse_move";

export type SymbolPostmortem = {
  symbol: string;
  trips: number;
  losses: number;
  /** Decay-weighted average realised return across the window. */
  weightedAvgReturnPct: number;
  /** Worst single realised loss in the window. */
  worstLossPct: number;
  causes: LossCause[];
  /** Bounded score penalty, −MAX_LOSS_PENALTY..0, applied to the blend. */
  penalty: number;
  /** Multiply the configured stop distance by this (≤1 = tighter). */
  stopTightenMult: number;
  note: string;
};

/** Hard cap on how far a symbol's own loss history can move its score. */
export const MAX_LOSS_PENALTY = 0.18;
/** Weight halves every this many days, so old pain fades. */
export const LOSS_HALF_LIFE_DAYS = 60;
/** Tightest the memory is ever allowed to pull a stop in. */
export const MIN_STOP_TIGHTEN = 0.6;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function decayWeight(exitDate: string, asOf: string): number {
  const a = Date.parse(`${exitDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const days = Math.max(0, (b - a) / 86_400_000);
  return Math.pow(0.5, days / LOSS_HALF_LIFE_DAYS);
}

function attributeCause(t: RoundTrip): LossCause {
  const reason = (t.exitReason ?? "").toLowerCase();
  const cost = t.costPct ?? 0;
  if (cost > 0 && Math.abs(t.returnPct) <= cost * 1.2) return "cost_drag";
  if (reason.includes("thesis break")) return "thesis_break";
  if (reason.includes("max-hold") || reason.includes("time-stop") || t.holdDays >= 45) {
    return "held_too_long";
  }
  if (reason.includes("stop-loss") && t.returnPct <= -0.06) return "stop_too_wide";
  return "adverse_move";
}

/** Aggregate one symbol's round-trips into a bounded, decaying memory. */
export function summariseSymbolLosses(
  symbol: string,
  trips: RoundTrip[],
  asOf: string,
): SymbolPostmortem | null {
  if (trips.length === 0) return null;

  let wSum = 0;
  let wRet = 0;
  let losses = 0;
  let worst = 0;
  const causeCount = new Map<LossCause, number>();

  for (const t of trips) {
    const w = decayWeight(t.exitDate, asOf);
    if (w <= 0.01) continue;
    wSum += w;
    wRet += w * t.returnPct;
    if (t.returnPct < 0) {
      losses += 1;
      worst = Math.min(worst, t.returnPct);
      const c = attributeCause(t);
      causeCount.set(c, (causeCount.get(c) ?? 0) + 1);
    }
  }
  if (wSum <= 0) return null;

  const weightedAvgReturnPct = wRet / wSum;
  const causes = [...causeCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);

  // Penalty only for a net-negative decayed record. Scales with how bad the
  // average was and how repeatedly it happened, then hard-capped.
  let penalty = 0;
  if (weightedAvgReturnPct < 0) {
    const severity = clamp(Math.abs(weightedAvgReturnPct) / 0.10, 0, 1);
    const repetition = clamp(losses / 3, 0.34, 1);
    penalty = -MAX_LOSS_PENALTY * severity * repetition;
  }

  // Tighten the stop when the record says we sat through big adverse moves.
  let stopTightenMult = 1;
  if (causes[0] === "stop_too_wide" || worst <= -0.10) {
    stopTightenMult = clamp(1 - Math.abs(worst) * 2, MIN_STOP_TIGHTEN, 1);
  } else if (causes[0] === "held_too_long") {
    stopTightenMult = 0.85;
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const note =
    losses === 0
      ? `${symbol}: ${trips.length} closed trip(s), decayed avg ${pct(weightedAvgReturnPct)} — no penalty.`
      : `${symbol}: ${losses}/${trips.length} losing trip(s), decayed avg ${pct(weightedAvgReturnPct)}, worst ${pct(worst)}; ` +
        `main cause ${causes[0]?.replace(/_/g, " ")}. Score ${pct(penalty)}, stop ×${stopTightenMult.toFixed(2)}.`;

  return {
    symbol,
    trips: trips.length,
    losses,
    weightedAvgReturnPct,
    worstLossPct: worst,
    causes,
    penalty: Number(penalty.toFixed(4)),
    stopTightenMult: Number(stopTightenMult.toFixed(3)),
    note,
  };
}

/** Build the full symbol → post-mortem map from a flat list of round-trips. */
export function buildLossPostmortems(
  trips: RoundTrip[],
  asOf: string,
): Map<string, SymbolPostmortem> {
  const bySymbol = new Map<string, RoundTrip[]>();
  for (const t of trips) {
    const key = t.symbol.toUpperCase();
    const list = bySymbol.get(key);
    if (list) list.push(t);
    else bySymbol.set(key, [t]);
  }
  const out = new Map<string, SymbolPostmortem>();
  for (const [sym, list] of bySymbol) {
    const s = summariseSymbolLosses(sym, list, asOf);
    if (s) out.set(sym, s);
  }
  return out;
}

/** Prompt block so the model sees the same memory the maths uses. */
export function formatLossPostmortemBlock(map: Map<string, SymbolPostmortem>): string {
  const penalised = [...map.values()]
    .filter((p) => p.penalty < 0)
    .sort((a, b) => a.penalty - b.penalty)
    .slice(0, 12);
  if (penalised.length === 0) {
    return "LOSS POST-MORTEM: no symbol has a net-negative recent record — no penalties applied.";
  }
  const lines = penalised.map((p) => `- ${p.note}`);
  return [
    "LOSS POST-MORTEM (decaying memory of realised round-trips; already applied to scores):",
    ...lines,
    "Treat these names as guilty until proven innocent: require clearly stronger evidence before re-entering, and cut them faster if they go against you.",
  ].join("\n");
}
