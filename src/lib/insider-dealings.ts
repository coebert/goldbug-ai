// Insider / director ("PDMR") share dealings for symbols the book holds.
//
// The world-events news reel is built from general wires and never carries
// RNS director-dealing notifications, so a CEO selling stock in a position
// worth ~30% of NAV can pass the engine by completely. This module closes
// that blind spot.
//
// We cannot read the LSE's RNS feed directly (Cloudflare-gated, no public
// API), so — exactly like `exec-posts.ts` does for social posts — we track
// *reported* dealings: a per-company Google News query scoped to
// director-dealing language, whose headlines are then classified here.
//
// Everything in this file is pure so the ingester, the server functions, the
// trading engine and the UI card share one interpretation (and it is cheap to
// unit-test).

export type InsiderDirection = "sell" | "buy" | "unknown";

/**
 * Why the shares moved. Tax/award disposals are mechanical (vesting
 * withholding) and carry almost no signal; a discretionary open-market sale
 * by a named executive is the one that matters.
 */
export type InsiderFlavour = "tax" | "award" | "discretionary" | "unknown";

export type InsiderNewsRow = {
  headline: string;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  date?: string | null;
};

export type InsiderTarget = {
  /** Engine/universe symbol, e.g. `MKS.L`. */
  symbol: string;
  /** Display company name, e.g. `Marks & Spencer`. */
  company: string;
  /** Extra lowercase surface forms that identify the company in a headline. */
  aliases?: string[];
};

export type InsiderDealingEvent = {
  symbol: string;
  company: string;
  event_date: string | null;
  headline: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  direction: InsiderDirection;
  flavour: InsiderFlavour;
  /** Named person, when the headline exposes one. */
  person: string | null;
  role: string | null;
  shares: number | null;
  /** Deal value in the headline's currency, best-effort. */
  value: number | null;
  /** 0..1 — how much attention this deserves. */
  severity: number;
  /** Bounded sentiment nudge for the engine, -0.15..+0.10. */
  sentiment_nudge: number;
};

/** Hard bounds on how much a reported dealing may move a signal. */
export const INSIDER_NUDGE_FLOOR = -0.15;
export const INSIDER_NUDGE_CEILING = 0.1;

const SELL_TERMS = [
  "sell",
  "sells",
  "sold",
  "sale of shares",
  "share sale",
  "disposal",
  "disposes",
  "offloads",
  "cashes in",
  "trims stake",
  "reduces stake",
];

const BUY_TERMS = [
  "buy",
  "buys",
  "bought",
  "purchase",
  "purchases",
  "acquires shares",
  "increases stake",
  "tops up",
  "adds to stake",
];

const INSIDER_TERMS = [
  "director",
  "pdmr",
  "chief executive",
  "ceo",
  "cfo",
  "coo",
  "chair",
  "chairman",
  "chairwoman",
  "finance chief",
  "executive",
  "board member",
  "insider",
  "founder",
];

const TAX_TERMS = ["tax", "withhold", "withheld", "settle a tax", "tax liability"];
const AWARD_TERMS = [
  "vesting",
  "vested",
  "award",
  "option",
  "share plan",
  "incentive plan",
  "lti",
  "sharesave",
  "restricted stock",
  "rsu",
];

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/\bchief executive( officer)?\b|\bceo\b/i, "CEO"],
  [/\bchief financial( officer)?\b|\bcfo\b|\bfinance chief\b/i, "CFO"],
  [/\bchief operating( officer)?\b|\bcoo\b/i, "COO"],
  [/\bchair(man|woman|person)?\b/i, "Chair"],
  [/\bfounder\b/i, "Founder"],
  [/\bdirector\b/i, "Director"],
  [/\bpdmr\b/i, "PDMR"],
];

function norm(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase();
}

