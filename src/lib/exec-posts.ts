// Executive social-post tracking.
//
// Posts by a handful of high-profile founders/CEOs (Musk, Huang, Cook,
// Altman, Dimon...) move their own tickers — and sometimes whole sectors —
// faster than the wires do. We cannot read X/Truth Social directly (no API
// key, and scraping mirrors is unreliable), so instead we track *reported*
// posts: every catalogued newswire that covers "X posted / tweeted / wrote
// on Truth Social" is ingested into `news_cache` like any other headline,
// then this module detects those rows, maps them to affected symbols and
// produces a bounded sentiment nudge the trading engine can consume.
//
// Everything here is pure so the engine, the server functions and the UI
// card all share one source of truth (and it is cheap to unit-test).

export type TrackedExecutive = {
  id: string;
  /** Display name. */
  name: string;
  /** Lowercase surface forms that identify the person in a headline. */
  aliases: string[];
  /** Primary social handle (display only). */
  handle: string;
  org: string;
  /** Symbols whose price reacts to this person's posts, most direct first. */
  symbols: string[];
  /** 0..1 — how market-moving this person's posts historically are. */
  weight: number;
};

export const TRACKED_EXECUTIVES: TrackedExecutive[] = [
  {
    id: "musk",
    name: "Elon Musk",
    aliases: ["elon musk", "musk"],
    handle: "@elonmusk",
    org: "Tesla / SpaceX / xAI",
    symbols: ["TSLA", "DOGE-USD", "BTC-USD"],
    weight: 1.0,
  },
  {
    id: "huang",
    name: "Jensen Huang",
    aliases: ["jensen huang"],
    handle: "@nvidia",
    org: "Nvidia",
    symbols: ["NVDA", "SMH"],
    weight: 0.8,
  },
  {
    id: "cook",
    name: "Tim Cook",
    aliases: ["tim cook"],
    handle: "@tim_cook",
    org: "Apple",
    symbols: ["AAPL"],
    weight: 0.7,
  },
  {
    id: "altman",
    name: "Sam Altman",
    aliases: ["sam altman"],
    handle: "@sama",
    org: "OpenAI",
    symbols: ["MSFT", "NVDA"],
    weight: 0.75,
  },
  {
    id: "zuckerberg",
    name: "Mark Zuckerberg",
    aliases: ["mark zuckerberg", "zuckerberg"],
    handle: "@zuck",
    org: "Meta",
    symbols: ["META"],
    weight: 0.7,
  },
  {
    id: "dimon",
    name: "Jamie Dimon",
    aliases: ["jamie dimon"],
    handle: "JPMorgan",
    org: "JPMorgan Chase",
    symbols: ["JPM", "XLF"],
    weight: 0.7,
  },
  {
    id: "buffett",
    name: "Warren Buffett",
    aliases: ["warren buffett", "buffett"],
    handle: "Berkshire",
    org: "Berkshire Hathaway",
    symbols: ["BRK-B"],
    weight: 0.7,
  },
  {
    id: "bezos",
    name: "Jeff Bezos",
    aliases: ["jeff bezos", "bezos"],
    handle: "@jeffbezos",
    org: "Amazon / Blue Origin",
    symbols: ["AMZN"],
    weight: 0.6,
  },
  {
    id: "saylor",
    name: "Michael Saylor",
    aliases: ["michael saylor", "saylor"],
    handle: "@saylor",
    org: "Strategy (MicroStrategy)",
    symbols: ["MSTR", "BTC-USD"],
    weight: 0.65,
  },
  {
    id: "trump",
    name: "Donald Trump",
    aliases: ["donald trump", "president trump", "trump"],
    handle: "@realDonaldTrump",
    org: "US administration",
    symbols: ["SPY", "DJT"],
    weight: 0.9,
  },
];

/** Phrases that mark a headline as reporting a *post*, not generic coverage. */
const POST_MARKERS =
  /\b(post(ed|s|ing)?\s+(on|to)\s+(x|twitter|truth social|linkedin|threads|weibo)|tweet(ed|s|ing)?|(^|\s)x post|posted on x|wrote on x|says? (on|in a post on) x|truth social post|on truth social|in a post|social media post|linkedin post|threads post|weighs? in on x)\b/i;

export type ExecPostMatch = {
  executive: TrackedExecutive;
  /** Alias that matched. */
  matched: string;
  symbols: string[];
};

/**
 * Detects whether a headline (plus optional summary) reports a social-media
 * post by a tracked executive. Returns null for ordinary coverage such as
 * "Tesla beats delivery estimates" or "Musk to testify in court".
 */
