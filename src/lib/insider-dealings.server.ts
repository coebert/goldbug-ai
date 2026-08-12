// Server-only ingester for reported director / PDMR share dealings.
//
// For every symbol the book currently holds (plus anything on the watchlist),
// we pull a narrowly scoped Google News RSS feed, classify the headlines with
// the pure module, and upsert the resulting events into
// `insider_dealing_events`. The dedupe index makes repeated runs idempotent.

import {
  detectInsiderDealings,
  insiderFeedQueries,
  type InsiderDealingEvent,
  type InsiderNewsRow,
  type InsiderTarget,
} from "./insider-dealings";

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
  events: InsiderDealingEvent[];
};

/** Full pass: resolve held symbols, fetch feeds, persist new events. */
export async function ingestInsiderDealings(
  supabase: Sb,
  opts: { targets?: InsiderTarget[]; windowDays?: number } = {},
): Promise<InsiderIngestResult> {
  const targets = opts.targets ?? (await insiderTargetsFromHoldings(supabase));
  if (targets.length === 0) return { targets: 0, detected: 0, stored: 0, events: [] };

  const events = await collectInsiderDealings(targets, opts.windowDays ?? 3);
  if (events.length === 0) return { targets: targets.length, detected: 0, stored: 0, events: [] };

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

  return { targets: targets.length, detected: events.length, stored, events };
}
