// Measures every event in the curated global-events reel (`global-events.ts`)
// against the real index series the app stores, so the learning layer studies
// the *whole* reel rather than only the 2005+ episode catalogue.
//
// Pure and deterministic: no I/O, no LLM. The AI layer only interprets the
// output; every number it proposes is re-clamped elsewhere.

import { GLOBAL_EVENTS, type EventCategory, type GlobalEvent } from "./global-events";
import type { IndexBar } from "./macro-history";

export type GlobalEventMeasurement = {
  id: string;
  label: string;
  category: EventCategory;
  severity: 1 | 2 | 3;
  start: string;
  end: string;
  /** False when the index series does not cover the event window at all. */
  covered: boolean;
  /** Index % change over the 20 sessions before the event window opened. */
  run_up_20d: number | null;
  /** Peak-to-trough % fall inside the window, measured from the pre-event peak. */
  drawdown_pct: number | null;
  /** Index % change across the window itself (first → last bar in window). */
  window_pct: number | null;
  /** Forward % change from the last bar in the window. */
  fwd_20d: number | null;
  fwd_60d: number | null;
  fwd_250d: number | null;
  /** Calendar days from the in-window trough back to the pre-event peak. */
  recovery_days: number | null;
  /** Realised vol inside the window ÷ realised vol over the prior 60 sessions. */
  vol_ratio: number | null;
};

export type EventCategoryStat = {
  category: EventCategory;
  events: number;
  mean_drawdown_pct: number;
  median_recovery_days: number | null;
  mean_fwd_20d: number;
  mean_fwd_60d: number;
  mean_fwd_250d: number;
  /** Share of events whose 60-session forward return was positive. */
  up_rate_60d: number;
  mean_vol_ratio: number;
  /** Deterministic stance implied by the measurement. */
  stance: "buy_the_dip" | "wait_for_turn" | "de_risk" | "neutral";
  note: string;
};

export type GlobalEventStudy = {
  events_total: number;
  events_measured: number;
  from: string;
  to: string;
  measurements: GlobalEventMeasurement[];
  categories: EventCategoryStat[];
  /** Severity-3 events only — the market-defining set. */
  severe: { events: number; mean_drawdown_pct: number; mean_fwd_250d: number };
};

function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

