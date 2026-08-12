// Server-only ingester for reported director / PDMR share dealings.
//
// For every symbol the book currently holds (plus anything on the watchlist),
// we pull a narrowly scoped Google News RSS feed, classify the headlines with
// the pure module, and upsert the resulting events into
// `insider_dealing_events`. The dedupe index makes repeated runs idempotent.

import {
  detectInsiderDealings,
  insiderEventKey,
  insiderFeedQueries,
  type InsiderDealingEvent,
  type InsiderNewsRow,
  type InsiderTarget,
} from "./insider-dealings";
import { collectRnsDealings } from "./rns/investegate.server";

type Sb = { from: (table: string) => any };

/** Bounded fan-out: the Worker keeps only a few outbound sockets alive. */
const CONCURRENCY = 4;
const FEED_TIMEOUT_MS = 8_000;
const MAX_TARGETS = 20;

async function fetchFeed(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; goldbug-insider/1.0)" },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Resolves the symbols worth watching: current holdings first. */
export async function insiderTargetsFromHoldings(supabase: Sb): Promise<InsiderTarget[]> {
  const { UNIVERSE } = await import("./universe.server");
  const { engineSymbolKey } = await import("./price-symbol");

  const { data } = await supabase.from("holdings").select("symbol, quantity").limit(500);
  const symbols = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const qty = Number(row["quantity"]);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const key = engineSymbolKey(String(row["symbol"] ?? ""));
    if (key) symbols.add(key.toUpperCase());
  }

  const targets: InsiderTarget[] = [];
  for (const symbol of symbols) {
    const meta = UNIVERSE.find((u) => u.symbol.toUpperCase() === symbol);
    // Only single stocks have directors — ETFs/ETCs/crypto are skipped.
    if (!meta || meta.asset_class !== "stock") continue;
    targets.push({ symbol: meta.symbol, company: meta.name });
  }
  return targets.slice(0, MAX_TARGETS);
}

function decode(s: string): string {
  // Entities first, then tags: Google encodes an <a> element inside
  // <description>, so stripping tags before unescaping leaves markup behind.
  const unescaped = s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return unescaped
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minimal RSS item extraction. The world-events parser in `news-rss.server`
 * hard-drops anything older than 48h, which is wrong here: a filing published
 * last week is still the freshest insider signal for a name.
 */
export function parseInsiderFeed(xml: string, windowDays: number): InsiderNewsRow[] {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const out: InsiderNewsRow[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const chunk = m[1];
    const title = chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    if (!title) continue;
    const pub = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const ts = pub ? new Date(decode(pub)).getTime() : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    out.push({
      headline: decode(title),
      summary: chunk.match(/<description>([\s\S]*?)<\/description>/)?.[1]
        ? decode(chunk.match(/<description>([\s\S]*?)<\/description>/)![1]).slice(0, 300)
        : null,
      source: chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]
        ? decode(chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/)![1])
        : "news.google.com",
      url: chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? null,
      date: Number.isFinite(ts)
        ? new Date(ts).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
    });
  }
  return out;
}

