// Pure detection of "notable moves" on a market drill-down chart.
//
// The AI layer only *explains* what this module finds — event detection itself
// is deterministic so the same chart always annotates the same points, and a
// gateway outage degrades to plain wording rather than an empty chart.

import type { HistoryPoint } from "./market-symbol-history";

export type ChartEventKind =
  | "spike_up"
  | "spike_down"
  | "golden_cross"
  | "death_cross"
  | "drawdown_trough"
  | "vol_regime"
  | "range_high"
  | "range_low";

export interface ChartEvent {
  /** Stable id inside one chart window, used to match AI notes back to points. */
  id: string;
  kind: ChartEventKind;
  /** Index into the history points array. */
  index: number;
  date: string;
  close: number;
  /** Signed size of the move in %, where the event has one. */
  magnitudePct: number | null;
  /** Deterministic short label, always safe to render. */
  label: string;
  /** Deterministic one-liner used as the fallback when AI is unavailable. */
  fallbackNote: string;
}

export interface ChartAnnotation extends ChartEvent {
  /** Plain-English explanation — AI wording when available, else fallbackNote. */
  note: string;
  /** Model id that wrote `note`, or null when the deterministic text was used. */
  model: string | null;
  /**
   * The exact headlines shown to the model as candidate drivers for this
   * event, so the wording can be checked against its evidence.
   */
  sources: AnnotationNewsItem[];
}

export interface AnnotationNewsItem {
  /** Publication day (YYYY-MM-DD) as stored in the news cache. */
  date: string;
  headline: string;
  source?: string | null;
  url?: string | null;
  /** Ingest timestamp (ISO), used for the displayed time. */
  at?: string | null;
}


const MAX_EVENTS = 6;

function pctStr(v: number, digits = 1): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Find the handful of points on this window worth annotating: outsized daily
 * moves, moving-average crossovers, the drawdown trough, a volatility regime
 * shift, and the window's high/low.
 */
export function detectChartEvents(points: HistoryPoint[], label = "this market"): ChartEvent[] {
  if (points.length < 5) return [];

  const rets: Array<{ index: number; ret: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].close;
    if (prev > 0) rets.push({ index: i, ret: (points[i].close / prev - 1) * 100 });
  }
  if (!rets.length) return [];

  const sigma = stdev(rets.map((r) => r.ret));
  const threshold = Math.max(1.5, sigma * 2.2);
  const events: ChartEvent[] = [];
  const push = (e: Omit<ChartEvent, "id">) => {
    events.push({ ...e, id: `${e.kind}:${e.date}` });
  };

  // Outsized daily moves — biggest up and biggest down, if they clear the bar.
  const sorted = [...rets].sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret));
  let ups = 0;
  let downs = 0;
  for (const r of sorted) {
    if (Math.abs(r.ret) < threshold) break;
    const isUp = r.ret > 0;
    if (isUp && ups >= 1) continue;
    if (!isUp && downs >= 1) continue;
    if (isUp) ups++;
    else downs++;
    const p = points[r.index];
    push({
      kind: isUp ? "spike_up" : "spike_down",
      index: r.index,
      date: p.date,
      close: p.close,
      magnitudePct: r.ret,
      label: `${pctStr(r.ret)} in a day`,
      fallbackNote: `${label} moved ${pctStr(r.ret)} on ${p.date}, an unusually large single-day move for this window.`,
    });
    if (ups >= 1 && downs >= 1) break;
  }

  // Moving-average crossovers.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.sma50 == null || a.sma200 == null || b.sma50 == null || b.sma200 == null) continue;
    const was = a.sma50 - a.sma200;
    const now = b.sma50 - b.sma200;
    if (was <= 0 && now > 0) {
      push({
        kind: "golden_cross",
        index: i,
        date: b.date,
        close: b.close,
        magnitudePct: null,
        label: "50-day crossed above 200-day",
        fallbackNote: `The 50-day average rose above the 200-day average on ${b.date} — a shift towards an uptrend.`,
      });
    } else if (was >= 0 && now < 0) {
      push({
        kind: "death_cross",
        index: i,
        date: b.date,
        close: b.close,
        magnitudePct: null,
        label: "50-day crossed below 200-day",
        fallbackNote: `The 50-day average fell below the 200-day average on ${b.date} — a shift towards a downtrend.`,
      });
    }
  }

  // Drawdown trough.
  let peak = 0;
  let worst = 0;
  let worstIdx = -1;
  for (let i = 0; i < points.length; i++) {
    peak = Math.max(peak, points[i].close);
    if (peak > 0) {
      const dd = ((points[i].close - peak) / peak) * 100;
      if (dd < worst) {
        worst = dd;
        worstIdx = i;
      }
    }
  }
  if (worstIdx >= 0 && worst <= -5) {
    const p = points[worstIdx];
    push({
      kind: "drawdown_trough",
      index: worstIdx,
      date: p.date,
      close: p.close,
      magnitudePct: worst,
      label: `Low point (${pctStr(worst)} off the high)`,
      fallbackNote: `The deepest fall in this window bottomed on ${p.date}, ${pctStr(worst)} below the prior peak.`,
    });
  }

  // Volatility regime shift: second half vs first half of the window.
  if (rets.length >= 20) {
    const mid = Math.floor(rets.length / 2);
    const early = stdev(rets.slice(0, mid).map((r) => r.ret));
    const late = stdev(rets.slice(mid).map((r) => r.ret));
    if (early > 0 && (late / early >= 1.6 || early / late >= 1.6)) {
      const idx = rets[mid].index;
      const p = points[idx];
      const calmer = late < early;
      push({
        kind: "vol_regime",
        index: idx,
        date: p.date,
        close: p.close,
        magnitudePct: null,
        label: calmer ? "Calmer trading from here" : "Choppier trading from here",
        fallbackNote: calmer
          ? `Day-to-day swings roughly halved after ${p.date} — a calmer regime for ${label}.`
          : `Day-to-day swings widened sharply after ${p.date} — a more volatile regime for ${label}.`,
      });
    }
  }

  // Window high and low.
  let hiIdx = 0;
  let loIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].close > points[hiIdx].close) hiIdx = i;
    if (points[i].close < points[loIdx].close) loIdx = i;
  }
  for (const [idx, kind] of [
    [hiIdx, "range_high"],
    [loIdx, "range_low"],
  ] as Array<[number, ChartEventKind]>) {
    const p = points[idx];
    if (events.some((e) => e.date === p.date)) continue;
    push({
      kind,
      index: idx,
      date: p.date,
      close: p.close,
      magnitudePct: null,
      label: kind === "range_high" ? "Highest close in range" : "Lowest close in range",
      fallbackNote:
        kind === "range_high"
          ? `${p.date} was the highest close of this window.`
          : `${p.date} was the lowest close of this window.`,
    });
  }

  // De-duplicate by date (first writer wins), keep chronological order, cap.
  const seen = new Set<string>();
  const unique = events.filter((e) => (seen.has(e.date) ? false : (seen.add(e.date), true)));
  const priority: Record<ChartEventKind, number> = {
    spike_down: 0,
    spike_up: 1,
    death_cross: 2,
    golden_cross: 3,
    drawdown_trough: 4,
    vol_regime: 5,
    range_high: 6,
    range_low: 7,
  };
  return unique
    .slice()
    .sort((a, b) => priority[a.kind] - priority[b.kind])
    .slice(0, MAX_EVENTS)
    .sort((a, b) => a.index - b.index);
}

