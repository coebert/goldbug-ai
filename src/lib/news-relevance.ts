// Portfolio-aware relevance scoring for news headlines.
//
// Every headline entering the reel is scored 0..100 for "how likely is this to
// move MY book, at MY risk level". The deterministic heuristic in this file is
// the floor: it never calls the network, so scoring still works when the LLM
// pass is unavailable, rate-limited, or out of credits. The server module
// blends an LLM judgement on top of it.
//
// Pure module — no imports from server-only code, so it is unit-testable and
// safe to import from the client.

export type RiskLevel = "conservative" | "balanced" | "aggressive";

export type RelevanceContext = {
  /** Symbols the user actually holds (upper-case, exchange suffix stripped). */
  symbols: string[];
  /** Free-text company/instrument names mapped from held symbols. */
  names: string[];
  /** Asset classes in the tradable universe: equity, crypto, commodity, fx, bond. */
  assetClasses: string[];
  /** Currencies the book is exposed to (ISO 4217). */
  currencies: string[];
  /** Dominant risk level across the user's portfolios. */
  riskLevel: RiskLevel;
};

export type RelevanceScore = {
  /** 0..100 — higher means more likely to impact the user's book. */
  score: number;
  /** Short plain-English justification shown in the reel. */
  reason: string;
  /** Machine tags describing what matched (symbols, themes). */
  tags: string[];
};

export const RELEVANCE_MIN = 0;
export const RELEVANCE_MAX = 100;

export function clampRelevance(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(RELEVANCE_MIN, Math.min(RELEVANCE_MAX, Math.round(v)));
}

/** Bands used for UI labelling and for the "high signal only" filter. */
export function relevanceBand(score: number | null | undefined): "critical" | "high" | "moderate" | "low" | "noise" {
  const s = score == null ? -1 : score;
  if (s >= 80) return "critical";
  if (s >= 60) return "high";
  if (s >= 40) return "moderate";
  if (s >= 20) return "low";
  return "noise";
}

export function relevanceBandLabel(score: number | null | undefined): string {
  switch (relevanceBand(score)) {
    case "critical":
      return "Direct impact";
    case "high":
      return "High relevance";
    case "moderate":
      return "Some relevance";
    case "low":
      return "Background";
    default:
      return "Low signal";
  }
}

/** Strip exchange suffixes so "VOD.L" and "VOD" match the same headline token. */
export function baseSymbol(sym: string): string {
  return String(sym).toUpperCase().replace(/[.:][A-Z]{1,4}$/, "").trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    String(text)
      .toUpperCase()
      .split(/[^A-Z0-9£$€¥%]+/)
      .filter(Boolean),
  );
}

type Theme = {
  tag: string;
  re: RegExp;
  base: number;
  /** Per-risk-level multiplier — a rates print matters more to a conservative book. */
  byRisk: Record<RiskLevel, number>;
  /** Asset classes this theme only counts for (empty = always counts). */
  requires?: string[];
};

