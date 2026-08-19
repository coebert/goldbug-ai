// Pure derivation of a per-instrument "why did the AI trade this?" rationale.
//
// Inputs are a persisted decision row (`ai_decision_audit`) plus the market
// events / headlines that were live around the decision. No IO and no AI so
// the panel renders instantly and is unit-testable.

import { baseSymbol } from "./news-relevance";
import { buildTradeLevels, type TradeLevelPlan, type TradeLevelRiskConfig } from "./trade-levels";

export type { TradeLevelPlan };

export type RationaleSignal = {
  key: string;
  label: string;
  detail: string;
  /** Whether the signal argued for, against, or was neutral on the action. */
  stance: "supporting" | "cautionary" | "context";
  /** Optional 0..1 strength for the bar in the UI. */
  strength: number | null;
};

export type RationaleEvent = {
  id: string;
  date: string;
  kind: "news" | "market-event";
  title: string;
  source: string | null;
  url: string | null;
  detail: string | null;
  /** 0..100 when known. */
  relevance: number | null;
  sentiment: string | null;
};

export type TradeRationale = {
  symbol: string;
  action: "buy" | "sell" | "hold" | null;
  decidedAt: string | null;
  headline: string;
  aiRationale: string | null;
  runRationale: string | null;
  signals: RationaleSignal[];
  events: RationaleEvent[];
  /** Trigger / limit / stop / target price levels behind the decision. */
  levels: TradeLevelPlan | null;
  /** True when we found nothing beyond the raw rationale text. */
  sparse: boolean;
};

export type DecisionInput = {
  symbol: string;
  action?: string | null;
  decidedAt?: string | null;
  rationale?: string | null;
  marketInputs?: unknown;
  /** Executed / quoted price recorded on the decision row. */
  price?: number | null;
  /** Average cost of the position the decision applied to. */
  avgCost?: number | null;
  currency?: string | null;
  assetClass?: string | null;
  notional?: number | null;
  tickSize?: number | null;
};

export type NewsInput = {
  id: string;
  news_date: string;
  headline: string;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  sentiment?: string | null;
  relevance_score?: number | null;
  entities?: unknown;
};

