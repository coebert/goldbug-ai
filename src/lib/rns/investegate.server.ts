// Fetch layer for RNS director / PDMR filings.
//
// Investegate mirrors the RNS wire per company at /company/<TIDM>; each
// announcement page carries the full MAR Article 19 notification. Both are
// plain HTML with no API key, so we scrape narrowly: the company listing, then
// only the announcement pages whose title says Director/PDMR Shareholding.

import {
  isPdmrTitle,
  parsePdmrNotifications,
  parseRnsListing,
  pdmrToEvent,
  type RnsListingItem,
} from "./investegate";
import type { InsiderDealingEvent, InsiderTarget } from "@/lib/insider-dealings";

const UA = "Mozilla/5.0 (compatible; goldbug-rns/1.0; +https://goldbug-ai.lovable.app)";
const TIMEOUT_MS = 10_000;
const BASE = "https://www.investegate.co.uk";

/** `MKS.L` / `MKS:xlon` -> `MKS`. Non-UK listings have no RNS. */
export function tidmFor(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  const m = s.match(/^([A-Z0-9.]+?)(?:\.L|:XLON)$/);
  if (!m) return null;
  const tidm = (m[1] as string).replace(/\.+$/, "");
  return /^[A-Z0-9]{2,5}$/.test(tidm) ? tidm : null;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return await res.text();
  } catch {
    return null;
  }
}

/** Recent announcements for one TIDM, newest first. */
export async function fetchRnsListing(tidm: string): Promise<RnsListingItem[]> {
  const html = await fetchText(`${BASE}/company/${encodeURIComponent(tidm)}`);
  return html ? parseRnsListing(html) : [];
}

export type RnsFetchOptions = {
  /** Only look at filings this recent. */
  windowDays?: number;
  /** Hard cap on announcement pages fetched per symbol. */
  maxAnnouncements?: number;
};

/** Director/PDMR dealings filed for one held symbol, as scored events. */
export async function fetchRnsDealings(
  target: InsiderTarget,
  opts: RnsFetchOptions = {},
): Promise<InsiderDealingEvent[]> {
  const tidm = tidmFor(target.symbol);
  if (!tidm) return [];

  const windowDays = Math.max(1, Math.min(120, Math.round(opts.windowDays ?? 14)));
  const maxAnnouncements = Math.max(1, Math.min(10, opts.maxAnnouncements ?? 4));
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const listing = (await fetchRnsListing(tidm))
    .filter((i) => i.date >= cutoff && isPdmrTitle(i.title))
    .slice(0, maxAnnouncements);

  const out: InsiderDealingEvent[] = [];
  for (const item of listing) {
    const page = await fetchText(item.url);
    if (!page) continue;
    const notes = parsePdmrNotifications(page, item.date);
    for (const n of notes) {
      out.push(
        pdmrToEvent(n, {
          symbol: target.symbol,
          company: target.company,
          url: item.url,
          announcedAt: item.date,
        }),
      );
    }
  }
  return out;
}

/**
 * RNS dealings across every held UK symbol. Sequential per symbol with a small
 * fan-out: Investegate is a courtesy mirror, not an API, and the Worker keeps
 * only a few sockets alive anyway.
 */
export async function collectRnsDealings(
  targets: readonly InsiderTarget[],
  opts: RnsFetchOptions = {},
): Promise<InsiderDealingEvent[]> {
  const queue = targets.filter((t) => tidmFor(t.symbol));
  const out: InsiderDealingEvent[] = [];

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      try {
        out.push(...(await fetchRnsDealings(target, opts)));
      } catch (err) {
        console.error(`rns: fetch failed for ${target.symbol}`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return out;
}
