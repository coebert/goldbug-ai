// Server-only ingester for reported director / PDMR share dealings.
//
// For every symbol the book currently holds (plus anything on the watchlist),
// we pull a narrowly scoped Google News RSS feed, classify the headlines with
// the pure module, and upsert the resulting events into
// `insider_dealing_events`. The dedupe index makes repeated runs idempotent.

import { parseRssFeed } from "./news-rss.server";
import {
  detectInsiderDealings,
  insiderFeedUrl,
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
  const { engineSymbolKey } = await import("./engine-symbol");

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

/** Fetches + classifies dealings for the given targets (no DB writes). */
export async function collectInsiderDealings(
  targets: InsiderTarget[],
  windowDays = 3,
): Promise<InsiderDealingEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const out: InsiderDealingEvent[] = [];
  const queue = [...targets];

  async function worker() {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      const xml = await fetchFeed(insiderFeedUrl(target.company, windowDays));
      if (!xml) continue;
      const items = parseRssFeed(xml, "news.google.com", today, 15);
      const rows: InsiderNewsRow[] = items.map((i) => ({
        headline: i.headline,
        summary: i.summary ?? null,
        source: i.source ?? null,
        url: i.url ?? null,
        date: i.date ?? today,
      }));
      out.push(...detectInsiderDealings(rows, [target]));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
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