/** News headlines within a few days of an event, used as candidate drivers. */
export function newsNearEvent(
  news: AnnotationNewsItem[],
  date: string,
  windowDays = 2,
  limit = 3,
): AnnotationNewsItem[] {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return [];
  return news
    .filter((n) => {
      const nt = Date.parse(`${n.date}T00:00:00Z`);
      return Number.isFinite(nt) && Math.abs(nt - t) <= windowDays * 86_400_000;
    })
    .slice(0, limit);
}

/**
 * Merge AI-written notes onto detected events, falling back per event, and
 * attach the same nearby headlines the model was shown as visible evidence.
 */
export function mergeAnnotations(
  events: ChartEvent[],
  notes: Record<string, string>,
  model: string | null,
  news: AnnotationNewsItem[] = [],
): ChartAnnotation[] {
  return events.map((e) => {
    const ai = (notes[e.id] ?? "").trim();
    const sources = newsNearEvent(news, e.date);
    return ai
      ? { ...e, note: ai.slice(0, 320), model, sources }
      : { ...e, note: e.fallbackNote, model: null, sources };
  });
}


export function buildAnnotationPrompt(
  label: string,
  symbol: string,
  days: number,
  events: ChartEvent[],
  news: AnnotationNewsItem[],
): string {
  const payload = events.map((e) => ({
    id: e.id,
    date: e.date,
    kind: e.kind,
    move_pct: e.magnitudePct == null ? null : Number(e.magnitudePct.toFixed(2)),
    close: Number(e.close.toFixed(2)),
    headlines_nearby: newsNearEvent(news, e.date).map((n) => n.headline.slice(0, 140)),
  }));

  return `You are annotating a price chart for a non-technical investor.

Market: ${label} (${symbol}). Window: last ${days} days of daily closes.

For EACH event below, write ONE sentence (max 30 words) in plain English explaining what happened and, only if the nearby headlines or well-known market history support it, the likely driver. If you do not know the driver, describe the move and the trend context instead — never invent a cause, never predict, never give advice.

Events (JSON):
${JSON.stringify(payload)}

Reply with JSON only, no markdown fences, in the shape:
{"notes":[{"id":"<event id>","note":"<one sentence>"}]}`;
}

/** Tolerant parse of the model's JSON reply into an id -> note map. */
export function parseAnnotationReply(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      notes?: Array<{ id?: unknown; note?: unknown }>;
    };
    for (const n of parsed.notes ?? []) {
      if (typeof n?.id === "string" && typeof n?.note === "string" && n.note.trim()) {
        out[n.id] = n.note.trim();
      }
    }
  } catch {
    return out;
  }
  return out;
}
