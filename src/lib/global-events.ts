// Curated list of major global events (1975-2025) that materially moved markets.
// Client-safe (no server imports) so it can be reused by charts and diagnostics.

export type EventCategory =
  | "crisis"
  | "recession"
  | "policy"
  | "geopolitics"
  | "pandemic"
  | "bubble"
  | "shock";

export type GlobalEvent = {
  id: string;
  label: string;
  short: string; // 2-4 char chart marker
  start: string; // ISO yyyy-mm-dd
  end: string; // ISO yyyy-mm-dd (inclusive; same as start for a single-day marker)
  category: EventCategory;
  severity: 1 | 2 | 3; // 3 = market-defining
  note: string;
};

export const GLOBAL_EVENTS: GlobalEvent[] = [
  { id: "volcker", label: "Volcker shock (Fed hikes to 20%)", short: "VOL", start: "1979-10-06", end: "1982-08-01", category: "policy", severity: 3, note: "Aggressive rate hikes crush inflation; deep 1981-82 recession." },
  { id: "black-monday", label: "Black Monday", short: "BM", start: "1987-10-19", end: "1987-10-19", category: "crisis", severity: 3, note: "S&P 500 drops 20.5% in a single session." },
  { id: "gulf-war", label: "Gulf War oil spike", short: "GW", start: "1990-08-02", end: "1991-02-28", category: "geopolitics", severity: 2, note: "Iraq invasion of Kuwait; oil doubles; brief US recession." },
  { id: "asia-crisis", label: "Asian financial crisis", short: "AC", start: "1997-07-02", end: "1998-01-31", category: "crisis", severity: 2, note: "Thai baht devaluation cascades across EM Asia." },
  { id: "ltcm", label: "LTCM / Russia default", short: "LTCM", start: "1998-08-17", end: "1998-10-08", category: "crisis", severity: 2, note: "Russia defaults; LTCM hedge fund collapse; Fed cuts." },
  { id: "dotcom", label: "Dot-com bust", short: "DOT", start: "2000-03-10", end: "2002-10-09", category: "bubble", severity: 3, note: "Nasdaq -78% peak to trough; tech multiples reset." },
  { id: "9-11", label: "9/11 attacks", short: "911", start: "2001-09-11", end: "2001-09-21", category: "geopolitics", severity: 3, note: "US markets closed 4 sessions; risk assets sell off." },
  { id: "gfc", label: "Global Financial Crisis", short: "GFC", start: "2007-10-09", end: "2009-03-09", category: "crisis", severity: 3, note: "Subprime → Lehman → S&P -57%; QE1 launched." },
  { id: "eu-debt", label: "Euro sovereign debt crisis", short: "EU", start: "2010-04-01", end: "2012-07-31", category: "crisis", severity: 2, note: "Greece/PIIGS; Draghi 'whatever it takes' ends acute phase." },
  { id: "flash-crash", label: "Flash Crash", short: "FC", start: "2010-05-06", end: "2010-05-06", category: "shock", severity: 1, note: "S&P intraday -9% then recovers within minutes." },
  { id: "us-downgrade", label: "US credit downgrade", short: "S&P", start: "2011-08-05", end: "2011-10-04", category: "policy", severity: 2, note: "S&P strips AAA; equity vol spike, gold rally." },
  { id: "taper-tantrum", label: "Taper tantrum", short: "TAP", start: "2013-05-22", end: "2013-09-05", category: "policy", severity: 1, note: "Bernanke hints at QE taper; rates spike, EM sells off." },
  { id: "china-2015", label: "China devaluation / oil crash", short: "CN", start: "2015-08-11", end: "2016-02-11", category: "shock", severity: 2, note: "PBoC devalues yuan; oil to $26; equity correction." },
  { id: "brexit", label: "Brexit vote", short: "BX", start: "2016-06-23", end: "2016-07-06", category: "geopolitics", severity: 2, note: "GBP -8% overnight; gilts rally; FTSE recovers fast." },
  { id: "volmageddon", label: "Volmageddon", short: "VIX", start: "2018-02-05", end: "2018-02-09", category: "shock", severity: 1, note: "Short-vol ETPs blow up; VIX doubles in a day." },
  { id: "q4-2018", label: "Q4 2018 selloff", short: "Q4", start: "2018-10-03", end: "2018-12-24", category: "policy", severity: 2, note: "Fed hiking + trade war fears; S&P -20% peak to trough." },
  { id: "covid", label: "COVID crash", short: "CV", start: "2020-02-19", end: "2020-03-23", category: "pandemic", severity: 3, note: "Fastest bear ever: S&P -34% in ~5 weeks; unlimited QE response." },
  { id: "covid-recovery", label: "COVID QE recovery", short: "QE", start: "2020-03-24", end: "2021-01-05", category: "policy", severity: 2, note: "Unprecedented monetary + fiscal stimulus; risk assets rip." },
  { id: "meme-jan21", label: "Meme-stock squeeze", short: "MM", start: "2021-01-25", end: "2021-02-05", category: "shock", severity: 1, note: "GME / retail short-squeeze episode." },
  { id: "ukraine", label: "Russia invades Ukraine", short: "UA", start: "2022-02-24", end: "2022-03-31", category: "geopolitics", severity: 2, note: "Energy + commodity spike; European equities fall." },
  { id: "inflation-22", label: "Inflation shock / Fed hikes", short: "CPI", start: "2022-01-03", end: "2022-10-14", category: "policy", severity: 3, note: "Fastest hiking cycle since Volcker; 60/40 worst year on record." },
  { id: "svb", label: "SVB / regional bank crisis", short: "SVB", start: "2023-03-08", end: "2023-05-01", category: "crisis", severity: 2, note: "SVB, Signature, First Republic; BTFP facility launched." },
  { id: "yen-carry", label: "Yen carry unwind", short: "YEN", start: "2024-07-31", end: "2024-08-07", category: "shock", severity: 1, note: "BoJ hike + soft US NFP → global 3-day sell-off." },
  { id: "tariffs-25", label: "Tariff / trade shock", short: "TAR", start: "2025-04-02", end: "2025-04-30", category: "policy", severity: 2, note: "Broad tariff announcements roil global equities." },
];

