// Pure ranking helpers behind the ticker autocomplete.
//
// Client-safe: the local catalogue is the curated pulse/drill-down symbol set.
// Remote matches (Yahoo search) are merged in by the caller and ranked with the
// same scorer so the dropdown ordering stays stable.

import { HISTORY_SYMBOLS, symbolMeta } from "./market-symbol-history";

export interface SymbolSuggestion {
  symbol: string;
  label: string;
  /** Context line, e.g. "US sector", "Equity — NASDAQ". */
  kind: string;
  source: "local" | "remote";
}

export const LOCAL_SUGGESTIONS: SymbolSuggestion[] = HISTORY_SYMBOLS.map((s) => {
  const meta = symbolMeta(s);
  return {
    symbol: s,
    label: meta?.label ?? s,
    kind: meta?.kind ?? "Market",
    source: "local" as const,
  };
});

/**
 * Higher is better; `null` means "no match". Exact ticker beats ticker prefix,
 * which beats a name-word prefix, which beats a loose substring hit.
 */
export function scoreSuggestion(s: SymbolSuggestion, query: string): number | null {
  const q = query.trim().toUpperCase();
  if (!q) return 0;
  const sym = s.symbol.toUpperCase();
  const label = s.label.toUpperCase();

  if (sym === q) return 100;
  if (sym.startsWith(q)) return 90 - Math.min(sym.length - q.length, 20);
  if (label.startsWith(q)) return 70 - Math.min(label.length - q.length, 20);
  if (label.split(/[\s&/-]+/).some((w) => w.startsWith(q))) return 60;
  if (sym.includes(q)) return 45;
  if (label.includes(q)) return 35;
  return null;
}

/** Rank + de-duplicate suggestions (local entries win ties over remote ones). */
export function rankSuggestions(
  items: SymbolSuggestion[],
  query: string,
  limit = 8,
): SymbolSuggestion[] {
  const seen = new Map<string, { item: SymbolSuggestion; score: number }>();
  for (const item of items) {
    const score = scoreSuggestion(item, query);
    if (score === null) continue;
    const key = item.symbol.toUpperCase();
    const prev = seen.get(key);
    if (!prev || score > prev.score || (score === prev.score && item.source === "local")) {
      seen.set(key, { item, score });
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.score - a.score || a.item.symbol.localeCompare(b.item.symbol))
    .slice(0, limit)
    .map((e) => e.item);
}
