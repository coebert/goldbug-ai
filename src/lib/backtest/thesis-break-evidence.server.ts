// Data layer for the real-tape thesis-break replay: pull filed director
// dealings and published-accounts scores for the replay universe, and turn a
// supplied set of cached headlines into a per-symbol evidence tape.
//
// News rows are injected (the caller decides whether they come from the
// authenticated Supabase client inside the app or from an offline dump in a
// script), so this module stays usable from both places.

import { SYMBOL_NAMES } from "@/lib/symbol-names";
import { fetchFundamentals } from "@/lib/fundamentals/yahoo-fundamentals.server";
import { scoreFundamentals } from "@/lib/fundamentals/score";
import { classifyEvents } from "./insider-event-study";
import { fetchInsiderTransactions } from "./insider-event-study.server";
import {
  buildEvidenceTape,
  type EvidenceInsiderRow,
  type EvidenceNewsRow,
  type EvidenceTape,
} from "./thesis-break-evidence";

/** Filed dealings for the replay universe, classified buy/sell/mechanical. */
export async function loadInsiderRows(symbols: readonly string[]): Promise<EvidenceInsiderRow[]> {
  const out: EvidenceInsiderRow[] = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const got = await Promise.all(batch.map((s) => fetchInsiderTransactions(s).catch(() => [])));
    for (const rows of got) {
      for (const e of classifyEvents(rows)) {
        if (e.action !== "buy" && e.action !== "sell") continue;
        out.push({
          symbol: e.symbol,
          date: e.date,
          direction: e.action,
          value: e.value,
          mechanical: e.flavour === "mechanical",
        });
      }
    }
  }
  return out;
}

/** Published-accounts score per symbol (current snapshot of the filings). */
export async function loadFundamentalsScores(
  symbols: readonly string[],
  asOf: string,
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const got = await Promise.all(
      batch.map(async (s) => {
        try {
          const f = await fetchFundamentals(s);
          return [s, f ? scoreFundamentals(f, asOf, s).score : null] as const;
        } catch {
          return [s, null] as const;
        }
      }),
    );
    for (const [s, v] of got) out[s.toUpperCase()] = v;
  }
  return out;
}

export type RealEvidenceRequest = {
  symbols: readonly string[];
  dates: readonly string[];
  news: readonly EvidenceNewsRow[];
  asOf?: string;
};

/** News + insider + fundamentals, assembled into one replay evidence tape. */
export async function loadRealEvidenceTape(req: RealEvidenceRequest): Promise<EvidenceTape> {
  const symbols = req.symbols.map((s) => s.toUpperCase());
  const asOf = req.asOf ?? new Date().toISOString().slice(0, 10);
  const [insider, fundamentals] = await Promise.all([
    loadInsiderRows(symbols),
    loadFundamentalsScores(symbols, asOf),
  ]);
  const names: Record<string, string | null> = {};
  for (const s of symbols) names[s] = SYMBOL_NAMES[s] ?? null;

  return buildEvidenceTape({
    symbols,
    names,
    news: req.news,
    insider,
    fundamentals,
    dates: req.dates,
  });
}