function round(n: number, dp = 2): number {
  return Number(n.toFixed(dp));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((s, v) => s + v, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

function realisedVol(bars: IndexBar[], from: number, to: number): number | null {
  const rets: number[] = [];
  for (let i = Math.max(1, from); i <= to && i < bars.length; i++) {
    rets.push(pct(bars[i]!.close, bars[i - 1]!.close));
  }
  if (rets.length < 5) return null;
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/** Measure one reel event against an ascending index series. */
export function measureGlobalEvent(event: GlobalEvent, bars: IndexBar[]): GlobalEventMeasurement {
  const base: GlobalEventMeasurement = {
    id: event.id,
    label: event.label,
    category: event.category,
    severity: event.severity,
    start: event.start,
    end: event.end,
    covered: false,
    run_up_20d: null,
    drawdown_pct: null,
    window_pct: null,
    fwd_20d: null,
    fwd_60d: null,
    fwd_250d: null,
    recovery_days: null,
    vol_ratio: null,
  };
  if (bars.length < 30) return base;

  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]!.date;
    if (d >= event.start && d <= event.end) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  // Single-day events can fall on a market holiday: snap to the next session.
  if (firstIdx === -1) {
    const idx = bars.findIndex((b) => b.date >= event.start);
    if (idx === -1 || bars[idx]!.date > event.end) return base;
    firstIdx = idx;
    lastIdx = idx;
  }

  const preIdx = Math.max(0, firstIdx - 1);
  const prePeak = Math.max(...bars.slice(Math.max(0, firstIdx - 20), firstIdx + 1).map((b) => b.close));
  let troughIdx = firstIdx;
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (bars[i]!.close < bars[troughIdx]!.close) troughIdx = i;
  }

  let recovery: number | null = null;
  for (let i = troughIdx + 1; i < bars.length; i++) {
    if (bars[i]!.close >= prePeak) {
      recovery = Math.round((Date.parse(bars[i]!.date) - Date.parse(bars[troughIdx]!.date)) / 86_400_000);
      break;
    }
  }

  const fwdAt = (sessions: number): number | null => {
    const j = lastIdx + sessions;
    return j < bars.length ? round(pct(bars[j]!.close, bars[lastIdx]!.close)) : null;
  };

  const priorVol = realisedVol(bars, firstIdx - 60, firstIdx);
  const windowVol = realisedVol(bars, firstIdx, lastIdx);

  return {
    ...base,
    covered: true,
    run_up_20d: firstIdx >= 20 ? round(pct(bars[preIdx]!.close, bars[firstIdx - 20]!.close)) : null,
    drawdown_pct: round(Math.max(0, -pct(bars[troughIdx]!.close, prePeak))),
    window_pct: round(pct(bars[lastIdx]!.close, bars[firstIdx]!.close)),
    fwd_20d: fwdAt(20),
    fwd_60d: fwdAt(60),
    fwd_250d: fwdAt(250),
    recovery_days: recovery,
    vol_ratio: priorVol && windowVol && priorVol > 0 ? round(windowVol / priorVol) : null,
  };
}

function stanceFor(
  category: EventCategory,
  meanFwd60: number,
  upRate60: number,
  medianRecovery: number | null,
  meanDd: number,
): { stance: EventCategoryStat["stance"]; why: string } {
  const slowHole = medianRecovery != null && medianRecovery > 365;
  if (slowHole && meanDd >= 15) {
    return { stance: "de_risk", why: "deep and slow to heal — capital preservation beat dip-buying" };
  }
  if (meanFwd60 >= 3 && upRate60 >= 0.6) {
    return { stance: "buy_the_dip", why: "the index was reliably higher two months later" };
  }
  if (meanFwd60 <= -1 || upRate60 <= 0.4) {
    return { stance: "wait_for_turn", why: "the first move kept going against buyers" };
  }
  return { stance: "neutral", why: "no consistent forward edge in either direction" };
}

/** Aggregate the measured reel by event category. */
export function summariseByCategory(measurements: GlobalEventMeasurement[]): EventCategoryStat[] {
  const byCat = new Map<EventCategory, GlobalEventMeasurement[]>();
  for (const m of measurements) {
    if (!m.covered) continue;
    byCat.set(m.category, [...(byCat.get(m.category) ?? []), m]);
  }

  const out: EventCategoryStat[] = [];
  for (const [category, list] of byCat) {
    const f60 = list.map((m) => m.fwd_60d).filter((v): v is number => v != null);
    const meanFwd60 = mean(f60);
    const upRate = f60.length > 0 ? Number((f60.filter((v) => v > 0).length / f60.length).toFixed(3)) : 0;
    const meanDd = mean(list.map((m) => m.drawdown_pct).filter((v): v is number => v != null));
    const medRec = median(list.map((m) => m.recovery_days).filter((v): v is number => v != null));
    const { stance, why } = stanceFor(category, meanFwd60, upRate, medRec, meanDd);
    out.push({
      category,
      events: list.length,
      mean_drawdown_pct: meanDd,
      median_recovery_days: medRec,
      mean_fwd_20d: mean(list.map((m) => m.fwd_20d).filter((v): v is number => v != null)),
      mean_fwd_60d: meanFwd60,
      mean_fwd_250d: mean(list.map((m) => m.fwd_250d).filter((v): v is number => v != null)),
      up_rate_60d: upRate,
      mean_vol_ratio: mean(list.map((m) => m.vol_ratio).filter((v): v is number => v != null)),
      stance,
      note:
        `${list.length} measured ${category} event(s): average ${meanDd}% fall, ` +
        `${medRec == null ? "no completed recovery" : `${medRec} days back to the old high`}, ` +
        `${meanFwd60 >= 0 ? "+" : ""}${meanFwd60}% over the next 60 sessions (${Math.round(upRate * 100)}% positive) — ${why}.`,
    });
  }
  return out.sort((a, b) => b.events - a.events);
}

/** Full study of the curated reel against one index series. */
export function studyGlobalEvents(
  bars: IndexBar[],
  events: GlobalEvent[] = GLOBAL_EVENTS,
): GlobalEventStudy {
  const sorted = [...bars]
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const measurements = events
    .map((e) => measureGlobalEvent(e, sorted))
    .sort((a, b) => a.start.localeCompare(b.start));
  const covered = measurements.filter((m) => m.covered);
  const severe = covered.filter((m) => m.severity === 3);

  return {
    events_total: events.length,
    events_measured: covered.length,
    from: sorted[0]?.date ?? "",
    to: sorted[sorted.length - 1]?.date ?? "",
    measurements,
    categories: summariseByCategory(measurements),
    severe: {
      events: severe.length,
      mean_drawdown_pct: mean(severe.map((m) => m.drawdown_pct).filter((v): v is number => v != null)),
      mean_fwd_250d: mean(severe.map((m) => m.fwd_250d).filter((v): v is number => v != null)),
    },
  };
}

/** Compact, prompt-ready description of what the reel taught. */
export function formatGlobalEventBlock(study: GlobalEventStudy | null | undefined): string {
  if (!study || study.events_measured === 0) return "";
  const lines = [
    `GLOBAL EVENT REEL (${study.events_measured}/${study.events_total} curated events measured against the index, ${study.from} → ${study.to}):`,
  ];
  for (const c of study.categories) {
    lines.push(`  • ${c.category}: ${c.stance.replace(/_/g, " ").toUpperCase()} — ${c.note}`);
  }
  lines.push(
    `  • Market-defining (severity 3) events: ${study.severe.events} measured, average ${study.severe.mean_drawdown_pct}% fall, ${study.severe.mean_fwd_250d >= 0 ? "+" : ""}${study.severe.mean_fwd_250d}% over the following year.`,
  );
  return lines.join("\n");
}