export type MarketEventInput = {
  id: string;
  event_date: string;
  kind?: string | null;
  symbol?: string | null;
  title: string;
  impact?: string | null;
  notes?: string | null;
};

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function titleCase(key: string): string {
  return key
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Does this headline plausibly concern the instrument? */
export function newsMentionsSymbol(row: NewsInput, symbol: string): boolean {
  const base = baseSymbol(symbol);
  if (!base) return false;
  const ents = Array.isArray(row.entities) ? row.entities : [];
  for (const e of ents) {
    const token = typeof e === "string" ? e : str(obj(e)?.["symbol"]) ?? str(obj(e)?.["ticker"]);
    if (token && baseSymbol(token) === base) return true;
  }
  const hay = `${row.headline ?? ""} ${row.summary ?? ""}`.toUpperCase();
  return new RegExp(`(^|[^A-Z0-9])${base}([^A-Z0-9]|$)`).test(hay);
}

function regimeSignal(mi: Record<string, unknown>): RationaleSignal | null {
  const r = obj(mi["regime"]);
  if (!r) return null;
  const name = str(r["regime"]);
  if (!name) return null;
  const conf = num(r["confidence"]);
  const notes = str(r["notes"]);
  const bullish = /bull|risk_on|quiet/.test(name);
  return {
    key: "regime",
    label: `Market regime — ${titleCase(name)}`,
    detail: [notes, conf != null ? `confidence ${pct(conf)}` : null].filter(Boolean).join(" · "),
    stance: bullish ? "supporting" : "cautionary",
    strength: conf,
  };
}

function sectorSignal(mi: Record<string, unknown>): RationaleSignal | null {
  const s = obj(mi["sector"]);
  if (!s) return null;
  const sector = str(s["sector"]);
  if (!sector) return null;
  const mult = num(s["applied_multiplier"]);
  const phase = str(s["phase"]);
  return {
    key: "sector",
    label: `Sector rotation — ${titleCase(sector)}${phase ? ` (${phase})` : ""}`,
    detail: str(s["note"]) ?? "",
    stance: mult != null && mult < 1 ? "cautionary" : "supporting",
    strength: num(s["strength"]),
  };
}

function breakoutSignal(mi: Record<string, unknown>): RationaleSignal | null {
  const b = obj(mi["breakout"]);
  if (!b) return null;
  const applies = b["applies"] === true;
  const explanation = str(b["explanation"]) ?? str(b["reason"]);
  if (!applies && !explanation) return null;
  return {
    key: "breakout",
    label: applies ? `Breakout — ${titleCase(str(b["state"]) ?? "detected")}` : "Breakout gate",
    detail: explanation ?? "",
    stance: applies ? "supporting" : "context",
    strength: num(b["quality"]),
  };
}

const NOTE_KEYS = ["explanation", "note", "reason", "summary", "detail"];

/** Anything else in market_inputs that carries a human-readable note. */
function genericSignals(mi: Record<string, unknown>): RationaleSignal[] {
  const known = new Set(["regime", "sector", "breakout", "run_rationale"]);
  const out: RationaleSignal[] = [];
  for (const [key, value] of Object.entries(mi)) {
    if (known.has(key)) continue;
    const o = obj(value);
    if (!o) continue;
    let detail: string | null = null;
    for (const nk of NOTE_KEYS) {
      detail = str(o[nk]);
      if (detail) break;
    }
    if (!detail) continue;
    const score = num(o["score"]) ?? num(o["nudge"]) ?? num(o["weight"]);
    out.push({
      key,
      label: titleCase(key),
      detail,
      stance: score != null && score < 0 ? "cautionary" : "context",
      strength: score != null ? Math.min(1, Math.abs(score)) : null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function buildTradeRationale(input: {
  decision: DecisionInput;
  news?: NewsInput[];
  events?: MarketEventInput[];
  /** Cap the events list (default 8). */
  maxEvents?: number;
}): TradeRationale {
  const { decision } = input;
  const mi = obj(decision.marketInputs) ?? {};
  const actionRaw = (decision.action ?? "").toLowerCase();
  const action = actionRaw === "buy" || actionRaw === "sell" || actionRaw === "hold" ? actionRaw : null;

  const signals = [regimeSignal(mi), sectorSignal(mi), breakoutSignal(mi)]
    .filter((s): s is RationaleSignal => s !== null)
    .concat(genericSignals(mi));

  const maxEvents = input.maxEvents ?? 8;
  const events: RationaleEvent[] = [];

  for (const e of input.events ?? []) {
    if (e.symbol && baseSymbol(e.symbol) !== baseSymbol(decision.symbol)) continue;
    events.push({
      id: e.id,
      date: e.event_date,
      kind: "market-event",
      title: e.title,
      source: e.kind ? titleCase(e.kind) : null,
      url: null,
      detail: [e.impact ? `Impact: ${e.impact}` : null, e.notes].filter(Boolean).join(" · ") || null,
      relevance: null,
      sentiment: null,
    });
  }

  for (const n of input.news ?? []) {
    if (!newsMentionsSymbol(n, decision.symbol)) continue;
    events.push({
      id: n.id,
      date: n.news_date,
      kind: "news",
      title: n.headline,
      source: n.source ?? null,
      url: n.url ?? null,
      detail: n.summary ?? null,
      relevance: num(n.relevance_score),
      sentiment: n.sentiment ?? null,
    });
  }

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.relevance ?? 0) - (a.relevance ?? 0);
  });

  const verb = action === "buy" ? "bought" : action === "sell" ? "sold" : action === "hold" ? "held" : "considered";
  const drivers: string[] = [];
  if (signals.length > 0) drivers.push(`${signals.length} signal${signals.length === 1 ? "" : "s"}`);
  if (events.length > 0) drivers.push(`${events.length} market event${events.length === 1 ? "" : "s"}`);
  const headline =
    drivers.length > 0
      ? `${decision.symbol} was ${verb} on ${drivers.join(" and ")}.`
      : `${decision.symbol} was ${verb}; no structured signal detail was recorded.`;

  return {
    symbol: decision.symbol,
    action,
    decidedAt: decision.decidedAt ?? null,
    headline,
    aiRationale: str(decision.rationale),
    runRationale: str(mi["run_rationale"]),
    signals,
    events: events.slice(0, maxEvents),
    sparse: signals.length === 0 && events.length === 0,
  };
}