export const CATEGORY_COLORS: Record<EventCategory, string> = {
  crisis: "hsl(0 84% 60%)",
  recession: "hsl(24 90% 55%)",
  policy: "hsl(210 80% 60%)",
  geopolitics: "hsl(280 70% 62%)",
  pandemic: "hsl(340 78% 58%)",
  bubble: "hsl(43 90% 55%)",
  shock: "hsl(160 65% 45%)",
};

export function eventColor(cat: EventCategory): string {
  return CATEGORY_COLORS[cat];
}

/** Return events whose window intersects [fromISO, toISO] (both inclusive). */
export function eventsInRange(fromISO: string, toISO: string): GlobalEvent[] {
  if (!fromISO || !toISO) return [];
  return GLOBAL_EVENTS.filter((e) => !(e.end < fromISO || e.start > toISO));
}

/** Clip an event window to the chart's date domain so ReferenceArea x1/x2 render. */
export function clipToDomain(e: GlobalEvent, domainDates: string[]): { x1: string; x2: string } | null {
  if (!domainDates.length) return null;
  const first = domainDates[0];
  const last = domainDates[domainDates.length - 1];
  if (e.end < first || e.start > last) return null;
  // Snap to nearest chart date >= event.start and <= event.end
  const x1 = domainDates.find((d) => d >= e.start) ?? first;
  let x2 = first;
  for (const d of domainDates) {
    if (d <= e.end) x2 = d;
    else break;
  }
  if (x2 < x1) x2 = x1;
  return { x1, x2 };
}
