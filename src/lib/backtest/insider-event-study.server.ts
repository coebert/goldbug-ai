// Data layer for the director-dealing event study.
//
// Events come from Yahoo's `insiderTransactions` module (roughly the last two
// years of filed director / PDMR dealings per ticker); prices come from the
// project's own cached daily tape. Both are read-only and public.

import { getDailyCandlesRange, type Candle } from "@/lib/market-data.server";
import { getYahooSession } from "@/lib/fundamentals/yahoo-fundamentals.server";
import {
  buildEventOutcomes,
  classifyEvents,
  summariseStudy,
  studyVerdict,
  DEFAULT_HORIZONS,
  type EventOutcome,
  type InsiderTx,
  type StudyBuckets,
} from "./insider-event-study";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** UK peers of Marks & Spencer plus the wider general-retail complex. */
export const MKS_PEERS = [
  "MKS.L",
  "TSCO.L",
  "SBRY.L",
  "NXT.L",
  "KGF.L",
  "DNLM.L",
  "FRAS.L",
  "CURY.L",
  "BME.L",
  "GRG.L",
  "ABF.L",
  "WTB.L",
] as const;

export function benchmarkFor(symbol: string): string | null {
  if (/\.L$/i.test(symbol)) return "^FTSE";
  if (/\.(DE|PA|AS|MI|MC)$/i.test(symbol)) return "^STOXX50E";
  return "^GSPC";
}

type Bag = Record<string, unknown>;
const raw = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && "raw" in (v as Bag)) {
    const r = (v as { raw?: unknown }).raw;
    return typeof r === "number" && Number.isFinite(r) ? r : null;
  }
  return null;
};
const fmtDate = (v: unknown): string | null => {
  if (v && typeof v === "object" && "fmt" in (v as Bag)) {
    const f = (v as { fmt?: unknown }).fmt;
    if (typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  }
  const n = raw(v);
  if (n == null) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function parseInsiderTransactions(symbol: string, result: Bag): InsiderTx[] {
  const block = (result["insiderTransactions"] as Bag | undefined) ?? {};
  const rows = (block["transactions"] as Bag[] | undefined) ?? [];
  const out: InsiderTx[] = [];
  for (const r of rows) {
    const date = fmtDate(r["startDate"]);
    if (!date) continue;
    out.push({
      symbol: symbol.toUpperCase(),
      date,
      person: (r["filerName"] as string | undefined)?.trim() || null,
      role: (r["filerRelation"] as string | undefined)?.trim() || null,
      shares: raw(r["shares"]),
      value: raw(r["value"]),
      text: (r["transactionText"] as string | undefined)?.trim() || null,
    });
  }
  return out;
}

/** Filed dealings for one ticker. Empty array when unavailable. */
export async function fetchInsiderTransactions(symbol: string): Promise<InsiderTx[]> {
  const attempt = async (force: boolean): Promise<InsiderTx[] | "retry"> => {
    const s = await getYahooSession(force);
    if (!s) return [];
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol,
    )}?modules=insiderTransactions&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(s.cookie ? { Cookie: s.cookie } : {}) },
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return force ? [] : "retry";
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return [];
    }
    const json = (await res.json()) as { quoteSummary?: { result?: Bag[] | null } };
    const result = json.quoteSummary?.result?.[0];
    return result ? parseInsiderTransactions(symbol, result) : [];
  };

  try {
    const first = await attempt(false);
    if (first !== "retry") return first;
    const second = await attempt(true);
    return second === "retry" ? [] : second;
  } catch (err) {
    console.error(`insider-event-study: fetch failed for ${symbol}`, err);
    return [];
  }
}

export type StudyRequest = {
  symbols?: string[];
  /** Ignore dealings smaller than this consideration, in the filing currency. */
  minValue?: number;
  horizons?: number[];
  /** Calendar days of tape to load around the events. */
  lookbackDays?: number;
};

export type StudyResult = {
  symbols: string[];
  events_seen: number;
  events_used: number;
  from: string;
  to: string;
  min_value: number;
  outcomes: EventOutcome[];
  study: StudyBuckets;
  verdict: ReturnType<typeof studyVerdict>;
  /** Same study restricted to the focus ticker, so a held name reads alone. */
  focus: { symbol: string; n: number; study: StudyBuckets } | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function runInsiderEventStudy(req: StudyRequest = {}): Promise<StudyResult> {
  const symbols = (req.symbols?.length ? req.symbols : [...MKS_PEERS]).map((s) =>
    s.trim().toUpperCase(),
  );
  const horizons = req.horizons?.length ? req.horizons : [...DEFAULT_HORIZONS];
  const minValue = req.minValue ?? 50_000;
  const lookbackDays = Math.max(180, Math.min(2_000, req.lookbackDays ?? 900));

  const to = iso(new Date());
  const from = iso(new Date(Date.now() - lookbackDays * 86_400_000));

  // Events (sequential-ish batches: Yahoo throttles hard on bursts).
  const txs: InsiderTx[] = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const got = await Promise.all(batch.map((s) => fetchInsiderTransactions(s)));
    for (const g of got) txs.push(...g);
  }
  const inWindow = txs.filter((t) => t.date >= from && t.date <= to);
  const classified = classifyEvents(inWindow);

  // Tape for every symbol that actually has an event, plus the benchmarks.
  const needed = [...new Set(classified.map((e) => e.symbol))];
  const benchSymbols = [...new Set(needed.map(benchmarkFor).filter((b): b is string => !!b))];
  const prices = new Map<string, Candle[]>();
  const benchmarks = new Map<string, Candle[]>();

  const loadTape = async (sym: string, into: Map<string, Candle[]>) => {
    try {
      const c = await getDailyCandlesRange(sym, from, to);
      if (c.length > 0) into.set(sym, c);
    } catch (err) {
      console.error(`insider-event-study: tape failed for ${sym}`, err);
    }
  };
  for (let i = 0; i < needed.length; i += 4) {
    await Promise.all(needed.slice(i, i + 4).map((s) => loadTape(s, prices)));
  }
  await Promise.all(benchSymbols.map((s) => loadTape(s, benchmarks)));

  const outcomes = buildEventOutcomes(classified, prices, benchmarks, benchmarkFor, {
    horizons,
    minValue,
  });
  const study = summariseStudy(outcomes, horizons);
  const focusSymbol = symbols.includes("MKS.L") ? "MKS.L" : (symbols[0] as string);
  const focusOutcomes = outcomes.filter((o) => o.symbol === focusSymbol);

  return {
    symbols,
    events_seen: inWindow.length,
    events_used: outcomes.length,
    from,
    to,
    min_value: minValue,
    outcomes,
    study,
    verdict: studyVerdict(study, horizons.includes(21) ? 21 : (horizons[horizons.length - 1] as number)),
    focus:
      focusOutcomes.length > 0
        ? { symbol: focusSymbol, n: focusOutcomes.length, study: summariseStudy(focusOutcomes, horizons) }
        : null,
  };
}