export function detectExecutivePost(
  headline: string | null | undefined,
  summary?: string | null,
): ExecPostMatch | null {
  const text = `${headline ?? ""} ${summary ?? ""}`.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (!POST_MARKERS.test(lower)) return null;

  let best: ExecPostMatch | null = null;
  for (const exec of TRACKED_EXECUTIVES) {
    for (const alias of exec.aliases) {
      const re = new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}([^\\p{L}]|$)`, "iu");
      if (!re.test(lower)) continue;
      const candidate: ExecPostMatch = { executive: exec, matched: alias, symbols: exec.symbols };
      // Prefer the highest-weight executive, and longer alias matches
      // (so "elon musk" beats a bare "musk" on the same person).
      if (
        !best ||
        exec.weight > best.executive.weight ||
        (exec.weight === best.executive.weight && alias.length > best.matched.length)
      ) {
        best = candidate;
      }
      break;
    }
  }
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ExecPostRow = {
  headline: string;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  /** ISO date (YYYY-MM-DD) or full timestamp. */
  date?: string | null;
  /** -1..1 sentiment if the LLM pass already scored the row. */
  sentiment?: number | null;
};

export type ExecPostSignal = {
  symbol: string;
  /** -1..1 weighted, recency-decayed sentiment from tracked posts only. */
  score: number;
  posts: number;
  executives: string[];
  /** Ids of the contributing executives, for lesson-aware weighting. */
  executive_ids: string[];
  latest_date: string | null;
};

export type DetectedExecPost = ExecPostRow & {
  executive_id: string;
  executive_name: string;
  handle: string;
  org: string;
  symbols: string[];
};

/** Filters raw news rows down to the ones that report a tracked exec post. */
export function detectExecutivePosts(rows: ExecPostRow[]): DetectedExecPost[] {
  const out: DetectedExecPost[] = [];
  for (const r of rows) {
    const m = detectExecutivePost(r.headline, r.summary);
    if (!m) continue;
    out.push({
      ...r,
      executive_id: m.executive.id,
      executive_name: m.executive.name,
      handle: m.executive.handle,
      org: m.executive.org,
      symbols: m.symbols,
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

/**
 * Per-symbol impact of tracked executive posts, with a 36h half-life so a
 * two-day-old tweet barely registers. Symbols listed after the first in an
 * executive's mapping (sector proxies) get a 50% weight.
 */
export function computeExecPostSignals(
  rows: ExecPostRow[],
  asOfISO: string,
  opts?: { halfLifeHours?: number },
): ExecPostSignal[] {
  const posts = detectExecutivePosts(rows);
  const asOfMs = toMs(asOfISO.length === 10 ? `${asOfISO}T23:59:59Z` : asOfISO) ?? Date.now();
  const halfLifeMs = (opts?.halfLifeHours ?? 36) * 3600 * 1000;

  const acc = new Map<
    string,
    {
      num: number;
      denom: number;
      posts: number;
      execs: Set<string>;
      execIds: Set<string>;
      latest: string | null;
    }
  >();

  for (const p of posts) {
    if (p.sentiment == null || !Number.isFinite(p.sentiment)) continue;
    const exec = TRACKED_EXECUTIVES.find((e) => e.id === p.executive_id);
    if (!exec) continue;
    const postMs = toMs(p.date ?? null);
    const ageMs = postMs == null ? 0 : Math.max(0, asOfMs - postMs);
    if (ageMs > 7 * DAY_MS) continue;
    const recency = Math.pow(0.5, ageMs / halfLifeMs);

    p.symbols.forEach((symbol, idx) => {
      const proximity = idx === 0 ? 1 : 0.5;
      const w = exec.weight * recency * proximity;
      if (w <= 0) return;
      const key = symbol.toUpperCase();
      const cur =
        acc.get(key) ?? {
          num: 0,
          denom: 0,
          posts: 0,
          execs: new Set<string>(),
          execIds: new Set<string>(),
          latest: null,
        };
      cur.num += (p.sentiment as number) * w;
      cur.denom += w;
      cur.posts += 1;
      cur.execs.add(exec.name);
      cur.execIds.add(exec.id);
      const d = (p.date ?? "").slice(0, 10) || null;
      if (d && (!cur.latest || d > cur.latest)) cur.latest = d;
      acc.set(key, cur);
    });
  }

  return Array.from(acc.entries())
    .map(([symbol, v]) => ({
      symbol,
      score: v.denom > 0 ? Number((v.num / v.denom).toFixed(3)) : 0,
      posts: v.posts,
      executives: Array.from(v.execs).sort(),
      executive_ids: Array.from(v.execIds).sort(),
      latest_date: v.latest,
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.symbol.localeCompare(b.symbol));
}

/** Max absolute adjustment a post signal may apply to a symbol's news score. */
export const EXEC_POST_MAX_NUDGE = 0.15;

/**
 * Bounded nudge applied on top of the ordinary news sentiment for a symbol.
 * Confidence grows with post count (1 post => 50%, 3+ => 100%).
 */
export function execPostSentimentNudge(
  symbol: string,
  signals: ExecPostSignal[],
): number {
  const sig = signals.find((s) => s.symbol === symbol.toUpperCase());
  if (!sig || sig.posts === 0) return 0;
  const confidence = Math.min(1, 0.5 + 0.25 * (sig.posts - 1));
  const raw = sig.score * confidence * EXEC_POST_MAX_NUDGE;
  return Number(Math.max(-EXEC_POST_MAX_NUDGE, Math.min(EXEC_POST_MAX_NUDGE, raw)).toFixed(4));
}

/** Google-News RSS queries that surface reported posts for each executive. */
export function execPostFeedQuery(exec: TrackedExecutive): string {
  const name = encodeURIComponent(`"${exec.name}"`);
  return `https://news.google.com/rss/search?q=when:2d+${name}+(post+OR+posted+OR+tweet+OR+%22on+X%22+OR+%22Truth+Social%22)&hl=en-GB&gl=GB&ceid=GB:en`;
}
