// Sector cycle classification.
//
// Sector rotation previously only ranked sector ETFs by blended momentum and
// applied a tercile haircut. That says "which sector is relatively best" but
// never says whether a sector is actually GROWING, STAGNATING or SHRINKING —
// in a broad drawdown the "top tercile" sector can still be falling.
//
// This module turns per-sector momentum readings into an explicit cycle
// phase, relative to the cross-sector median (so a market-wide move does not
// mark every sector as growing), plus an acceleration check (30d pace vs 90d
// pace) so a fading leader is caught before its rank slips.
//
// Pure and deterministic — no IO, no clock. Safe to unit-test and to reuse
// from backtests.

export type SectorPhase = "growing" | "stagnating" | "shrinking";

export type SectorMomentumInput = {
  sector: string;
  etf: string;
  /** 30-day price change, as a fraction (0.04 = +4%). */
  momentum_30d: number | null;
  /** 90-day price change, as a fraction. */
  momentum_90d: number | null;
  /** Optional blended rotation score / rank from sector-rotation. */
  score?: number | null;
  rank?: number | null;
};

export type SectorCycleRow = {
  sector: string;
  etf: string;
  phase: SectorPhase;
  /** -1 (deeply shrinking) .. +1 (strongly growing). */
  strength: number;
  momentum_30d: number | null;
  momentum_90d: number | null;
  /** 30d momentum minus the cross-sector median 30d momentum. */
  relative_30d: number;
  /** >0 when the recent pace is faster than the 90d pace. */
  acceleration: number;
  rank: number;
  note: string;
};

export type SectorCycle = {
  rows: SectorCycleRow[];
  /** Median 30d move across sectors — the market-wide component. */
  breadth_median_30d: number;
  /** Share of sectors classified as growing (0..1). */
  breadth_growing: number;
  leaders: string[];
  laggards: string[];
};

/** A sector must beat the median by this much to count as genuinely growing. */
const REL_GROW = 0.01;
/** Below this relative reading a sector is treated as shrinking. */
const REL_SHRINK = -0.01;
/** Absolute floor/ceiling so a flat-but-relatively-strong sector stays neutral. */
const ABS_FLAT = 0.005;

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Per-day pace of the last 30 days minus the per-day pace of the last 90 days.
 * Positive = the sector is speeding up; negative = the move is fading.
 */
export function sectorAcceleration(m30: number | null, m90: number | null): number {
  if (m30 == null) return 0;
  const pace30 = m30 / 30;
  const pace90 = m90 == null ? pace30 : m90 / 90;
  return (pace30 - pace90) * 30; // re-expressed as a 30-day-equivalent gap
}

export function classifySectorCycle(inputs: SectorMomentumInput[]): SectorCycle {
  const usable = inputs.filter((i) => i.momentum_30d != null);
  const med = median(usable.map((i) => i.momentum_30d as number));

  const rows: SectorCycleRow[] = inputs.map((i) => {
    const m30 = i.momentum_30d;
    const m90 = i.momentum_90d ?? null;
    const rel = m30 == null ? 0 : m30 - med;
    const accel = sectorAcceleration(m30, m90);

    let phase: SectorPhase;
    if (m30 == null) {
      phase = "stagnating";
    } else if (m30 <= -ABS_FLAT && rel <= REL_SHRINK) {
      phase = "shrinking";
    } else if (m30 >= ABS_FLAT && rel >= REL_GROW) {
      phase = "growing";
    } else if (m30 <= -0.05) {
      // Broad-selloff case: everything is red, so nothing beats the median on
      // the downside. A sector down >5% in a month is shrinking regardless.
      phase = "shrinking";
    } else if (m30 >= 0.05 && rel > 0) {
      phase = "growing";
    } else {
      phase = "stagnating";
    }

    // Strength blends the relative move, the absolute move and acceleration.
    const raw =
      clamp(rel / 0.06, -1, 1) * 0.5 +
      clamp((m30 ?? 0) / 0.1, -1, 1) * 0.3 +
      clamp(accel / 0.04, -1, 1) * 0.2;
    let strength = clamp(raw, -1, 1);
    // Keep sign consistent with the label so downstream sizing never reads a
    // positive strength on a shrinking sector.
    if (phase === "shrinking") strength = -Math.abs(strength);
    if (phase === "growing") strength = Math.abs(strength);

    const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
    const note =
      `${i.sector}: 30d ${pct(m30)} (vs median ${pct(med)}), 90d ${pct(m90)}, ` +
      `${accel >= 0 ? "accelerating" : "fading"} → ${phase}`;

    return {
      sector: i.sector,
      etf: i.etf,
      phase,
      strength,
      momentum_30d: m30,
      momentum_90d: m90,
      relative_30d: rel,
      acceleration: accel,
      rank: i.rank ?? 0,
      note,
    };
  });

  rows.sort((a, b) => b.strength - a.strength);
  rows.forEach((r, idx) => {
    if (!r.rank) r.rank = idx + 1;
  });

  const growing = rows.filter((r) => r.phase === "growing");
  return {
    rows,
    breadth_median_30d: med,
    breadth_growing: rows.length ? growing.length / rows.length : 0,
    leaders: growing.slice(0, 3).map((r) => r.sector),
    laggards: rows.filter((r) => r.phase === "shrinking").slice(-3).map((r) => r.sector),
  };
}

