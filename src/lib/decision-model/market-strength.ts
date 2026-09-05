// Signal strength broken down by market and by time of day.
//
// The per-symbol track record (symbol-strength.ts) answers "how much do I
// trust the score on THIS name". This module answers the question above it:
// "how much do I trust the score on this KIND of market, at this time of
// day". Crypto pairs trade 24/7 and behave nothing like a FTSE stock; a
// signal measured at the US open has a different hit rate to one measured
// overnight. The engine therefore weights crypto, forex and equities
// differently — and weights each differently again depending on when in the
// day the decision is being made.
//
// Pure module: classification and session arithmetic only, no I/O, so the
// rules are unit-testable.

import {
  summariseSymbolStrength,
  type StrengthObservation,
  type SymbolStrength,
} from "./symbol-strength";

/** Coarse market grouping the AI reasons in. Stocks and ETFs trade together. */
export type MarketGroup = "equities" | "crypto" | "forex" | "commodities";

export const MARKET_GROUPS: MarketGroup[] = ["equities", "crypto", "forex", "commodities"];

export const MARKET_LABELS: Record<MarketGroup, string> = {
  equities: "Shares & ETFs",
  crypto: "Crypto",
  forex: "Currency pairs",
  commodities: "Commodities",
};

/**
 * Time-of-day buckets, in London time (the account's home timezone and the
 * one the broker book settles in). Chosen to line up with the rhythm of the
 * markets this account trades rather than an even clock split.
 */
export type SessionBucket =
  | "overnight" // 22:00–07:00 — Asia session, thin liquidity here
  | "morning" // 07:00–11:00 — European open
  | "midday" // 11:00–14:30 — Europe midday, pre-US
  | "us_open" // 14:30–17:00 — US cash open overlap
  | "evening"; // 17:00–22:00 — US afternoon, Europe closed

export const SESSION_BUCKETS: SessionBucket[] = [
  "overnight",
  "morning",
  "midday",
  "us_open",
  "evening",
];

export const SESSION_LABELS: Record<SessionBucket, string> = {
  overnight: "Overnight (22:00–07:00)",
  morning: "Morning (07:00–11:00)",
  midday: "Midday (11:00–14:30)",
  us_open: "US open (14:30–17:00)",
  evening: "Evening (17:00–22:00)",
};

const LONDON_TZ = "Europe/London";

function londonHour(at: Date): number {
  // en-GB 24h parts; fall back to UTC if the runtime lacks the tz database.
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: LONDON_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) return h + m / 60;
  } catch {
    /* fall through to UTC */
  }
  return at.getUTCHours() + at.getUTCMinutes() / 60;
}

/** Which part of the trading day a timestamp falls in, London time. */
export function sessionForTimestamp(at: string | Date | null | undefined): SessionBucket | null {
  if (at == null) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  const h = londonHour(d);
  if (h >= 22 || h < 7) return "overnight";
  if (h < 11) return "morning";
  if (h < 14.5) return "midday";
  if (h < 17) return "us_open";
  return "evening";
}

const CRYPTO_RE = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BCH|DOT|AVAX|LINK)[-/]?USD$/i;

/**
 * Classify an instrument into the coarse market group. A caller that knows
 * the curated universe's asset class should pass it as the hint; otherwise we
 * fall back to the symbol's syntax (`=X` forex pairs, `-USD` crypto, `=F`
 * futures-style commodities, everything else equity/ETF).
 */
export function classifyMarketGroup(
  symbol: string,
  assetClassHint?: string | null,
): MarketGroup {
  const ac = (assetClassHint ?? "").toLowerCase();
  if (ac === "crypto") return "crypto";
  if (ac === "fx" || ac === "forex") return "forex";
  if (ac === "commodity") return "commodities";
  if (ac === "stock" || ac === "etf" || ac === "etc") return "equities";

  const s = symbol.trim().toUpperCase();
  if (s.endsWith("=X")) return "forex";
  if (s.endsWith("=F")) return "commodities";
  if (CRYPTO_RE.test(s)) return "crypto";
  return "equities";
}

/** One market × session cell of measured signal strength. */
export type MarketStrength = {
  market: MarketGroup;
  /** "all" aggregates every session; the rest are one session bucket each. */
  session: SessionBucket | "all";
  strength: SymbolStrength;
};

/**
 * Fold per-sample observations into one strength summary per market per
 * session, plus an "all" row per market. Samples without a timestamp
 * (rebuilt history) inform the market-level rows only.
 */
export function summariseMarketStrengths(args: {
  observations: Array<StrengthObservation & { symbol: string; at?: string | null }>;
  /** Optional symbol → asset class hint map (from the curated universe). */
  assetClassBySymbol?: Map<string, string>;
}): MarketStrength[] {
  const groups = new Map<string, StrengthObservation[]>();
  const push = (key: string, obs: StrengthObservation) => {
    const list = groups.get(key) ?? [];
    list.push(obs);
    groups.set(key, list);
  };

  for (const o of args.observations) {
    const base = (o.symbol.split(":")[0] ?? o.symbol).trim().toUpperCase();
    const market = classifyMarketGroup(base, args.assetClassBySymbol?.get(base));
    const obs: StrengthObservation = { date: o.date, score: o.score, y: o.y, ...(o.w == null ? {} : { w: o.w }) };
    push(`${market}|all`, obs);
    const session = sessionForTimestamp(o.at ?? null);
    if (session) push(`${market}|${session}`, obs);
  }

  const out: MarketStrength[] = [];
  for (const [key, obs] of groups) {
    const [market, session] = key.split("|") as [MarketGroup, SessionBucket | "all"];
    out.push({
      market,
      session,
      strength: summariseSymbolStrength(`${market} ${session}`, obs),
    });
  }
  // Markets first (fixed order), then all-sessions before the session cells.
  const order = (m: MarketGroup) => MARKET_GROUPS.indexOf(m);
  out.sort((a, b) =>
    order(a.market) !== order(b.market)
      ? order(a.market) - order(b.market)
      : a.session === "all"
        ? -1
        : b.session === "all"
          ? 1
          : SESSION_BUCKETS.indexOf(a.session as SessionBucket) -
            SESSION_BUCKETS.indexOf(b.session as SessionBucket),
  );
  return out;
}

/**
 * Weight one candidate's score by how reliable that market's signals have
 * been at this time of day. Blends the session-specific strength with the
 * all-day strength for the same market (70/30 — a thin session cell never
 * overrules a long all-day record), then scales the score by 0.6..1.4.
 * Unmeasured markets get the neutral prior, like unmeasured symbols do.
 */
export function marketSessionWeight(args: {
  market: MarketGroup;
  session: SessionBucket | null;
  rows: MarketStrength[] | null | undefined;
}): number {
  const all = args.rows?.find((r) => r.market === args.market && r.session === "all");
  const now =
    args.session == null
      ? undefined
      : args.rows?.find((r) => r.market === args.market && r.session === args.session);
  const blend = (a?: SymbolStrength, b?: SymbolStrength): number | null => {
    if (a && b) return 0.7 * a.strength + 0.3 * b.strength;
    if (a) return a.strength;
    if (b) return b.strength;
    return null;
  };
  const s = blend(now?.strength, all?.strength);
  const v = s == null || !Number.isFinite(s) ? 0.35 : s;
  return 0.6 + 0.8 * v; // 0.6 .. 1.4
}