function includesAny(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/**
 * Lowercase surface forms for a company, derived from its display name.
 * Strips the venue suffix the universe uses (`Marks & Spencer (LON)`) and adds
 * an ampersand/`and` variant so both spellings match.
 */
export function companyAliases(company: string, extra: string[] = []): string[] {
  const base = company
    .replace(/\((?:LON|LSE|NYSE|NASDAQ)\)/gi, "")
    .replace(/\b(plc|group|inc\.?|corp\.?|holdings|ltd\.?|limited)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const out = new Set<string>([base]);
  if (base.includes("&")) out.add(base.replace(/&/g, "and"));
  if (base.includes(" and ")) out.add(base.replace(/ and /g, " & "));
  for (const e of extra) {
    const v = e.trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out].filter((s) => s.length >= 3);
}

/** Google News RSS query that surfaces reported director dealings for a company. */
export function insiderFeedUrl(company: string, windowDays = 3): string {
  const name = company.replace(/\((?:LON|LSE|NYSE|NASDAQ)\)/gi, "").trim();
  const q =
    `when:${Math.max(1, Math.min(30, Math.round(windowDays)))}d ` +
    `"${name}" ` +
    `("director dealing" OR "director/PDMR" OR PDMR OR "director deals" OR ` +
    `"insider selling" OR "sells shares" OR "sold shares" OR "buys shares" OR "share sale")`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;
}

/** Parses a share count such as "560,402 shares" or "1.2 million shares". */
export function parseShareCount(text: string): number | null {
  const m = text.match(
    /([\d][\d,.]*)\s*(million|m\b|bn\b|billion)?\s*(?:ordinary\s+)?shares\b/i,
  );
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const scale = /^m|^million/i.test(m[2] ?? "")
    ? 1e6
    : /^bn|^billion/i.test(m[2] ?? "")
      ? 1e9
      : 1;
  return n * scale;
}

/** Parses a money amount such as "£2.15m", "$1,022,023" or "€3.4 million". */
export function parseDealValue(text: string): number | null {
  const m = text.match(/([£$€])\s?([\d][\d,.]*)\s*(m\b|million|bn\b|billion|k\b)?/i);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const suf = norm(m[3]);
  const scale = suf.startsWith("m") ? 1e6 : suf.startsWith("b") ? 1e9 : suf.startsWith("k") ? 1e3 : 1;
  return n * scale;
}

function detectRole(text: string): string | null {
  for (const [re, label] of ROLE_PATTERNS) if (re.test(text)) return label;
  return null;
}

/** Best-effort person extraction: the capitalised name before a role word. */
export function extractPerson(headline: string): string | null {
  const m = headline.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){0,2})\b(?=,?\s+(?:the\s+)?(?:chief|CEO|CFO|COO|chair|director|founder|finance chief))/,
  );
  return m ? m[1] : null;
}

export function classifyInsiderHeadline(row: InsiderNewsRow): {
  direction: InsiderDirection;
  flavour: InsiderFlavour;
  isInsider: boolean;
} {
  const text = `${norm(row.headline)} ${norm(row.summary)}`;
  const isInsider = includesAny(text, INSIDER_TERMS);
  const sells = includesAny(text, SELL_TERMS);
  const buys = includesAny(text, BUY_TERMS);
  const direction: InsiderDirection = sells && !buys ? "sell" : buys && !sells ? "buy" : "unknown";

  let flavour: InsiderFlavour = "unknown";
  if (includesAny(text, TAX_TERMS)) flavour = "tax";
  else if (includesAny(text, AWARD_TERMS)) flavour = "award";
  else if (direction !== "unknown") flavour = "discretionary";

  return { direction, flavour, isInsider };
}

/**
 * Severity 0..1 and the bounded sentiment nudge.
 *
 * A discretionary open-market sale by a named CEO scores highest; a
 * tax-withholding disposal is deliberately near-zero because it is a
 * mechanical consequence of vesting, not a view on the shares.
 */