export function sectorCycleFor(cycle: SectorCycle | null, sector: string | null): SectorCycleRow | null {
  if (!cycle || !sector) return null;
  return cycle.rows.find((r) => r.sector === sector) ?? null;
}

/**
 * Buy-side size multiplier from the sector's cycle phase.
 * Growing sectors get a modest boost, stagnating ones are untouched,
 * shrinking ones are cut hard. Bounded to keep any single input from
 * dominating the combined haircut stack.
 */
export function sectorPhaseMultiplier(
  row: SectorCycleRow | null,
  side: "buy" | "sell" = "buy",
): { mult: number; note: string } {
  if (!row) return { mult: 1, note: "" };
  if (side === "sell") return { mult: 1, note: "" };
  const s = Math.abs(row.strength);
  if (row.phase === "growing") {
    const mult = 1 + clamp(s, 0, 1) * 0.2; // up to ×1.20
    return { mult, note: `sector ${row.sector} growing ×${mult.toFixed(2)}` };
  }
  if (row.phase === "shrinking") {
    const mult = clamp(1 - s * 0.5, 0.5, 1); // down to ×0.50
    return { mult, note: `sector ${row.sector} shrinking ×${mult.toFixed(2)}` };
  }
  return { mult: 0.9, note: `sector ${row.sector} stagnating ×0.90` };
}

/** Compact prompt block so the AI reasons about sector cycles explicitly. */
export function formatSectorCycleBlock(cycle: SectorCycle | null): string {
  if (!cycle || cycle.rows.length === 0) return "SECTOR CYCLE: unavailable.";
  const line = (r: SectorCycleRow) =>
    `- ${r.sector} (${r.etf}): ${r.phase.toUpperCase()} | 30d ${
      r.momentum_30d == null ? "n/a" : `${(r.momentum_30d * 100).toFixed(1)}%`
    } | 90d ${
      r.momentum_90d == null ? "n/a" : `${(r.momentum_90d * 100).toFixed(1)}%`
    } | vs-median ${(r.relative_30d * 100).toFixed(1)}pp | ${
      r.acceleration >= 0 ? "accelerating" : "fading"
    } | strength ${r.strength.toFixed(2)}`;
  return [
    "SECTOR CYCLE (which sectors are growing / stagnating / shrinking right now):",
    `Market breadth: median sector 30d move ${(cycle.breadth_median_30d * 100).toFixed(1)}%, ` +
      `${(cycle.breadth_growing * 100).toFixed(0)}% of sectors growing.`,
    ...cycle.rows.map(line),
    "Rules: prefer BUYs in GROWING sectors; require a clearly stronger stock-specific case " +
      "for STAGNATING sectors; avoid new BUYs in SHRINKING sectors and prefer trimming " +
      "existing exposure there unless the name has an idiosyncratic catalyst.",
  ].join("\n");
}

/**
 * Audit record of the sector evidence behind a single order decision.
 * Persisted into `ai_decision_audit.market_inputs.sector` so the trade audit
 * trail replays the phase, the raw momentum readings and the exact sizing
 * multiplier that was applied.
 */
export type SectorDecisionAudit = {
  sector: string | null;
  etf: string | null;
  phase: SectorPhase | "unknown";
  strength: number | null;
  momentum_30d: number | null;
  momentum_90d: number | null;
  relative_30d: number | null;
  acceleration: number | null;
  rank: number | null;
  /** Cross-sector median 30d move on this tick (the market-wide component). */
  breadth_median_30d: number | null;
  breadth_growing: number | null;
  /** Phase multiplier applied to the ticket size (1 = no adjustment). */
  applied_multiplier: number;
  /** Relative-rank multiplier from sector-rotation, when applied. */
  rotation_multiplier: number | null;
  note: string;
};

export function buildSectorDecisionAudit(args: {
  cycle: SectorCycle | null;
  sector: string | null;
  row: SectorCycleRow | null;
  appliedMultiplier: number;
  rotationMultiplier?: number | null;
  note?: string;
}): SectorDecisionAudit {
  const { cycle, sector, row } = args;
  return {
    sector: sector ?? row?.sector ?? null,
    etf: row?.etf ?? null,
    phase: row?.phase ?? "unknown",
    strength: row?.strength ?? null,
    momentum_30d: row?.momentum_30d ?? null,
    momentum_90d: row?.momentum_90d ?? null,
    relative_30d: row?.relative_30d ?? null,
    acceleration: row?.acceleration ?? null,
    rank: row?.rank ?? null,
    breadth_median_30d: cycle?.breadth_median_30d ?? null,
    breadth_growing: cycle?.breadth_growing ?? null,
    applied_multiplier: Number.isFinite(args.appliedMultiplier) ? args.appliedMultiplier : 1,
    rotation_multiplier: args.rotationMultiplier ?? null,
    note: args.note ?? row?.note ?? (sector ? `${sector}: no cycle data` : "sector unknown"),
  };
}