const THEMES: Theme[] = [
  {
    tag: "central-bank",
    re: /\b(fed|fomc|federal reserve|bank of england|boe|ecb|bank of japan|boj|interest rate|rate cut|rate hike|base rate|monetary policy|quantitative)\b/i,
    base: 30,
    byRisk: { conservative: 1.25, balanced: 1.0, aggressive: 0.85 },
  },
  {
    tag: "inflation",
    re: /\b(inflation|cpi|ppi|core prices|deflation|wage growth)\b/i,
    base: 26,
    byRisk: { conservative: 1.25, balanced: 1.0, aggressive: 0.85 },
  },
  {
    tag: "growth-data",
    re: /\b(gdp|recession|payrolls|jobless|unemployment|pmi|retail sales|consumer confidence)\b/i,
    base: 22,
    byRisk: { conservative: 1.15, balanced: 1.0, aggressive: 0.95 },
  },
  {
    tag: "earnings",
    re: /\b(earnings|results|profit warning|guidance|revenue|quarterly|eps|outlook cut|outlook raise)\b/i,
    base: 26,
    byRisk: { conservative: 0.9, balanced: 1.05, aggressive: 1.2 },
    requires: ["equity"],
  },
  {
    tag: "credit",
    re: /\b(bond yields?|treasur(y|ies)|gilt|credit spread|default|downgrade|ratings? agency|moody'?s|s&p global ratings|fitch)\b/i,
    base: 24,
    byRisk: { conservative: 1.3, balanced: 1.0, aggressive: 0.8 },
  },
  {
    tag: "crypto",
    re: /\b(bitcoin|btc|ethereum|eth|crypto|stablecoin|digital asset|etf approval|halving)\b/i,
    base: 28,
    byRisk: { conservative: 0.5, balanced: 0.9, aggressive: 1.3 },
    requires: ["crypto"],
  },
  {
    tag: "commodity",
    re: /\b(oil|brent|wti|opec|gold|silver|copper|natural gas|wheat|commodit)/i,
    base: 22,
    byRisk: { conservative: 1.0, balanced: 1.0, aggressive: 1.05 },
    requires: ["commodity"],
  },
  {
    tag: "fx",
    re: /\b(dollar|sterling|pound|euro|yen|currency|exchange rate|devalu)/i,
    base: 18,
    byRisk: { conservative: 1.1, balanced: 1.0, aggressive: 1.0 },
  },
  {
    tag: "geopolitics",
    re: /\b(war|invasion|sanction|tariff|trade war|strait|embargo|coup|election|shutdown|strike action)\b/i,
    base: 20,
    byRisk: { conservative: 1.2, balanced: 1.0, aggressive: 0.95 },
  },
  {
    tag: "market-stress",
    re: /\b(sell-?off|crash|plunge|rout|panic|volatility|vix|circuit breaker|margin call|liquidity crunch|bank run)\b/i,
    base: 30,
    byRisk: { conservative: 1.25, balanced: 1.1, aggressive: 1.0 },
  },
  {
    tag: "regulation",
    re: /\b(regulator|sec |fca|antitrust|lawsuit|investigation|fine|probe)\b/i,
    base: 14,
    byRisk: { conservative: 1.05, balanced: 1.0, aggressive: 1.0 },
  },
  {
    tag: "m&a",
    re: /\b(acquisition|takeover|merger|buyout|bid for|stake in)\b/i,
    base: 18,
    byRisk: { conservative: 0.9, balanced: 1.0, aggressive: 1.15 },
    requires: ["equity"],
  },
];

/** Headlines that are almost never tradable signal for a retail book. */
const NOISE = /\b(celebrit|royal wedding|football|soccer|premier league|nba|nfl|cricket|tennis|box office|netflix series|recipe|horoscope|gossip|red carpet|reality tv)\b/i;

const CURRENCY_WORDS: Record<string, RegExp> = {
  GBP: /\b(sterling|pound|uk|britain|british|london|gilt|ftse)\b/i,
  USD: /\b(dollar|us |u\.s\.|wall street|nasdaq|s&p 500|treasur)/i,
  EUR: /\b(euro|eurozone|ecb|germany|france|dax|cac)\b/i,
  JPY: /\b(yen|japan|nikkei|boj)\b/i,
};

/**
 * Deterministic, offline relevance score. Used on its own when the LLM pass
 * is unavailable, and as a floor/blend partner when it is.
 */
export function heuristicRelevance(
  input: { headline: string; summary?: string | null; source?: string | null; source_weight?: number | null },
  ctx: RelevanceContext,
): RelevanceScore {
  const text = `${input.headline} ${input.summary ?? ""}`.trim();
  if (!text) return { score: 0, reason: "Empty headline.", tags: [] };

  const tokens = tokenize(text);
  const tags: string[] = [];
  const reasons: string[] = [];
  let score = 8; // small floor: any financial wire item has some ambient value

  // 1. Direct holdings hits dominate everything else.
  const hitSymbols: string[] = [];
  for (const raw of ctx.symbols) {
    const sym = baseSymbol(raw);
    if (sym.length >= 2 && tokens.has(sym)) hitSymbols.push(sym);
  }
  for (const name of ctx.names) {
    const n = name.trim();
    if (n.length >= 4 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      hitSymbols.push(n.toUpperCase());
    }
  }
  const uniqueHits = Array.from(new Set(hitSymbols));
  if (uniqueHits.length > 0) {
    score += 45 + Math.min(15, (uniqueHits.length - 1) * 8);
    tags.push(...uniqueHits.slice(0, 4).map((s) => `holding:${s}`));
    reasons.push(`names ${uniqueHits.slice(0, 3).join(", ")} you hold`);
  }

  // 2. Thematic hits, tilted by risk level and gated on the tradable universe.
  const classes = new Set(ctx.assetClasses.map((c) => c.toLowerCase()));
  for (const theme of THEMES) {
    if (theme.requires && !theme.requires.some((c) => classes.has(c))) continue;
    if (!theme.re.test(text)) continue;
    score += theme.base * theme.byRisk[ctx.riskLevel];
    tags.push(`theme:${theme.tag}`);
    reasons.push(theme.tag.replace(/-/g, " "));
  }

  // 3. Currency exposure.
  for (const ccy of ctx.currencies) {
    const rx = CURRENCY_WORDS[ccy.toUpperCase()];
    if (rx && rx.test(text)) {
      score += 8;
      tags.push(`ccy:${ccy.toUpperCase()}`);
    }
  }

  // 4. Source reliability nudge (±6) — a tier-one wire is worth more.
  const w = typeof input.source_weight === "number" ? input.source_weight : 0.5;
  score += (w - 0.5) * 12;

  // 5. Off-topic noise is pushed under the reel's signal floor.
  if (NOISE.test(text) && uniqueHits.length === 0) {
    score = Math.min(score, 12);
    tags.push("noise");
    reasons.length = 0;
    reasons.push("off-topic for a trading book");
  }

  const final = clampRelevance(score);
  const reason =
    reasons.length === 0
      ? "General market backdrop with no direct link to your positions."
      : `Matches ${reasons.slice(0, 3).join(", ")} — relevant to a ${ctx.riskLevel} book.`;
  return { score: final, reason, tags: Array.from(new Set(tags)).slice(0, 8) };
}

/**
 * Blend an LLM judgement with the deterministic score. The heuristic acts as a
 * floor for direct-holding hits so a model miss can never bury a headline that
 * literally names a position.
 */
export function blendRelevance(heuristic: RelevanceScore, llm: RelevanceScore | null): RelevanceScore {
  if (!llm) return heuristic;
  const holdsDirect = heuristic.tags.some((t) => t.startsWith("holding:"));
  const blended = Math.round(0.65 * llm.score + 0.35 * heuristic.score);
  const score = clampRelevance(holdsDirect ? Math.max(blended, 60) : blended);
  return {
    score,
    reason: llm.reason?.trim() ? llm.reason.trim() : heuristic.reason,
    tags: Array.from(new Set([...heuristic.tags, ...llm.tags])).slice(0, 8),
  };
}

export type RelevanceSortable = {
  relevance_score?: number | null;
  fetched_at?: string | null;
  date: string;
};

function ts(item: RelevanceSortable): number {
  const raw = item.fetched_at ? Date.parse(item.fetched_at) : NaN;
  if (Number.isFinite(raw)) return raw;
  const day = Date.parse(`${item.date}T00:00:00Z`);
  return Number.isFinite(day) ? day : 0;
}

/**
 * Most-relevant first, newest-first inside equal scores. Unscored rows sort as
 * 0 so they never outrank a scored headline.
 */
export function sortByRelevance<T extends RelevanceSortable>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0) || ts(b) - ts(a),
  );
}