export function scoreInsiderEvent(input: {
  direction: InsiderDirection;
  flavour: InsiderFlavour;
  role: string | null;
  value: number | null;
}): { severity: number; sentiment_nudge: number } {
  if (input.direction === "unknown") return { severity: 0.1, sentiment_nudge: 0 };

  const flavourWeight =
    input.flavour === "discretionary" ? 1 : input.flavour === "award" ? 0.35 : input.flavour === "tax" ? 0.15 : 0.5;
  const roleWeight =
    input.role === "CEO" || input.role === "Founder"
      ? 1
      : input.role === "CFO"
        ? 0.9
        : input.role === "Chair" || input.role === "COO"
          ? 0.75
          : 0.6;
  // Size: £250k barely registers, £5m+ saturates.
  const size = input.value == null ? 0.5 : Math.min(1, Math.max(0.15, Math.log10(Math.max(1, input.value / 250_000)) / Math.log10(20)));

  const severity = Math.min(1, Number((flavourWeight * roleWeight * (0.5 + 0.5 * size)).toFixed(3)));
  const raw = input.direction === "sell" ? -0.15 * severity : 0.1 * severity;
  const nudge = Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, raw));
  return { severity, sentiment_nudge: Number(nudge.toFixed(4)) };
}

/** Matches headlines to tracked companies and turns them into scored events. */
export function detectInsiderDealings(
  rows: InsiderNewsRow[],
  targets: InsiderTarget[],
): InsiderDealingEvent[] {
  const prepared = targets.map((t) => ({ ...t, aliases: companyAliases(t.company, t.aliases ?? []) }));
  const out: InsiderDealingEvent[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const headline = String(row.headline ?? "").trim();
    if (!headline) continue;
    const text = `${norm(headline)} ${norm(row.summary)}`;
    const { direction, flavour, isInsider } = classifyInsiderHeadline(row);
    if (!isInsider || direction === "unknown") continue;

    for (const target of prepared) {
      if (!target.aliases.some((a) => text.includes(a))) continue;
      const key = `${target.symbol}|${row.date ?? ""}|${headline.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const blob = `${headline} ${row.summary ?? ""}`;
      const role = detectRole(blob);
      const value = parseDealValue(blob);
      const { severity, sentiment_nudge } = scoreInsiderEvent({ direction, flavour, role, value });

      out.push({
        symbol: target.symbol,
        company: target.company,
        event_date: row.date ? String(row.date).slice(0, 10) : null,
        headline,
        summary: row.summary ?? null,
        source: row.source ?? null,
        url: row.url ?? null,
        direction,
        flavour,
        person: extractPerson(headline),
        role,
        shares: parseShareCount(blob),
        value,
        severity,
        sentiment_nudge,
      });
    }
  }

  return out.sort((a, b) => {
    const d = String(b.event_date ?? "").localeCompare(String(a.event_date ?? ""));
    return d !== 0 ? d : b.severity - a.severity;
  });
}

/**
 * Net per-symbol nudge the engine can apply, clamped to the same bounds so a
 * cluster of headlines about one filing cannot compound into a large signal.
 */
export function insiderSignalBySymbol(
  events: InsiderDealingEvent[],
): Array<{ symbol: string; nudge: number; events: number; worst: InsiderDealingEvent }> {
  const grouped = new Map<string, InsiderDealingEvent[]>();
  for (const e of events) {
    const list = grouped.get(e.symbol) ?? [];
    list.push(e);
    grouped.set(e.symbol, list);
  }

  return [...grouped.entries()]
    .map(([symbol, list]) => {
      const sum = list.reduce((acc, e) => acc + e.sentiment_nudge, 0);
      const nudge = Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, sum));
      const worst = [...list].sort((a, b) => b.severity - a.severity)[0];
      return { symbol, nudge: Number(nudge.toFixed(4)), events: list.length, worst };
    })
    .sort((a, b) => a.nudge - b.nudge);
}
