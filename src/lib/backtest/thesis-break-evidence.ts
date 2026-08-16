/**
 * Real evidence tape for the thesis-break replay (pure).
 *
 * The first version of the harness fed `evaluateThesisBreak` price-derived
 * stand-ins: a 10-bar drift stood in for sentiment momentum, and the news,
 * insider and fundamentals streams were simply `null`. That made the layer a
 * disguised momentum rule — the very thing the exit is supposed *not* to be.
 *
 * This module builds the three missing streams from the same sources the live
 * engine reads:
 *   - news score / momentum  → cached headlines scored −1..1, matched to a
 *     symbol by ticker token or company name, decayed over a trailing window;
 *   - insider nudge          → filed director dealings, signed by direction
 *     and decayed over a trailing window;
 *   - fundamentals score     → the published-accounts score for the symbol.
 *
 * Everything is pure: the caller supplies rows, the builder returns a
 * date-indexed lookup. Trend and failed-breakout stay price-derived because
 * they are price facts, not external evidence.
 */

export type EvidenceNewsRow = {
  headline: string;
  summary?: string | null;
  /** Numeric sentiment in −1..1 (strings are coerced; null rows are skipped). */
  sentiment: number | string | null;
  /** ISO YYYY-MM-DD. */
  date: string | null;
};

export type EvidenceInsiderRow = {
  symbol: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  direction: "buy" | "sell";
  /** Consideration in the filing currency; used to weight the nudge. */
  value?: number | null;
  /** Mechanical awards carry almost no view and are down-weighted. */
  mechanical?: boolean;
};

/** What the replay overlays on top of the price-derived evidence. */
export type ExternalEvidence = {
  newsScore: number | null;
  newsMomentum: number | null;
  insiderNudge: number | null;
  fundamentalsScore: number | null;
  /** Headlines that fed today's score — used for reporting/attribution. */
  newsCount: number;
};

export type EvidenceTape = {
  /** symbol → ISO date → evidence for that day. */
  bySymbol: Map<string, Map<string, ExternalEvidence>>;
  /** Earliest date with any external evidence (replay should start here). */
  from: string | null;
  to: string | null;
  coverage: {
    newsRowsMatched: number;
    insiderEvents: number;
    fundamentalsSymbols: number;
  };
};

export const NEWS_HALF_LIFE_DAYS = 5;
export const INSIDER_HALF_LIFE_DAYS = 21;
const NEWS_WINDOW_DAYS = 21;
const INSIDER_WINDOW_DAYS = 90;

const dayNum = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
const decay = (ageDays: number, halfLife: number) => Math.pow(0.5, ageDays / halfLife);
const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Strip an exchange suffix so "MKS.L" also matches a bare "MKS" token. */
export function tickerRoot(symbol: string): string {
  return symbol.toUpperCase().replace(/[.:][A-Z0-9]{1,4}$/, "").trim();
}

/** Company-name forms worth matching, derived from a display name. */
export function nameForms(name: string | null | undefined): string[] {
  if (!name) return [];
  const base = name.replace(/\s*\((LON|TSE|ASX|NYSE|NASDAQ)\)\s*$/i, "").trim();
  const short = base.replace(/\b(group|holdings?|plc|inc|corp(oration)?|ltd|limited|company|co)\b\.?/gi, "").trim();
  const forms = new Set<string>();
  for (const f of [base, short]) if (f.length >= 3) forms.add(f.toLowerCase());
  return [...forms];
}

/** Does this headline plausibly concern this symbol? */
export function headlineMatchesSymbol(
  text: string,
  symbol: string,
  names: readonly string[],
): boolean {
  const root = tickerRoot(symbol);
  if (root.length >= 2 && new RegExp(`\\b${root}\\b`, "i").test(text)) return true;
  const lower = text.toLowerCase();
  return names.some((n) => lower.includes(n));
}

export type BuildEvidenceInput = {
  symbols: readonly string[];
  /** symbol → display/company name used for headline matching. */
  names?: Record<string, string | null | undefined>;
  news: readonly EvidenceNewsRow[];
  insider: readonly EvidenceInsiderRow[];
  /** symbol → published-accounts score, −1..1. */
  fundamentals?: Record<string, number | null | undefined>;
  /** Dates to materialise (usually the trading dates of the replay). */
  dates: readonly string[];
};

