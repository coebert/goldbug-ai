// Policy-maker announcement tracking.
//
// Central bankers and finance ministers move whole markets with a single
// sentence — far more reliably than any single CEO does. We already ingest
// central-bank primary feeds and the wires into `news_cache`; this module
// detects the rows that actually *report an announcement* by a tracked
// policy maker, scores the language on a hawkish ↔ dovish axis, and turns
// that into a bounded, recency-decayed nudge the trading engine can consume
// alongside the CEO-post nudge.
//
// Everything here is pure so the engine, the server function and the UI card
// share one source of truth (and it is cheap to unit-test).

export type TrackedPolicyMaker = {
  id: string;
  name: string;
  /** Lowercase surface forms that identify the person in a headline. */
  aliases: string[];
  role: string;
  org: string;
  /** Currency most directly affected (ISO 4217). */
  ccy: string;
  region: string;
  /**
   * Symbols whose price reacts to this person's guidance, most direct first.
   * Sector/secondary proxies get half weight (see `computePolicySignals`).
   */
  symbols: string[];
  /** 0..1 — how market-moving this person's remarks historically are. */
  weight: number;
};

export const TRACKED_POLICY_MAKERS: TrackedPolicyMaker[] = [
  {
    id: "fed-chair",
    name: "Jerome Powell",
    aliases: ["jerome powell", "powell", "fed chair", "federal reserve chair"],
    role: "Chair, Federal Reserve",
    org: "Federal Reserve",
    ccy: "USD",
    region: "Americas",
    symbols: ["SPY", "QQQ", "TLT", "GLD"],
    weight: 1.0,
  },
  {
    id: "fomc",
    name: "FOMC",
    aliases: ["fomc", "federal open market committee", "federal reserve"],
    role: "US rate-setting committee",
    org: "Federal Reserve",
    ccy: "USD",
    region: "Americas",
    symbols: ["SPY", "QQQ", "TLT"],
    weight: 0.95,
  },
  {
    id: "boe-governor",
    name: "Andrew Bailey",
    aliases: ["andrew bailey", "bailey", "bank of england governor"],
    role: "Governor, Bank of England",
    org: "Bank of England",
    ccy: "GBP",
    region: "Europe",
    symbols: ["ISF.L", "VUKE.L", "IGLT.L"],
    weight: 0.9,
  },
  {
    id: "mpc",
    name: "BoE MPC",
    aliases: ["monetary policy committee", "bank of england", "boe"],
    role: "UK rate-setting committee",
    org: "Bank of England",
    ccy: "GBP",
    region: "Europe",
    symbols: ["ISF.L", "VUKE.L", "IGLT.L"],
    weight: 0.85,
  },
  {
    id: "ecb-president",
    name: "Christine Lagarde",
    aliases: ["christine lagarde", "lagarde", "ecb president"],
    role: "President, European Central Bank",
    org: "ECB",
    ccy: "EUR",
    region: "Europe",
    symbols: ["VGK", "EZU"],
    weight: 0.9,
  },
  {
    id: "boj-governor",
    name: "Kazuo Ueda",
    aliases: ["kazuo ueda", "ueda", "bank of japan governor"],
    role: "Governor, Bank of Japan",
    org: "Bank of Japan",
    ccy: "JPY",
    region: "Asia",
    symbols: ["EWJ"],
    weight: 0.8,
  },
  {
    id: "us-treasury",
    name: "US Treasury Secretary",
    aliases: ["treasury secretary", "scott bessent", "bessent", "us treasury"],
    role: "Secretary, US Treasury",
    org: "US Treasury",
    ccy: "USD",
    region: "Americas",
    symbols: ["SPY", "TLT"],
    weight: 0.8,
  },
  {
    id: "uk-chancellor",
    name: "UK Chancellor",
    aliases: ["chancellor of the exchequer", "rachel reeves", "reeves", "uk chancellor"],
    role: "Chancellor of the Exchequer",
    org: "HM Treasury",
    ccy: "GBP",
    region: "Europe",
    symbols: ["ISF.L", "IGLT.L"],
    weight: 0.8,
  },
  {
    id: "us-president",
    name: "US President",
    aliases: ["president trump", "donald trump", "the white house"],
    role: "US administration",
    org: "White House",
    ccy: "USD",
    region: "Americas",
    symbols: ["SPY", "QQQ"],
    weight: 0.85,
  },
  {
    id: "fed-speakers",
    name: "Fed governors / presidents",
    aliases: [
      "christopher waller",
      "waller",
      "john williams",
      "michelle bowman",
      "philip jefferson",
      "fed governor",
      "fed president",
    ],
    role: "FOMC voters",
    org: "Federal Reserve",
    ccy: "USD",
    region: "Americas",
    symbols: ["SPY", "TLT"],
    weight: 0.6,
  },
  {
    id: "opec",
    name: "OPEC+",
    aliases: ["opec", "opec+", "saudi energy minister"],
    role: "Oil supply policy",
    org: "OPEC+",
    ccy: "USD",
    region: "Global",
    symbols: ["USO", "XLE"],
    weight: 0.7,
  },
];

