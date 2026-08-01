// Market-event ingestion → decision features.
//
// The news pipeline (news-refresh → news_cache → sentiment.server) already
// pulls global headlines and scores them for sentiment. Sentiment alone is a
// blunt instrument: "Fed cuts rates" and "Ford beats earnings" can score the
// same +0.6 while implying very different trades.
//
// This module turns scored headlines into *typed market events* with a scope
// (company vs macro), a directional polarity, a severity, and a half-life.
// Those become explicit per-symbol features the AI sees alongside technicals,
// plus a small bounded tilt applied to the blended news score.
//
// Pure and deterministic — no I/O, no LLM — so it is cheap to run every tick
// and fully unit-testable.

export type MarketEventScope = "company" | "macro";

export type MarketEventKind =
  // Company-scoped
  | "earnings_beat"
  | "earnings_miss"
  | "guidance_raise"
  | "guidance_cut"
  | "mna"
  | "analyst_upgrade"
  | "analyst_downgrade"
  | "credit_downgrade"
  | "regulatory_probe"
  | "litigation"
  | "layoffs"
  | "buyback"
  | "dividend_cut"
  | "product_launch"
  | "cyber_incident"
  | "executive_exit"
  // Macro-scoped
  | "rate_cut"
  | "rate_hike"
  | "inflation_hot"
  | "inflation_cool"
  | "jobs_data"
  | "recession_signal"
  | "geopolitical_shock"
  | "sanctions"
  | "tariffs"
  | "energy_shock"
  | "supply_disruption";

type EventSpec = {
  kind: MarketEventKind;
  scope: MarketEventScope;
  /** Directional prior for the event type, -1 bearish .. +1 bullish. */
  polarity: number;
  /** How much the event type typically moves prices, 0..1. */
  severity: number;
  /** Decay half-life in hours; hard catalysts fade faster than slow themes. */
  halfLifeHours: number;
  /** A hard, dated catalyst (as opposed to a running theme). */
  hardCatalyst: boolean;
  re: RegExp;
};