export function buildEvidenceTape(input: BuildEvidenceInput): EvidenceTape {
  const symbols = input.symbols.map((s) => s.toUpperCase());
  const dates = [...input.dates].sort();

  // --- bucket news per symbol -------------------------------------------
  const matchedNews = new Map<string, Array<{ day: number; score: number }>>();
  let newsRowsMatched = 0;
  for (const sym of symbols) {
    const forms = nameForms(input.names?.[sym] ?? null);
    const rows: Array<{ day: number; score: number }> = [];
    for (const r of input.news) {
      const s = num(r.sentiment);
      if (s == null || !r.date) continue;
      const text = `${r.headline ?? ""} ${r.summary ?? ""}`;
      if (!headlineMatchesSymbol(text, sym, forms)) continue;
      rows.push({ day: dayNum(r.date), score: clamp1(s) });
    }
    rows.sort((a, b) => a.day - b.day);
    matchedNews.set(sym, rows);
    newsRowsMatched += rows.length;
  }

  // --- bucket insider dealings per symbol --------------------------------
  const insiderBySym = new Map<string, Array<{ day: number; signed: number }>>();
  let insiderEvents = 0;
  for (const e of input.insider) {
    const sym = e.symbol.toUpperCase();
    if (!symbols.includes(sym)) continue;
    const size = Math.abs(Number(e.value ?? 0));
    // Consideration → 0..1 weight; £1m+ counts as a full-size dealing.
    const weight = size > 0 ? Math.min(1, Math.log10(1 + size) / 6) : 0.4;
    const mech = e.mechanical ? 0.25 : 1;
    const signed = (e.direction === "sell" ? -1 : 1) * weight * mech;
    const list = insiderBySym.get(sym) ?? [];
    list.push({ day: dayNum(e.date), signed });
    insiderBySym.set(sym, list);
    insiderEvents += 1;
  }
  for (const list of insiderBySym.values()) list.sort((a, b) => a.day - b.day);

  const fundamentals = input.fundamentals ?? {};
  let fundamentalsSymbols = 0;
  for (const sym of symbols) if (num(fundamentals[sym] ?? null) != null) fundamentalsSymbols += 1;

  // --- materialise per (symbol, date) ------------------------------------
  const bySymbol = new Map<string, Map<string, ExternalEvidence>>();
  let from: string | null = null;
  let to: string | null = null;

  for (const sym of symbols) {
    const news = matchedNews.get(sym) ?? [];
    const ins = insiderBySym.get(sym) ?? [];
    const fund = num(fundamentals[sym] ?? null);
    const perDate = new Map<string, ExternalEvidence>();

    for (const date of dates) {
      const today = dayNum(date);

      const window = (fromDay: number, toDay: number) => {
        let w = 0;
        let acc = 0;
        let n = 0;
        for (const r of news) {
          if (r.day < fromDay || r.day > toDay) continue;
          const d = decay(toDay - r.day, NEWS_HALF_LIFE_DAYS);
          acc += r.score * d;
          w += d;
          n += 1;
        }
        return { score: w > 0 ? clamp1(acc / w) : null, n };
      };

      const cur = window(today - NEWS_WINDOW_DAYS, today);
      const prev = window(today - 2 * NEWS_WINDOW_DAYS, today - NEWS_WINDOW_DAYS);
      const newsMomentum =
        cur.score != null && prev.score != null ? clamp1(cur.score - prev.score) : null;

      let insiderAcc = 0;
      let insiderSeen = 0;
      for (const e of ins) {
        const age = today - e.day;
        if (age < 0 || age > INSIDER_WINDOW_DAYS) continue;
        insiderAcc += e.signed * decay(age, INSIDER_HALF_LIFE_DAYS);
        insiderSeen += 1;
      }
      const insiderNudge = insiderSeen > 0 ? clamp1(insiderAcc) : null;

      const hasAny = cur.score != null || insiderNudge != null || fund != null;
      if (hasAny) {
        if (from == null || date < from) from = date;
        if (to == null || date > to) to = date;
      }

      perDate.set(date, {
        newsScore: cur.score,
        newsMomentum,
        insiderNudge,
        fundamentalsScore: fund,
        newsCount: cur.n,
      });
    }
    bySymbol.set(sym, perDate);
  }

  return {
    bySymbol,
    from,
    to,
    coverage: { newsRowsMatched, insiderEvents, fundamentalsSymbols },
  };
}

/** Lookup helper the replay uses; returns nulls when there is no coverage. */
export function evidenceFor(
  tape: EvidenceTape | null | undefined,
  symbol: string,
  date: string,
): ExternalEvidence {
  const empty: ExternalEvidence = {
    newsScore: null,
    newsMomentum: null,
    insiderNudge: null,
    fundamentalsScore: null,
    newsCount: 0,
  };
  if (!tape) return empty;
  return tape.bySymbol.get(symbol.toUpperCase())?.get(date) ?? empty;
}
