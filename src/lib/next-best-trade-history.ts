/**
 * What happened to each buy the "next best trade" panel suggested.
 *
 * The panel says "buy 4 NVDA, expect about £22". This module answers the only
 * question that matters afterwards: was it bought, and was the £22 real? Each
 * logged suggestion is matched against the account's own buy fills in the days
 * that follow, then marked to the latest price.
 *
 * Suggestions that were never acted on are still scored — a paper outcome —
 * because skipping a good idea costs exactly as much as taking a bad one, and
 * the account holder deserves to see both sides.
 *
 * Pure: no IO, no broker, no database.
 */
import { roundMoney } from "./format-money";

export type SuggestionRecord = {
  id: string;
  symbol: string;
  name: string | null;
  currency: string;
  suggestedAt: string;
  conviction: number;
  /** Suggested price, instrument currency. */
  price: number;
  quantity: number;
  ticketBase: number;
  costBase: number;
  expectedProfitBase: number;
  netEdgeBps: number;
  recommended: boolean;
  blockedReason: string | null;
  /** Instrument currency -> account currency at read time. */
  fxToBase: number;
};

export type SuggestionFill = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Fill price, instrument currency. */
  price: number;
  /** Charge on the fill, account currency. */
  feeBase: number;
  filledAt: string;
};

export type SuggestionOutcome = {
  id: string;
  symbol: string;
  name: string | null;
  currency: string;
  suggestedAt: string;
  conviction: number;
  recommended: boolean;
  blockedReason: string | null;
  suggestedPrice: number;
  suggestedQuantity: number;
  ticketBase: number;
  expectedProfitBase: number;
  /** "bought" once any matching buy filled; "partial" below the suggested size. */
  status: "bought" | "partial" | "not_bought";
  filledQuantity: number;
  /** Weighted average fill price, instrument currency; null when unfilled. */
  avgFillPrice: number | null;
  /** Charges actually paid on the matched fills, account currency. */
  actualCostBase: number;
  /** Latest price, instrument currency; null when unknown. */
  priceNow: number | null;
  /** Move from the suggested price to now. */
  moveBps: number | null;
  /**
   * Money made or lost, account currency. Real for bought suggestions
   * (marked at the latest price, charges deducted); paper for skipped ones.
   */
  outcomeBase: number | null;
  /** True when outcomeBase is hypothetical because nothing was bought. */
  paper: boolean;
};

export type SuggestionHistorySummary = {
  suggestions: number;
  bought: number;
  skipped: number;
  /** Share of scored suggestions where the price rose after the call. */
  hitRatePct: number | null;
  expectedBase: number;
  /** Real money on suggestions that were bought. */
  actualBase: number;
  /** Paper money on suggestions that were skipped. */
  missedBase: number;
};

export type SuggestionHistory = {
  rows: SuggestionOutcome[];
  summary: SuggestionHistorySummary;
};

const DAY_MS = 86_400_000;

/**
 * @param matchWindowDays how long after a suggestion a buy still counts as
 *   acting on it. Longer than a few days and an unrelated later buy would be
 *   credited to the suggestion.
 */
export function buildSuggestionHistory(
  suggestions: readonly SuggestionRecord[],
  fills: readonly SuggestionFill[],
  pricesNow: Readonly<Record<string, number>>,
  matchWindowDays = 3,
): SuggestionHistory {
  const buysBySymbol = new Map<string, SuggestionFill[]>();
  for (const f of fills) {
    if (f.side !== "buy" || !(f.quantity > 0)) continue;
    const list = buysBySymbol.get(f.symbol) ?? [];
    list.push(f);
    buysBySymbol.set(f.symbol, list);
  }
  // A single fill can only settle one suggestion, otherwise a name suggested
  // several days running would claim the same purchase over and over.
  const claimed = new Set<SuggestionFill>();

  const ordered = [...suggestions].sort(
    (a, b) => Date.parse(a.suggestedAt) - Date.parse(b.suggestedAt),
  );

  const rows: SuggestionOutcome[] = ordered.map((s) => {
    const from = Date.parse(s.suggestedAt);
    const until = from + matchWindowDays * DAY_MS;
    const matched = (buysBySymbol.get(s.symbol) ?? []).filter((f) => {
      if (claimed.has(f)) return false;
      const at = Date.parse(f.filledAt);
      return Number.isFinite(at) && at >= from - DAY_MS / 24 && at <= until;
    });
    for (const f of matched) claimed.add(f);

    const filledQuantity = matched.reduce((sum, f) => sum + f.quantity, 0);
    const notional = matched.reduce((sum, f) => sum + f.quantity * f.price, 0);
    const avgFillPrice = filledQuantity > 0 ? notional / filledQuantity : null;
    const actualCostBase = matched.reduce((sum, f) => sum + (f.feeBase || 0), 0);

    const priceNowRaw = pricesNow[s.symbol];
    const priceNow = Number.isFinite(priceNowRaw) && priceNowRaw > 0 ? priceNowRaw : null;
    const moveBps =
      priceNow != null && s.price > 0 ? ((priceNow - s.price) / s.price) * 10_000 : null;

    const status: SuggestionOutcome["status"] =
      filledQuantity <= 0
        ? "not_bought"
        : filledQuantity + 1e-9 < s.quantity
          ? "partial"
          : "bought";

    let outcomeBase: number | null = null;
    if (priceNow != null) {
      if (filledQuantity > 0 && avgFillPrice != null) {
        outcomeBase = (priceNow - avgFillPrice) * filledQuantity * s.fxToBase - actualCostBase;
      } else if (s.quantity > 0) {
        // Paper: what taking the suggestion at its own price would have made,
        // less the charges the panel itself quoted.
        outcomeBase = (priceNow - s.price) * s.quantity * s.fxToBase - s.costBase;
      }
    }

    return {
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      currency: s.currency,
      suggestedAt: s.suggestedAt,
      conviction: s.conviction,
      recommended: s.recommended,
      blockedReason: s.blockedReason,
      suggestedPrice: s.price,
      suggestedQuantity: s.quantity,
      ticketBase: roundMoney(s.ticketBase),
      expectedProfitBase: roundMoney(s.expectedProfitBase),
      status,
      filledQuantity,
      avgFillPrice,
      actualCostBase: roundMoney(actualCostBase),
      priceNow,
      moveBps,
      outcomeBase: outcomeBase == null ? null : roundMoney(outcomeBase),
      paper: filledQuantity <= 0,
    };
  });

  rows.reverse(); // newest first for display

  let bought = 0;
  let expected = 0;
  let actual = 0;
  let missed = 0;
  let scored = 0;
  let hits = 0;
  for (const r of rows) {
    expected += r.expectedProfitBase;
    if (r.status !== "not_bought") {
      bought += 1;
      if (r.outcomeBase != null) actual += r.outcomeBase;
    } else if (r.outcomeBase != null) {
      missed += r.outcomeBase;
    }
    if (r.moveBps != null) {
      scored += 1;
      if (r.moveBps > 0) hits += 1;
    }
  }

  return {
    rows,
    summary: {
      suggestions: rows.length,
      bought,
      skipped: rows.length - bought,
      hitRatePct: scored > 0 ? (hits / scored) * 100 : null,
      expectedBase: roundMoney(expected),
      actualBase: roundMoney(actual),
      missedBase: roundMoney(missed),
    },
  };
}