// Ordered — the most specific/actionable patterns first. A headline can match
// several kinds; we keep up to MAX_KINDS_PER_HEADLINE of them.
const EVENT_SPECS: EventSpec[] = [
  {
    kind: "earnings_beat", scope: "company", polarity: 0.7, severity: 0.8,
    halfLifeHours: 36, hardCatalyst: true,
    re: /\b(beats?|tops?|smashes?|exceed(s|ed)?)\b[^.]{0,40}\b(earnings|estimates|expectations|forecasts?|profit|revenue)\b|\bearnings\b[^.]{0,30}\bbeat\b/i,
  },
  {
    kind: "earnings_miss", scope: "company", polarity: -0.75, severity: 0.85,
    halfLifeHours: 36, hardCatalyst: true,
    re: /\b(miss(es|ed)?|falls? short|disappoint(s|ed|ing)?)\b[^.]{0,40}\b(earnings|estimates|expectations|forecasts?|profit|revenue|sales)\b|\bprofit warning\b/i,
  },
  {
    kind: "guidance_raise", scope: "company", polarity: 0.65, severity: 0.7,
    halfLifeHours: 48, hardCatalyst: true,
    re: /\b(raises?|lifts?|hikes?|upgrades?|boosts?)\b[^.]{0,30}\b(guidance|outlook|forecast|full[- ]year)\b/i,
  },
  {
    kind: "guidance_cut", scope: "company", polarity: -0.75, severity: 0.8,
    halfLifeHours: 48, hardCatalyst: true,
    re: /\b(cuts?|lowers?|slashes?|trims?|withdraws?)\b[^.]{0,30}\b(guidance|outlook|forecast|full[- ]year)\b/i,
  },
  {
    kind: "mna", scope: "company", polarity: 0.5, severity: 0.85,
    halfLifeHours: 72, hardCatalyst: true,
    re: /\b(acquires?|acquisition|takeover|merger|merges? with|buyout|to buy|bid for|stake in)\b/i,
  },
  {
    kind: "analyst_upgrade", scope: "company", polarity: 0.35, severity: 0.4,
    halfLifeHours: 24, hardCatalyst: false,
    re: /\b(upgrade[sd]? to|raises? (price )?target|initiat(es|ed) (coverage )?(at|with) (buy|outperform|overweight)|double upgrade)\b/i,
  },
  {
    kind: "analyst_downgrade", scope: "company", polarity: -0.4, severity: 0.45,
    halfLifeHours: 24, hardCatalyst: false,
    re: /\b(downgrade[sd]? to|cuts? (price )?target|initiat(es|ed) (coverage )?(at|with) (sell|underperform|underweight))\b/i,
  },
  {
    kind: "credit_downgrade", scope: "company", polarity: -0.6, severity: 0.7,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(moody'?s|s&p|fitch)\b[^.]{0,40}\b(downgrade[sd]?|cuts? rating|junk status)\b|\bcredit rating (cut|downgraded)\b/i,
  },
  {
    kind: "regulatory_probe", scope: "company", polarity: -0.55, severity: 0.7,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(antitrust|regulator[sy]?|sec |fca |cma |ftc |doj |investigat(es|ion)|probe|fined?|penalt(y|ies))\b/i,
  },
  {
    kind: "litigation", scope: "company", polarity: -0.4, severity: 0.5,
    halfLifeHours: 96, hardCatalyst: false,
    re: /\b(lawsuit|sues?|sued|class action|court rules?|verdict|settlement)\b/i,
  },
  {
    kind: "layoffs", scope: "company", polarity: -0.2, severity: 0.4,
    halfLifeHours: 72, hardCatalyst: false,
    re: /\b(lay ?offs?|job cuts|redundanc(y|ies)|cuts? \d[\d,]* jobs)\b/i,
  },
  {
    kind: "buyback", scope: "company", polarity: 0.45, severity: 0.5,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(buy ?back|share repurchase|repurchase programme?|returns? cash to shareholders)\b/i,
  },
  {
    kind: "dividend_cut", scope: "company", polarity: -0.6, severity: 0.65,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(cuts?|scraps?|suspends?|omits?)\b[^.]{0,20}\bdividend\b/i,
  },
  {
    kind: "product_launch", scope: "company", polarity: 0.3, severity: 0.35,
    halfLifeHours: 48, hardCatalyst: false,
    re: /\b(unveils?|launches?|announces?|debuts?)\b[^.]{0,30}\b(product|chip|model|device|platform|service|drug|vehicle)\b/i,
  },
  {
    kind: "cyber_incident", scope: "company", polarity: -0.5, severity: 0.6,
    halfLifeHours: 72, hardCatalyst: true,
    re: /\b(cyber ?attack|data breach|ransomware|hacked|security incident|outage)\b/i,
  },
  {
    kind: "executive_exit", scope: "company", polarity: -0.3, severity: 0.45,
    halfLifeHours: 72, hardCatalyst: true,
    re: /\b(ceo|cfo|chair(man|woman)?|chief executive)\b[^.]{0,40}\b(steps? down|resign(s|ed|ation)|ousted|departs?|to leave|fired)\b/i,
  },

  // ---- Macro ----
  {
    kind: "rate_cut", scope: "macro", polarity: 0.6, severity: 0.9,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(cuts?|lowers?|reduces?)\b[^.]{0,30}\b(rates?|interest rates?|bank rate)\b|\brate cut\b/i,
  },
  {
    kind: "rate_hike", scope: "macro", polarity: -0.55, severity: 0.9,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(raises?|hikes?|lifts?)\b[^.]{0,30}\b(rates?|interest rates?|bank rate)\b|\brate hike\b/i,
  },
  {
    kind: "inflation_hot", scope: "macro", polarity: -0.5, severity: 0.75,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(inflation|cpi|ppi)\b[^.]{0,40}\b(rises?|jumps?|accelerat(es|ed|ing)|hotter|above (forecast|expectations)|surges?)\b/i,
  },
  {
    kind: "inflation_cool", scope: "macro", polarity: 0.5, severity: 0.7,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(inflation|cpi|ppi)\b[^.]{0,40}\b(eases?|falls?|cools?|slows?|below (forecast|expectations))\b/i,
  },
  {
    kind: "jobs_data", scope: "macro", polarity: 0, severity: 0.55,
    halfLifeHours: 72, hardCatalyst: true,
    re: /\b(payrolls?|jobs report|unemployment rate|jobless claims|labou?r market)\b/i,
  },
  {
    kind: "recession_signal", scope: "macro", polarity: -0.6, severity: 0.8,
    halfLifeHours: 168, hardCatalyst: false,
    re: /\b(recession|contraction|yield curve invert\w*|hard landing|stagflation|gdp (shrinks?|contracts?))\b/i,
  },
  {
    kind: "geopolitical_shock", scope: "macro", polarity: -0.55, severity: 0.8,
    halfLifeHours: 96, hardCatalyst: true,
    re: /\b(invasion|missile strike|air ?strikes?|war breaks out|escalat\w+ conflict|coup|terror attack|blockade)\b/i,
  },
  {
    kind: "sanctions", scope: "macro", polarity: -0.45, severity: 0.65,
    halfLifeHours: 168, hardCatalyst: true,
    re: /\bsanction\w*\b/i,
  },
  {
    kind: "tariffs", scope: "macro", polarity: -0.45, severity: 0.7,
    halfLifeHours: 168, hardCatalyst: true,
    re: /\b(tariffs?|trade war|import levy|export controls?)\b/i,
  },
  {
    kind: "energy_shock", scope: "macro", polarity: -0.4, severity: 0.7,
    halfLifeHours: 96, hardCatalyst: false,
    re: /\b(oil|brent|crude|gas prices?)\b[^.]{0,30}\b(surges?|spikes?|soars?|jumps?|plunges?|slumps?|crashes?)\b|\bopec\b[^.]{0,30}\b(cut|quota|output)\b/i,
  },
  {
    kind: "supply_disruption", scope: "macro", polarity: -0.4, severity: 0.6,
    halfLifeHours: 168, hardCatalyst: false,
    re: /\b(supply chain|shortage|shipping disruption|port strike|chip shortage|export ban)\b/i,
  },
];

const MAX_KINDS_PER_HEADLINE = 2;

export const EVENT_KIND_META: Record<
  MarketEventKind,
  { scope: MarketEventScope; polarity: number; severity: number; halfLifeHours: number; hardCatalyst: boolean }
> = EVENT_SPECS.reduce(
  (acc, s) => {
    acc[s.kind] = {
      scope: s.scope,
      polarity: s.polarity,
      severity: s.severity,
      halfLifeHours: s.halfLifeHours,
      hardCatalyst: s.hardCatalyst,
    };
    return acc;
  },
  {} as Record<MarketEventKind, { scope: MarketEventScope; polarity: number; severity: number; halfLifeHours: number; hardCatalyst: boolean }>,
);

/** Classify a headline into zero or more typed market events. */
export function classifyHeadline(headline: string): MarketEventKind[] {
  if (!headline) return [];
  const out: MarketEventKind[] = [];
  for (const spec of EVENT_SPECS) {
    if (spec.re.test(headline)) {
      out.push(spec.kind);
      if (out.length >= MAX_KINDS_PER_HEADLINE) break;
    }
  }
  return out;
}

export type ScoredHeadline = {
  headline: string;
  source: string | null;
  sentiment: number | null;
  entities?: string[];
  source_weight?: number;
  date?: string | null;
};

export type MarketEvent = {
  kind: MarketEventKind;
  scope: MarketEventScope;
  headline: string;
  source: string | null;
  date: string | null;
  /** Signed impact, -1..+1: event prior blended with the LLM sentiment. */
  polarity: number;
  severity: number;
  hardCatalyst: boolean;
  entities: string[];
  /** source reputation × recency decay, 0..1. */
  weight: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function recencyWeight(dateISO: string | null | undefined, asOfISO: string, halfLifeHours: number): number {
  if (!dateISO) return 1;
  const asOfMs = new Date(`${asOfISO}T23:59:59Z`).getTime();
  const evMs = new Date(`${dateISO}T12:00:00Z`).getTime();
  if (!Number.isFinite(asOfMs) || !Number.isFinite(evMs)) return 1;
  const ageHours = Math.max(0, (asOfMs - evMs) / 3_600_000);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/**
 * Extract typed events from a window of scored headlines.
 * Sentiment, when present, modulates the event prior (a "merger" headline the
 * LLM read as bearish gets a muted / flipped polarity rather than a blind +0.5).
 */
export function extractMarketEvents(items: ScoredHeadline[], asOfISO: string): MarketEvent[] {
  const events: MarketEvent[] = [];
  for (const it of items) {
    const kinds = classifyHeadline(it.headline);
    if (kinds.length === 0) continue;
    for (const kind of kinds) {
      const meta = EVENT_KIND_META[kind];
      const sent = it.sentiment == null ? null : clamp(Number(it.sentiment), -1, 1);
      // 60% event prior, 40% observed sentiment. Neutral-prior kinds (jobs
      // data) inherit their direction entirely from the sentiment score.
      const polarity =
        sent == null
          ? meta.polarity
          : meta.polarity === 0
            ? sent
            : clamp(meta.polarity * 0.6 + sent * 0.4, -1, 1);
      const srcW = it.source_weight == null ? 0.4 : clamp(Number(it.source_weight), 0, 1);
      events.push({
        kind,
        scope: meta.scope,
        headline: it.headline,
        source: it.source ?? null,
        date: it.date ?? null,
        polarity: Number(polarity.toFixed(3)),
        severity: meta.severity,
        hardCatalyst: meta.hardCatalyst,
        entities: (it.entities ?? []).map((e) => String(e).toUpperCase()),
        weight: Number((srcW * recencyWeight(it.date, asOfISO, meta.halfLifeHours)).toFixed(4)),
      });
    }
  }
  return events;
}

export type SymbolEventFeatures = {
  /** Weighted directional event score, -1 bearish .. +1 bullish. */
  event_score: number;
  /** Magnitude of event flow regardless of direction, 0..1. */
  event_pressure: number;
  /** Number of contributing events. */
  event_count: number;
  /** True when at least one dated hard catalyst hit this symbol. */
  hard_catalyst: boolean;
  /** Most influential event kinds, strongest first. */
  top_kinds: MarketEventKind[];
};

export const EMPTY_SYMBOL_EVENT_FEATURES: SymbolEventFeatures = {
  event_score: 0,
  event_pressure: 0,
  event_count: 0,
  hard_catalyst: false,
  top_kinds: [],
};

function matchesSymbol(ev: MarketEvent, symbol: string, name: string): boolean {
  const sym = symbol.toUpperCase();
  const base = sym.split(/[.:]/)[0] ?? sym;
  const firstName = (name.split(/\s+/)[0] ?? "").toUpperCase();
  if (ev.entities.some((e) => e === sym || e === base)) return true;
  if (firstName.length > 3 && ev.entities.some((e) => e.includes(firstName))) return true;
  const head = ev.headline.toUpperCase();
  if (base.length > 2 && new RegExp(`\\b${base.replace(/[^A-Z0-9]/g, "")}\\b`).test(head)) return true;
  if (firstName.length > 3 && head.includes(firstName)) return true;
  return false;
}

/** Company-scoped event features for one instrument. */
export function symbolEventFeatures(
  symbol: string,
  name: string,
  events: MarketEvent[],
): SymbolEventFeatures {
  const hits = events.filter((e) => e.scope === "company" && matchesSymbol(e, symbol, name));
  if (hits.length === 0) return { ...EMPTY_SYMBOL_EVENT_FEATURES };

  let num = 0;
  let den = 0;
  let pressure = 0;
  for (const e of hits) {
    const w = e.weight * e.severity;
    num += e.polarity * w;
    den += w;
    pressure += Math.abs(e.polarity) * w;
  }
  const ranked = [...hits].sort(
    (a, b) => Math.abs(b.polarity) * b.weight * b.severity - Math.abs(a.polarity) * a.weight * a.severity,
  );
  const topKinds: MarketEventKind[] = [];
  for (const e of ranked) {
    if (!topKinds.includes(e.kind)) topKinds.push(e.kind);
    if (topKinds.length >= 3) break;
  }

  return {
    event_score: den > 0 ? Number((num / den).toFixed(3)) : 0,
    event_pressure: Number(clamp(pressure, 0, 1).toFixed(3)),
    event_count: hits.length,
    hard_catalyst: hits.some((e) => e.hardCatalyst),
    top_kinds: topKinds,
  };
}

export type MacroEventFeatures = {
  /** Aggregate macro direction, -1 risk-off .. +1 risk-on. */
  macro_score: number;
  /** 0..1 — how loud the macro tape is today. */
  macro_intensity: number;
  /** Dominant macro event kinds. */
  drivers: Array<{ kind: MarketEventKind; polarity: number; headline: string }>;
};

export function macroEventFeatures(events: MarketEvent[]): MacroEventFeatures {
  const hits = events.filter((e) => e.scope === "macro");
  if (hits.length === 0) return { macro_score: 0, macro_intensity: 0, drivers: [] };
  let num = 0;
  let den = 0;
  for (const e of hits) {
    const w = e.weight * e.severity;
    num += e.polarity * w;
    den += w;
  }
  const drivers = [...hits]
    .sort((a, b) => Math.abs(b.polarity) * b.weight * b.severity - Math.abs(a.polarity) * a.weight * a.severity)
    .slice(0, 5)
    .map((e) => ({ kind: e.kind, polarity: e.polarity, headline: e.headline }));
  return {
    macro_score: den > 0 ? Number((num / den).toFixed(3)) : 0,
    macro_intensity: Number(clamp(den / 4, 0, 1).toFixed(3)),
    drivers,
  };
}

/** Maximum absolute nudge an event flow may add to a blended news score. */
export const MAX_EVENT_TILT = 0.2;

/**
 * Bounded tilt applied on top of the sentiment score for a symbol.
 * Deliberately small: events sharpen an existing view, they do not replace
 * technicals. Macro contributes at a quarter of the company-event weight.
 */
export function eventTilt(sym: SymbolEventFeatures, macro?: MacroEventFeatures | null): number {
  const company = sym.event_score * Math.min(1, sym.event_pressure + (sym.hard_catalyst ? 0.25 : 0));
  const macroPart = macro ? macro.macro_score * macro.macro_intensity * 0.25 : 0;
  const raw = company * 0.75 + macroPart;
  return Number(clamp(raw * MAX_EVENT_TILT * 2, -MAX_EVENT_TILT, MAX_EVENT_TILT).toFixed(3));
}

/** Human-readable prompt block describing today's macro event tape. */
export function formatMarketEventsBlock(
  macro: MacroEventFeatures,
  perSymbol: Array<{ symbol: string; features: SymbolEventFeatures }>,
): string {
  const lines: string[] = ["MARKET-EVENT FEED (typed from global news, -1 bearish .. +1 bullish):"];
  if (macro.drivers.length === 0) {
    lines.push("- Macro: no typed macro events in the window.");
  } else {
    lines.push(
      `- Macro posture: ${macro.macro_score >= 0 ? "risk-on" : "risk-off"} ${macro.macro_score.toFixed(2)} (intensity ${macro.macro_intensity.toFixed(2)})`,
    );
    for (const d of macro.drivers) {
      lines.push(`  • ${d.kind} (${d.polarity.toFixed(2)}): ${d.headline.slice(0, 120)}`);
    }
  }
  const named = perSymbol
    .filter((p) => p.features.event_count > 0)
    .sort((a, b) => Math.abs(b.features.event_score) - Math.abs(a.features.event_score))
    .slice(0, 10);
  if (named.length === 0) {
    lines.push("- No company-specific events matched today's candidates.");
  } else {
    for (const p of named) {
      lines.push(
        `- ${p.symbol}: ${p.features.event_score.toFixed(2)} from ${p.features.event_count} event(s) [${p.features.top_kinds.join(", ")}]${p.features.hard_catalyst ? " HARD CATALYST" : ""}`,
      );
    }
  }
  lines.push(
    "Treat a hard catalyst against your thesis (guidance_cut, earnings_miss, regulatory_probe, credit_downgrade) as a reason to skip or shrink a BUY even when technicals look fine; a confirming catalyst justifies conviction only when the trend already agrees.",
  );
  return lines.join("\n");
}
