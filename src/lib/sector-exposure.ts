// Portfolio sector exposure over time.
//
// Answers "how is the book tilted toward growing vs shrinking sectors?" by
// replaying executed trades into a daily position book, valuing each position
// with the daily close (already normalised to base currency by the caller),
// mapping the symbol to a sector, and bucketing that value by the sector's
// cycle phase for that same day.
//
// Pure and deterministic: no IO, no clock. The caller supplies the calendar,
// the price series, the sector map and the per-day phases.

import type { SectorPhase } from "./sector-cycle";

export type ExposureTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** YYYY-MM-DD */
  trade_date: string;
};

export type ExposurePricePoint = { date: string; close: number };

export type SectorExposureInput = {
  /** Ordered oldest -> newest list of YYYY-MM-DD days to report. */
  days: string[];
  trades: ExposureTrade[];
  /** symbol -> ordered close series in BASE currency. */
  prices: Record<string, ExposurePricePoint[]>;
  /** symbol -> sector key, or null/absent when unclassified. */
  sectorOf: Record<string, string | null>;
  /** day -> (sector -> phase). Falls back to the latest earlier day. */
  phasesByDay: Record<string, Record<string, SectorPhase>>;
  /** Optional day -> cash in base currency, rendered alongside exposure. */
  cashByDay?: Record<string, number>;
};

export type SectorExposurePoint = {
  date: string;
  growing: number;
  stagnating: number;
  shrinking: number;
  unclassified: number;
  invested: number;
  cash: number;
  /** Share of invested value in growing sectors (0..1). */
  growingPct: number;
  stagnatingPct: number;
  shrinkingPct: number;
  unclassifiedPct: number;
  /** growingPct - shrinkingPct, in -1..+1. Positive = tilted to growth. */
  tilt: number;
};

export type SectorExposureSeries = {
  points: SectorExposurePoint[];
  /** Latest per-sector value, largest first. */
  latestBySector: Array<{ sector: string; phase: SectorPhase | "unclassified"; value: number; pct: number }>;
  /** Mean tilt across the window. */
  averageTilt: number;
  /** Tilt change from first to last point. */
  tiltChange: number;
};

const UNCLASSIFIED = "unclassified";

/** Last close on or before `day`, walking a pre-sorted series. */
function closeOnOrBefore(series: ExposurePricePoint[] | undefined, day: string): number | null {
  if (!series || series.length === 0) return null;
  let out: number | null = null;
  for (const p of series) {
    if (p.date > day) break;
    if (Number.isFinite(p.close)) out = p.close;
  }
  return out;
}

/** Phase map for `day`, falling back to the most recent earlier day. */
function phasesFor(
  phasesByDay: Record<string, Record<string, SectorPhase>>,
  sortedKeys: string[],
  day: string,
): Record<string, SectorPhase> {
  const exact = phasesByDay[day];
  if (exact) return exact;
  let best: Record<string, SectorPhase> = {};
  for (const k of sortedKeys) {
    if (k > day) break;
    best = phasesByDay[k];
  }
  return best;
}

export function buildSectorExposureSeries(input: SectorExposureInput): SectorExposureSeries {
  const days = input.days.slice().sort();
  const phaseKeys = Object.keys(input.phasesByDay).sort();

  // Net quantity per symbol accumulated as we walk the calendar forward.
  const qty = new Map<string, number>();
  const tradesByDay = new Map<string, ExposureTrade[]>();
  for (const t of input.trades) {
    const arr = tradesByDay.get(t.trade_date) ?? [];
    arr.push(t);
    tradesByDay.set(t.trade_date, arr);
  }
  // Trades that pre-date the window still count toward the opening book.
  const firstDay = days[0];
  if (firstDay) {
    for (const t of input.trades) {
      if (t.trade_date >= firstDay) continue;
      const q = Number(t.quantity);
      if (!Number.isFinite(q)) continue;
      const next = (qty.get(t.symbol) ?? 0) + (t.side === "sell" ? -q : q);
      // Never let attribution go short — a stale sell must not invent a
      // negative position that flips the tilt sign.
      qty.set(t.symbol, Math.max(0, next));
    }
  }

  const points: SectorExposurePoint[] = [];
  let latestPerSector: Map<string, number> = new Map();
  let latestPhases: Record<string, SectorPhase> = {};

  for (const day of days) {
    for (const t of tradesByDay.get(day) ?? []) {
      const q = Number(t.quantity);
      if (!Number.isFinite(q)) continue;
      const next = (qty.get(t.symbol) ?? 0) + (t.side === "sell" ? -q : q);
      qty.set(t.symbol, Math.max(0, next));
    }

    const phases = phasesFor(input.phasesByDay, phaseKeys, day);
    const perSector = new Map<string, number>();
    const buckets = { growing: 0, stagnating: 0, shrinking: 0, unclassified: 0 };

    for (const [symbol, q] of qty) {
      if (q <= 0) continue;
      const close = closeOnOrBefore(input.prices[symbol], day);
      if (close == null) continue;
      const value = q * close;
      if (!Number.isFinite(value) || value <= 0) continue;
      const sector = input.sectorOf[symbol] ?? UNCLASSIFIED;
      perSector.set(sector, (perSector.get(sector) ?? 0) + value);
      const phase = sector === UNCLASSIFIED ? null : phases[sector];
      if (phase === "growing") buckets.growing += value;
      else if (phase === "shrinking") buckets.shrinking += value;
      else if (phase === "stagnating") buckets.stagnating += value;
      else buckets.unclassified += value;
    }

    const invested = buckets.growing + buckets.stagnating + buckets.shrinking + buckets.unclassified;
    const pct = (v: number) => (invested > 0 ? v / invested : 0);
    points.push({
      date: day,
      growing: buckets.growing,
      stagnating: buckets.stagnating,
      shrinking: buckets.shrinking,
      unclassified: buckets.unclassified,
      invested,
      cash: input.cashByDay?.[day] ?? 0,
      growingPct: pct(buckets.growing),
      stagnatingPct: pct(buckets.stagnating),
      shrinkingPct: pct(buckets.shrinking),
      unclassifiedPct: pct(buckets.unclassified),
      tilt: pct(buckets.growing) - pct(buckets.shrinking),
    });

    if (invested > 0 || perSector.size > 0) {
      latestPerSector = perSector;
      latestPhases = phases;
    }
  }

  const latestInvested = [...latestPerSector.values()].reduce((a, b) => a + b, 0);
  const latestBySector = [...latestPerSector.entries()]
    .map(([sector, value]) => ({
      sector,
      phase: (sector === UNCLASSIFIED ? "unclassified" : latestPhases[sector] ?? "unclassified") as
        | SectorPhase
        | "unclassified",
      value,
      pct: latestInvested > 0 ? value / latestInvested : 0,
    }))
    .sort((a, b) => b.value - a.value || a.sector.localeCompare(b.sector));

  const withValue = points.filter((p) => p.invested > 0);
  const averageTilt =
    withValue.length > 0 ? withValue.reduce((a, p) => a + p.tilt, 0) / withValue.length : 0;
  const tiltChange =
    withValue.length > 1 ? withValue[withValue.length - 1].tilt - withValue[0].tilt : 0;

  return { points, latestBySector, averageTilt, tiltChange };
}

/** Inclusive list of YYYY-MM-DD days between two dates. */
export function dayRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function sectorLabel(sector: string): string {
  if (sector === UNCLASSIFIED) return "Unclassified";
  return sector
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
