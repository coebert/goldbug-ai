// Pure view-model helpers for the fear-index gauge. No I/O — easy to test.

import { humanFearLabel, labelFor, type FearLabel } from "./fear-index";

export type FearIndexSizingImpact = {
  symbol: string;
  side: "buy" | "sell";
  /** Notional actually spent, after the fear multiplier was applied. */
  value: number;
  /** Notional that would have been spent with no fear adjustment. */
  unadjustedValue: number | null;
  /** Signed % change vs the unadjusted size (e.g. -40 = trimmed 40%). */
  deltaPct: number | null;
  /** The fear score stamped on this order's sizing note. */
  fearScore: number | null;
  /** e.g. "fear72×0.60" pulled out of the order's sizing notes. */
  note: string;
  multiplier: number | null;
};


export type FearIndexSnapshot = {
  score: number | null;
  label: FearLabel | null;
  labelText: string | null;
  sizeMultiplier: number | null;
  reason: string | null;
  runDate: string | null;
  blockedBuys: string[];
  impacts: FearIndexSizingImpact[];
  history: Array<{ run_date: string; score: number }>;
};

type DecisionRow = { run_date?: string | null; created_at?: string | null; raw?: unknown };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const FEAR_NOTE = /fear(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)/i;

/** Extract the "fearNN×M.MM" fragment a run stamped onto an order's reason. */
export function parseFearNote(
  reason: unknown,
): { note: string; multiplier: number | null; score: number | null } | null {
  if (typeof reason !== "string") return null;
  const m = reason.match(FEAR_NOTE);
  if (!m) return null;
  const mult = Number(m[2]);
  const sc = Number(m[1]);
  return {
    note: m[0],
    multiplier: Number.isFinite(mult) ? mult : null,
    score: Number.isFinite(sc) ? sc : null,
  };
}

export function buildFearIndexSnapshot(rows: DecisionRow[]): FearIndexSnapshot {
  const history: Array<{ run_date: string; score: number }> = [];
  let latest: FearIndexSnapshot | null = null;

  for (const row of rows) {
    const raw = asRecord(row.raw);
    const fear = asRecord(raw?.fear_index);
    const score = num(fear?.score);
    const runDate = (row.run_date ?? row.created_at ?? "").slice(0, 10) || null;
    if (score == null) continue;
    if (runDate) history.push({ run_date: runDate, score });

    if (!latest) {
      const executed = Array.isArray(raw?.executed) ? (raw!.executed as unknown[]) : [];
      const impacts: FearIndexSizingImpact[] = [];
      const blockedBuys: string[] = [];
      for (const e of executed) {
        const rec = asRecord(e);
        if (!rec) continue;
        const symbol = typeof rec.symbol === "string" ? rec.symbol : null;
        if (!symbol) continue;
        const rejected = typeof rec.rejected === "string" ? rec.rejected : null;
        if (rejected && /fear index/i.test(rejected)) {
          blockedBuys.push(symbol);
          continue;
        }
        const parsed = parseFearNote(rec.reason);
        if (!parsed) continue;
        const value = num(rec.value) ?? 0;
        const mult = parsed.multiplier;
        const unadjusted = mult != null && mult > 0 ? value / mult : null;
        impacts.push({
          symbol,
          side: rec.side === "sell" ? "sell" : "buy",
          value,
          unadjustedValue: unadjusted,
          deltaPct: mult != null ? (mult - 1) * 100 : null,
          fearScore: parsed.score,
          note: parsed.note,
          multiplier: mult,
        });
      }
      const label = (typeof fear?.label === "string" ? (fear.label as FearLabel) : labelFor(score));
      latest = {
        score,
        label,
        labelText: humanFearLabel(label),
        sizeMultiplier: num(fear?.size_multiplier),
        reason: typeof fear?.reason === "string" ? fear.reason : null,
        runDate,
        blockedBuys,
        impacts: impacts.sort((a, b) => b.value - a.value).slice(0, 8),
        history: [],
      };
    }
  }

  const base: FearIndexSnapshot = latest ?? {
    score: null,
    label: null,
    labelText: null,
    sizeMultiplier: null,
    reason: null,
    runDate: null,
    blockedBuys: [],
    impacts: [],
    history: [],
  };
  return { ...base, history: history.slice().reverse() };
}