/** Phrases that mark a headline as reporting an *announcement*, not background. */
const ANNOUNCEMENT_MARKERS =
  /\b(say(s|ing)?|said|tell(s)?|told|warn(s|ed|ing)?|signal(s|led|ed|ling)?|speech|speaks|remarks|testimony|testifies|press conference|statement|minutes|announce(s|d|ment)?|guidance|comment(s|ed)?|rate (decision|cut|rise|hike|hold)|holds? rates|cuts? rates|raises? rates|policy decision|pledge(s|d)?|reiterat(e|es|ed))\b/i;

/** Language that leans restrictive (bad for risk assets, good for the currency). */
const HAWKISH = [
  "hawkish",
  "rate hike",
  "raise rates",
  "raising rates",
  "higher for longer",
  "tighten",
  "tightening",
  "restrictive",
  "inflation risk",
  "sticky inflation",
  "premature to cut",
  "no rush to cut",
  "patient on cuts",
  "upside risks to inflation",
  "quantitative tightening",
  "supply cut",
  "tariff",
];

/** Language that leans accommodative (good for risk assets). */
const DOVISH = [
  "dovish",
  "rate cut",
  "cut rates",
  "cutting rates",
  "ease",
  "easing",
  "accommodative",
  "stimulus",
  "support the economy",
  "inflation is cooling",
  "disinflation",
  "downside risks to growth",
  "quantitative easing",
  "liquidity support",
  "pause hikes",
  "soft landing",
];

export type PolicyStance = "hawkish" | "dovish" | "neutral";

/**
 * Score policy language on a -1 (hawkish / risk-negative) .. +1
 * (dovish / risk-positive) axis. Pure lexicon count, deliberately blunt.
 */
export function scorePolicyTone(text: string | null | undefined): number {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return 0;
  let hawk = 0;
  let dove = 0;
  for (const p of HAWKISH) if (lower.includes(p)) hawk += 1;
  for (const p of DOVISH) if (lower.includes(p)) dove += 1;
  if (hawk === 0 && dove === 0) return 0;
  const raw = (dove - hawk) / (dove + hawk);
  return Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
}

export function stanceOf(score: number): PolicyStance {
  if (score > 0.15) return "dovish";
  if (score < -0.15) return "hawkish";
  return "neutral";
}

export type PolicyRow = {
  headline: string;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  /** ISO date (YYYY-MM-DD) or full timestamp. */
  date?: string | null;
  /** -1..1 LLM sentiment if the scoring pass already ran. */
  sentiment?: number | null;
};