/** Fetches + classifies dealings for the given targets (no DB writes). */
export async function collectInsiderDealings(
  targets: InsiderTarget[],
  windowDays = 7,
): Promise<InsiderDealingEvent[]> {
  const out: InsiderDealingEvent[] = [];
  const jobs: Array<{ target: InsiderTarget; query: string }> = [];
  for (const target of targets) {
    for (const query of insiderFeedQueries(target.company, windowDays)) {
      jobs.push({ target, query });
    }
  }

  async function worker() {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(job.query)}&hl=en-GB&gl=GB&ceid=GB:en`;
      const xml = await fetchFeed(url);
      if (!xml) continue;
      out.push(...detectInsiderDealings(parseInsiderFeed(xml, windowDays), [job.target]));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  // One filing is reported by several outlets — collapse identical headlines.
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.symbol}|${e.event_date ?? ""}|${e.headline.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type InsiderIngestResult = {
  targets: number;
  detected: number;
  stored: number;
  /** Events not previously in the table — the ones worth alerting on. */
  fresh: InsiderDealingEvent[];
  alerted: number;
  events: InsiderDealingEvent[];
};

/** Full pass: resolve held symbols, fetch feeds, persist new events, alert. */
export async function ingestInsiderDealings(
  supabase: Sb,
  opts: { targets?: InsiderTarget[]; windowDays?: number; alert?: boolean } = {},
): Promise<InsiderIngestResult> {
  const empty = { detected: 0, stored: 0, fresh: [], alerted: 0, events: [] };
  const targets = opts.targets ?? (await insiderTargetsFromHoldings(supabase));
  if (targets.length === 0) return { targets: 0, ...empty };

  const windowDays = opts.windowDays ?? 7;
  // Two sources: the official RNS filing (UK listings — authoritative, gives
  // name/role/price/volume) and the news wire (everything else, plus faster
  // secondary reporting).
  const [newsEvents, rnsEvents] = await Promise.all([
    collectInsiderDealings(targets, windowDays),
    collectRnsDealings(targets, { windowDays }).catch((err) => {
      console.error("rns: collect failed", err);
      return [] as InsiderDealingEvent[];
    }),
  ]);

  // RNS wins: drop reported-news duplicates of a filing we already hold in
  // primary form for the same symbol, day and direction.
  const covered = new Set(rnsEvents.map((e) => `${e.symbol}|${e.event_date ?? ""}|${e.direction}`));
  const seen = new Set<string>();
  const events = [...rnsEvents, ...newsEvents].filter((e) => {
    if (e.source !== "RNS (Investegate)" && covered.has(`${e.symbol}|${e.event_date ?? ""}|${e.direction}`)) return false;
    const key = insiderEventKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (events.length === 0) return { targets: targets.length, ...empty };

  // Which of these are genuinely new? The upsert cannot tell us per-row, and
  // the alert must only fire once per filing.
  const { data: known } = await supabase
    .from("insider_dealing_events")
    .select("symbol, event_date, headline")
    .in("symbol", [...new Set(events.map((e) => e.symbol))])
    .limit(1000);
  const knownKeys = new Set(
    ((known ?? []) as Array<Record<string, unknown>>).map((r) =>
      insiderEventKey({
        symbol: String(r["symbol"] ?? ""),
        event_date: (r["event_date"] as string | null) ?? null,
        headline: String(r["headline"] ?? ""),
      } as InsiderDealingEvent),
    ),
  );
  const fresh = events.filter((e) => !knownKeys.has(insiderEventKey(e)));

  const rows = events.map((e) => ({
    symbol: e.symbol,
    company: e.company,
    event_date: e.event_date,
    headline: e.headline,
    summary: e.summary,
    source: e.source,
    url: e.url,
    direction: e.direction,
    flavour: e.flavour,
    person: e.person,
    role: e.role,
    shares: e.shares,
    value: e.value,
    severity: e.severity,
    sentiment_nudge: e.sentiment_nudge,
  }));

  let stored = 0;
  const { error, count } = await supabase
    .from("insider_dealing_events")
    .upsert(rows, { onConflict: "symbol,event_date,headline", ignoreDuplicates: true, count: "exact" });
  if (error) {
    // The dedupe index is expression-based, so PostgREST cannot always target
    // it; fall back to inserting rows one by one and swallowing conflicts.
    for (const row of rows) {
      const { error: e2 } = await supabase.from("insider_dealing_events").insert(row);
      if (!e2) stored += 1;
    }
  } else {
    stored = count ?? rows.length;
  }

  let alerted = 0;
  if (opts.alert !== false && fresh.length > 0) {
    try {
      const { alertInsiderDisposals } = await import("./insider-dealing-alert.server");
      alerted = (await alertInsiderDisposals(fresh, { supabase })).sent;
    } catch (err) {
      console.error("insider-dealings: alert dispatch failed", err);
    }
  }

  return { targets: targets.length, detected: events.length, stored, fresh, alerted, events };
}

/**
 * Recent stored dealings, reduced to the per-symbol nudge the trading engine
 * applies. Kept here (not in the pure module) because it touches the DB.
 *
 * Where the scheduled AI scan has already reviewed an event, its vetted
 * `ai_nudge` wins over the keyword score, events it judged to be noise drop
 * out entirely, and a cluster of insiders dealing the same way earns a small
 * bounded premium.
 */
export async function loadRecentInsiderSignals(
  supabase: Sb,
  opts: { sinceDays?: number } = {},
): Promise<
  Array<{ symbol: string; nudge: number; events: number; worst: InsiderDealingEvent }>
> {
  const sinceDays = Math.max(1, Math.min(90, Math.round(opts.sinceDays ?? 14)));
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("insider_dealing_events")
    .select("*")
    .gte("event_date", since)
    .limit(500);
  if (error || !data) return [];

  const events = (data as Array<Record<string, unknown>>).map((r) => ({
    symbol: String(r["symbol"] ?? ""),
    company: String(r["company"] ?? ""),
    event_date: (r["event_date"] as string | null) ?? null,
    headline: String(r["headline"] ?? ""),
    summary: (r["summary"] as string | null) ?? null,
    source: (r["source"] as string | null) ?? null,
    url: (r["url"] as string | null) ?? null,
    direction: (r["direction"] as InsiderDealingEvent["direction"]) ?? "unknown",
    flavour: (r["flavour"] as InsiderDealingEvent["flavour"]) ?? "unknown",
    person: (r["person"] as string | null) ?? null,
    role: (r["role"] as string | null) ?? null,
    shares: r["shares"] == null ? null : Number(r["shares"]),
    value: r["value"] == null ? null : Number(r["value"]),
    severity: Number(r["severity"] ?? 0),
    sentiment_nudge: Number(r["sentiment_nudge"] ?? 0),
    ai_verdict: (r["ai_verdict"] as "signal" | "mechanical" | "noise" | null) ?? null,
    ai_confidence: r["ai_confidence"] == null ? null : Number(r["ai_confidence"]),
    ai_nudge: r["ai_nudge"] == null ? null : Number(r["ai_nudge"]),
    ai_rationale: (r["ai_rationale"] as string | null) ?? null,
  }));

  const { insiderSignalsWithAi } = await import("./insider-ai-scan");
  return insiderSignalsWithAi(events).map((s) => ({
    symbol: s.symbol,
    nudge: s.nudge,
    events: s.events,
    worst: s.worst as InsiderDealingEvent,
  }));
}

