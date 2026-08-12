import { createServerFn } from "@tanstack/react-start";

import type { SymbolSuggestion } from "./symbol-suggest";

type YahooQuote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  quoteType?: string;
  exchDisp?: string;
};

/**
 * Ticker lookup for the chart autocomplete. Queries the public Yahoo Finance
 * search endpoint (no key) and returns a small, normalised suggestion list.
 * Failures degrade to an empty list — the client still shows local matches.
 */
export const searchSymbols = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string }) => ({ query: String(input?.query ?? "").slice(0, 40) }))
  .handler(async ({ data }): Promise<SymbolSuggestion[]> => {
    const q = data.query.trim();
    if (q.length < 1) return [];

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      q,
    )}&quotesCount=10&newsCount=0&listsCount=0`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return [];
      }
      const json = (await res.json()) as { quotes?: YahooQuote[] };
      const allowed = new Set(["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "CURRENCY", "MUTUALFUND", "FUTURE"]);
      return (json.quotes ?? [])
        .filter((qt) => qt.symbol && allowed.has(String(qt.quoteType ?? "").toUpperCase()))
        .map((qt) => {
          const type = String(qt.quoteType ?? "").toUpperCase();
          const pretty =
            type === "EQUITY"
              ? "Equity"
              : type === "MUTUALFUND"
                ? "Fund"
                : type.charAt(0) + type.slice(1).toLowerCase();
          return {
            symbol: String(qt.symbol).toUpperCase(),
            label: qt.shortname ?? qt.longname ?? String(qt.symbol),
            kind: qt.exchDisp ? `${pretty} — ${qt.exchDisp}` : pretty,
            source: "remote" as const,
          };
        })
        .slice(0, 10);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  });