export type DetectedPolicyStatement = PolicyRow & {
  maker_id: string;
  maker_name: string;
  role: string;
  org: string;
  ccy: string;
  symbols: string[];
  /** -1 hawkish .. +1 dovish. */
  tone: number;
  stance: PolicyStance;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detects whether a headline (plus optional summary) reports an announcement
 * by a tracked policy maker. Returns null for ordinary coverage.
 */
export function detectPolicyStatement(
  headline: string | null | undefined,
  summary?: string | null,
): { maker: TrackedPolicyMaker; matched: string; tone: number } | null {
  const text = `${headline ?? ""} ${summary ?? ""}`.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (!ANNOUNCEMENT_MARKERS.test(lower)) return null;

  let best: { maker: TrackedPolicyMaker; matched: string } | null = null;
  for (const maker of TRACKED_POLICY_MAKERS) {
    for (const alias of maker.aliases) {
      const re = new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}([^\\p{L}]|$)`, "iu");
      if (!re.test(lower)) continue;
      if (
        !best ||
        maker.weight > best.maker.weight ||
        (maker.weight === best.maker.weight && alias.length > best.matched.length)
      ) {
        best = { maker, matched: alias };
      }
      break;
    }
  }
  if (!best) return null;
  return { ...best, tone: scorePolicyTone(lower) };
}

/** Filters raw news rows down to tracked policy announcements. */
export function detectPolicyStatements(rows: PolicyRow[]): DetectedPolicyStatement[] {
  const out: DetectedPolicyStatement[] = [];
  for (const r of rows) {
    const m = detectPolicyStatement(r.headline, r.summary);
    if (!m) continue;
    out.push({
      ...r,
      maker_id: m.maker.id,
      maker_name: m.maker.name,
      role: m.maker.role,
      org: m.maker.org,
      ccy: m.maker.ccy,
      symbols: m.maker.symbols,
      tone: m.tone,
      stance: stanceOf(m.tone),
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

function toMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const iso = date.length === 10 ? `${date}T12:00:00Z` : date;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export type PolicySignal = {
  symbol: string;
  /** -1 (restrictive / risk-off) .. +1 (accommodative / risk-on). */
  score: number;
  statements: number;
  makers: string[];
  maker_ids: string[];
  stance: PolicyStance;
  latest_date: string | null;
};

export type PolicyCurrencyStance = {
  ccy: string;
  score: number;
  stance: PolicyStance;
  statements: number;
  makers: string[];
};

/**
 * Per-symbol impact of tracked policy announcements with a 48h half-life
 * (guidance persists longer than a tweet, but a week-old speech is stale).
 * Tone drives the sign; LLM sentiment, when present, contributes 30%.
 */
export function computePolicySignals(
  rows: PolicyRow[],
  asOfISO: string,
  opts?: { halfLifeHours?: number },
): PolicySignal[] {
  const statements = detectPolicyStatements(rows);
  const asOfMs = toMs(asOfISO.length === 10 ? `${asOfISO}T23:59:59Z` : asOfISO) ?? Date.now();
  const halfLifeMs = (opts?.halfLifeHours ?? 48) * 3600 * 1000;

  const acc = new Map<
    string,
    { num: number; denom: number; count: number; makers: Set<string>; ids: Set<string>; latest: string | null }
  >();

  for (const s of statements) {
    const maker = TRACKED_POLICY_MAKERS.find((m) => m.id === s.maker_id);
    if (!maker) continue;
    const sentiment = s.sentiment == null || !Number.isFinite(s.sentiment) ? 0 : Number(s.sentiment);
    const value = s.tone !== 0 ? 0.7 * s.tone + 0.3 * sentiment : 0.5 * sentiment;
    if (value === 0) continue;

    const ms = toMs(s.date ?? null);
    const ageMs = ms == null ? 0 : Math.max(0, asOfMs - ms);
    if (ageMs > 7 * DAY_MS) continue;
    const recency = Math.pow(0.5, ageMs / halfLifeMs);

    s.symbols.forEach((symbol, idx) => {
      const proximity = idx === 0 ? 1 : 0.5;
      const w = maker.weight * recency * proximity;
      if (w <= 0) return;
      const key = symbol.toUpperCase();
      const cur =
        acc.get(key) ??
        { num: 0, denom: 0, count: 0, makers: new Set<string>(), ids: new Set<string>(), latest: null as string | null };
      cur.num += value * w;
      cur.denom += w;
      cur.count += 1;
      cur.makers.add(maker.name);
      cur.ids.add(maker.id);
      const d = (s.date ?? "").slice(0, 10) || null;
      if (d && (!cur.latest || d > cur.latest)) cur.latest = d;
      acc.set(key, cur);
    });
  }

  return Array.from(acc.entries())
    .map(([symbol, v]) => {
      const score = v.denom > 0 ? Number((v.num / v.denom).toFixed(3)) : 0;
      return {
        symbol,
        score,
        statements: v.count,
        makers: Array.from(v.makers).sort(),
        maker_ids: Array.from(v.ids).sort(),
        stance: stanceOf(score),
        latest_date: v.latest,
      };
    })
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.symbol.localeCompare(b.symbol));
}

/** Aggregate stance per currency — used by the FX/context blocks and the UI. */
export function computeCurrencyStances(
  rows: PolicyRow[],
  asOfISO: string,
): PolicyCurrencyStance[] {
  const statements = detectPolicyStatements(rows);
  const asOfMs = toMs(asOfISO.length === 10 ? `${asOfISO}T23:59:59Z` : asOfISO) ?? Date.now();
  const acc = new Map<string, { num: number; denom: number; count: number; makers: Set<string> }>();
  for (const s of statements) {
    const maker = TRACKED_POLICY_MAKERS.find((m) => m.id === s.maker_id);
    if (!maker) continue;
    const ms = toMs(s.date ?? null);
    const ageMs = ms == null ? 0 : Math.max(0, asOfMs - ms);
    if (ageMs > 7 * DAY_MS) continue;
    const recency = Math.pow(0.5, ageMs / (48 * 3600 * 1000));
    const w = maker.weight * recency;
    const cur = acc.get(maker.ccy) ?? { num: 0, denom: 0, count: 0, makers: new Set<string>() };
    cur.num += s.tone * w;
    cur.denom += w;
    cur.count += 1;
    cur.makers.add(maker.name);
    acc.set(maker.ccy, cur);
  }
  return Array.from(acc.entries())
    .map(([ccy, v]) => {
      const score = v.denom > 0 ? Number((v.num / v.denom).toFixed(3)) : 0;
      return { ccy, score, stance: stanceOf(score), statements: v.count, makers: Array.from(v.makers).sort() };
    })
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.ccy.localeCompare(b.ccy));
}

/** Max absolute adjustment a policy signal may apply to a symbol's news score. */
export const POLICY_MAX_NUDGE = 0.1;

/**
 * Bounded nudge applied on top of ordinary news sentiment for a symbol.
 * Confidence grows with statement count (1 => 50%, 3+ => 100%).
 */
export function policySentimentNudge(symbol: string, signals: PolicySignal[]): number {
  const sig = signals.find((s) => s.symbol === symbol.toUpperCase());
  if (!sig || sig.statements === 0) return 0;
  const confidence = Math.min(1, 0.5 + 0.25 * (sig.statements - 1));
  const raw = sig.score * confidence * POLICY_MAX_NUDGE;
  return Number(Math.max(-POLICY_MAX_NUDGE, Math.min(POLICY_MAX_NUDGE, raw)).toFixed(4));
}

/** Preformatted prompt block describing what policy makers just said. */
export function formatPolicyBlock(
  signals: PolicySignal[],
  stances: PolicyCurrencyStance[],
  recent: DetectedPolicyStatement[],
): string {
  const lines: string[] = ["POLICY-MAKER ANNOUNCEMENTS (hawkish -1 .. +1 dovish, recency-weighted):"];
  if (stances.length === 0 && signals.length === 0) {
    lines.push("- no tracked policy remarks in the last 7 days.");
    return lines.join("\n");
  }
  if (stances.length > 0) {
    lines.push(
      `Currency stance: ${stances
        .map((s) => `${s.ccy} ${s.stance} (${s.score.toFixed(2)}, ${s.statements} remark${s.statements === 1 ? "" : "s"})`)
        .join(" · ")}`,
    );
  }
  for (const s of signals.slice(0, 8)) {
    lines.push(
      `- ${s.symbol}: ${s.score.toFixed(2)} ${s.stance} from ${s.statements} remark(s) by ${s.makers.join(", ")} (latest ${s.latest_date ?? "n/a"})`,
    );
  }
  for (const r of recent.slice(0, 5)) {
    lines.push(`  • [${r.maker_name}] ${r.stance}: ${r.headline}`);
  }
  lines.push(
    "Hawkish guidance (tightening, higher-for-longer) argues for smaller BUYs and faster de-risking in that currency's assets; dovish guidance supports risk-taking only when the technicals already agree. Never trade a rate decision in the minutes before it prints.",
  );
  return lines.join("\n");
}

/** Google-News RSS query that surfaces reported remarks for each policy maker. */
export function policyFeedQuery(maker: TrackedPolicyMaker): string {
  const name = encodeURIComponent(`"${maker.name}"`);
  return `https://news.google.com/rss/search?q=when:2d+${name}+(speech+OR+remarks+OR+testimony+OR+said+OR+statement+OR+%22rate+decision%22)&hl=en-GB&gl=GB&ceid=GB:en`;
}
