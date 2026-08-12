// Pure parser for UK RNS "Director/PDMR Shareholding" notifications.
//
// Google News headlines only tell us a dealing was *reported*; the RNS itself
// is the primary filing and carries the fields that actually matter — the
// PDMR's name and position, the nature of the transaction (open-market sale
// vs Share Incentive Plan purchase vs vesting), the price, the volume and the
// transaction date. Investegate mirrors the RNS wire as plain HTML, so this
// module turns those pages into structured events.
//
// Everything here is pure text handling: fetching lives in the .server file.

import {
  scoreInsiderEvent,
  type InsiderDealingEvent,
  type InsiderDirection,
  type InsiderFlavour,
} from "@/lib/insider-dealings";

export type RnsListingItem = {
  /** ISO date the announcement hit the wire. */
  date: string;
  title: string;
  url: string;
};

/** One MAR Article 19 notification block inside a Director/PDMR RNS. */
export type PdmrNotification = {
  person: string | null;
  position: string | null;
  nature: string | null;
  /** Transaction date from field 4(e), else the announcement date. */
  date: string | null;
  price: number | null;
  volume: number | null;
  /** price x volume, when both are known. */
  value: number | null;
  currency: "GBP" | "GBX" | null;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** `28 Jul 2026` / `2026-07-28` / `28 July 2026` -> `2026-07-28`. */
export function parseRnsDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
  if (dmy) {
    const mm = MONTHS[(dmy[2] as string).slice(0, 3).toLowerCase()];
    if (mm) return `${dmy[3]}-${mm}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return null;
}

/** HTML entities + tags out, whitespace normalised. */
export function textify(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&pound;/gi, "£")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PDMR_TITLE = /director\s*\/?\s*pdmr\s+shareholding|holding\(s\)\s+in\s+company|transaction\s+in\s+own\s+shares/i;

/** Is this announcement title a director-dealing filing? */
export function isPdmrTitle(title: string): boolean {
  return PDMR_TITLE.test(title) && !/holding\(s\)\s+in\s+company/i.test(title)
    ? true
    : /director\s*\/?\s*pdmr/i.test(title);
}

/**
 * Announcement rows from an Investegate company page. The markup is a plain
 * table: `<td>date</td><td>time</td><td>source</td><td><a href>title</a></td>`.
 */
export function parseRnsListing(html: string): RnsListingItem[] {
  const out: RnsListingItem[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const chunk = row[1] as string;
    const link = chunk.match(/href="(https?:\/\/[^"]*\/announcement\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => textify(m[1] as string));
    const date = cells.map(parseRnsDate).find((d): d is string => !!d);
    if (!date) continue;
    out.push({ date, title: textify(link[2] as string), url: link[1] as string });
  }
  // Newest first, unique by URL.
  const seen = new Set<string>();
  return out
    .filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

const MECHANICAL_TERMS = [
  "share incentive plan",
  "partnership shares",
  "matching shares",
  "dividend shares",
  "sharesave",
  "save as you earn",
  "vesting",
  "vested",
  "award",
  "grant of",
  "nil-cost option",
  "exercise of option",
  "deferred bonus",
  "restricted stock",
  "scrip",
];
const TAX_TERMS = ["tax", "withhold", "withheld", "settle the tax", "paye", "national insurance"];
const SALE_TERMS = ["sale", "sold", "disposal", "dispose"];
const BUY_TERMS = ["purchase", "acquisition", "acquired", "bought", "subscription"];

/** Direction + flavour from the RNS "nature of the transaction" wording. */
export function classifyNature(nature: string | null | undefined): {
  direction: InsiderDirection;
  flavour: InsiderFlavour;
} {
  const t = (nature ?? "").toLowerCase();
  if (!t) return { direction: "unknown", flavour: "unknown" };

  const sale = SALE_TERMS.some((w) => t.includes(w));
  const buy = BUY_TERMS.some((w) => t.includes(w));
  // "Sale of shares to cover tax" is a sale first: check sells before buys.
  const direction: InsiderDirection = sale ? "sell" : buy ? "buy" : "unknown";

  let flavour: InsiderFlavour = "discretionary";
  if (TAX_TERMS.some((w) => t.includes(w))) flavour = "tax";
  else if (MECHANICAL_TERMS.some((w) => t.includes(w))) flavour = "award";
  return { direction, flavour };
}

function num(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Field 4(c) is a `Price(s) Volume(s)` pair, sometimes repeated. */
export function parsePriceVolume(segment: string): { price: number | null; volume: number | null; currency: "GBP" | "GBX" | null } {
  const pairs = [...segment.matchAll(/(£|GBP\s*|p\s*)?([\d,]+(?:\.\d+)?)\s*(p\b|pence|GBX)?\s+([\d,]+(?:\.\d+)?)/gi)];
  let volume = 0;
  let notional = 0;
  let currency: "GBP" | "GBX" | null = null;
  for (const m of pairs) {
    const pounds = (m[1] ?? "").includes("£") || /gbp/i.test(m[1] ?? "");
    const pence = !!m[3];
    const p = num(m[2]);
    const v = num(m[4]);
    if (p == null || v == null || v <= 0) continue;
    // Pence-quoted filings are the LSE norm; normalise everything to GBP.
    const priceGbp = pence && !pounds ? p / 100 : p;
    currency = pence && !pounds ? "GBX" : "GBP";
    volume += v;
    notional += priceGbp * v;
  }
  if (volume === 0) return { price: null, volume: null, currency: null };
  return { price: Number((notional / volume).toFixed(6)), volume, currency };
}

/**
 * Splits a Director/PDMR announcement body into one record per notification.
 * Blocks start at field 1 ("Details of the person discharging managerial
 * responsibilities"), so the numbered MAR template is the delimiter.
 */
export function parsePdmrNotifications(bodyText: string, fallbackDate: string | null): PdmrNotification[] {
  const text = textify(bodyText);
  const starts = [...text.matchAll(/Details of the person discharging managerial responsibilit/gi)].map(
    (m) => m.index ?? 0,
  );
  if (starts.length === 0) return [];

  const out: PdmrNotification[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const block = text.slice(starts[i] as number, (starts[i + 1] as number | undefined) ?? text.length);
    const person =
      block.match(/a\)\s*Name\s+(.+?)\s+(?:2\s|Reason for the notification)/i)?.[1]?.trim() ?? null;
    const position =
      block.match(/a\)\s*Position\s*\/?\s*status\s+(.+?)\s+(?:b\)|Initial notification)/i)?.[1]?.trim() ?? null;
    const nature =
      block.match(/b\)\s*Nature of the transaction\s+(.+?)\s+(?:c\)|Price\(s\))/i)?.[1]?.trim() ?? null;
    const dateRaw =
      block.match(/e\)\s*Date of the transaction\s+([^\s]+(?:\s+\w+\s+\d{4})?)/i)?.[1] ?? null;
    const pvSegment = block.match(/c\)\s*Price\(s\)[\s\S]{0,400}?Volume\(s\)([\s\S]{0,300}?)(?:d\)|e\)|$)/i)?.[1] ?? "";
    const pv = parsePriceVolume(pvSegment);

    if (!person && !nature) continue;
    out.push({
      person: person && person.length <= 80 ? person : null,
      position: position && position.length <= 120 ? position : null,
      nature: nature && nature.length <= 200 ? nature : null,
      date: parseRnsDate(dateRaw) ?? fallbackDate,
      price: pv.price,
      volume: pv.volume,
      value: pv.price != null && pv.volume != null ? Number((pv.price * pv.volume).toFixed(2)) : null,
      currency: pv.currency,
    });
  }
  return out;
}

const ROLE_MAP: Array<[RegExp, string]> = [
  [/chief executive|\bceo\b/i, "CEO"],
  [/chief financial|finance director|\bcfo\b/i, "CFO"],
  [/chair(man|woman|person)?\b/i, "Chair"],
  [/chief operating|operations director|\bcoo\b/i, "COO"],
  [/non-?executive/i, "Non-exec"],
  [/company secretary/i, "Secretary"],
  [/managing director/i, "MD"],
  [/director/i, "Director"],
];

/** Normalises the RNS "Position/status" line onto the engine's role labels. */
export function normaliseRole(position: string | null): string | null {
  if (!position) return null;
  for (const [re, label] of ROLE_MAP) if (re.test(position)) return label;
  return "PDMR";
}

/**
 * Turns one parsed notification into the same event shape the news-derived
 * ingester produces, so storage, alerts, scoring and the AI prompt are
 * identical regardless of source.
 */
export function pdmrToEvent(
  n: PdmrNotification,
  ctx: { symbol: string; company: string; url: string; announcedAt: string },
): InsiderDealingEvent {
  const { direction, flavour } = classifyNature(n.nature);
  const role = normaliseRole(n.position);
  const { severity, sentiment_nudge } = scoreInsiderEvent({
    direction,
    flavour,
    role,
    value: n.value,
  });

  const who = n.person ?? "PDMR";
  const verb = direction === "sell" ? "sold" : direction === "buy" ? "acquired" : "dealt in";
  const size = n.volume ? `${n.volume.toLocaleString("en-GB")} shares` : "shares";
  const at = n.price != null ? ` at £${n.price.toFixed(3)}` : "";
  const headline = `RNS: ${who} ${verb} ${size}${at} in ${ctx.company}`;

  return {
    symbol: ctx.symbol,
    company: ctx.company,
    event_date: n.date ?? ctx.announcedAt,
    headline,
    summary: n.nature ? `${n.position ? `${n.position}. ` : ""}${n.nature}`.slice(0, 300) : null,
    source: "RNS (Investegate)",
    url: ctx.url,
    direction,
    flavour,
    person: n.person,
    role,
    shares: n.volume,
    value: n.value,
    severity,
    sentiment_nudge,
  };
}
