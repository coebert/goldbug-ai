// Pure planner for automatic equity-snapshot backfill.
//
// Cards render "No equity snapshots yet" (or fall back to raw cash) whenever a
// portfolio has zero rows in `equity_snapshots`, or when its newest row is
// stale. This module decides — deterministically, with no I/O — which snapshot
// rows are missing and what they should contain, so the read path can heal
// itself before the UI ever sees a hole.
//
// Rules:
//  1. Every portfolio must have a row for `today` reflecting current cash +
//     marked-to-market holdings. A stale same-day row is replaced; an already
//     correct row is left alone (idempotent).
//  2. Gaps between the last known snapshot and today are carried forward with
//     the last known total (flat line), never invented values, and capped at
//     `maxCarryForwardDays` so one dormant portfolio can't write hundreds of
//     rows.
//  3. Rows are never dated before the portfolio's inception date.

import { normalizeLseDisplayPriceToBase } from "./market-price-units";

export type BackfillPortfolio = {
  id: string;
  current_cash: number | string | null;
  /** ISO date (YYYY-MM-DD) of inception, or null when unknown. */
  inception: string | null;
};

export type BackfillHolding = {
  portfolio_id: string;
  symbol: string;
  quantity: number | string | null;
  avg_cost?: number | string | null;
  asset_class?: string | null;
};

export type BackfillSnapshot = {
  portfolio_id: string;
  snapshot_date: string;
  cash?: number | string | null;
  holdings_value?: number | string | null;
  total_value: number | string | null;
};

export type PlannedSnapshot = {
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  total_value: number;
  /** Why this row was planned — surfaced in diagnostics/tests. */
  reason: "today" | "carry_forward";
};

function num(value: number | string | null | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Mark a portfolio's holdings to market. Prices are keyed by symbol and are in
 * the symbol's native quote unit; LSE pence quotes are folded to GBP. Symbols
 * without a usable price fall back to `avg_cost` (cost basis) so a missing
 * quote never silently zeroes a position.
 */
export function markHoldingsToMarket(
  holdings: BackfillHolding[],
  prices: Map<string, number>,
): number {
  let total = 0;
  for (const h of holdings) {
    const qty = num(h.quantity);
    if (!(qty > 0)) continue;
    const symbol = String(h.symbol ?? "").trim();
    const raw = prices.get(symbol.toUpperCase());
    const px = raw != null && Number.isFinite(raw) && raw > 0
      ? normalizeLseDisplayPriceToBase(symbol, raw, h.asset_class)
      : num(h.avg_cost);
    if (!(px > 0)) continue;
    total += qty * px;
  }
  return round2(total);
}

export function planMissingEquitySnapshots({
  portfolios,
  snapshots,
  holdings,
  prices,
  today,
  maxCarryForwardDays = 30,
}: {
  portfolios: BackfillPortfolio[];
  snapshots: BackfillSnapshot[];
  holdings: BackfillHolding[];
  prices: Map<string, number>;
  today: string;
  maxCarryForwardDays?: number;
}): PlannedSnapshot[] {
  const snapsByPortfolio = new Map<string, BackfillSnapshot[]>();
  for (const s of snapshots) {
    const pid = String(s.portfolio_id);
    const arr = snapsByPortfolio.get(pid) ?? [];
    arr.push(s);
    snapsByPortfolio.set(pid, arr);
  }
  for (const arr of snapsByPortfolio.values()) {
    arr.sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  }

  const holdingsByPortfolio = new Map<string, BackfillHolding[]>();
  for (const h of holdings) {
    const pid = String(h.portfolio_id);
    const arr = holdingsByPortfolio.get(pid) ?? [];
    arr.push(h);
    holdingsByPortfolio.set(pid, arr);
  }

  const planned: PlannedSnapshot[] = [];

  for (const portfolio of portfolios) {
    const rows = snapsByPortfolio.get(portfolio.id) ?? [];
    const dates = new Set(rows.map((r) => String(r.snapshot_date).slice(0, 10)));
    const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
    const lastDate = last ? String(last.snapshot_date).slice(0, 10) : null;

    // Carry-forward fill for the gap between the last snapshot and today.
    if (lastDate && lastDate < today) {
      const carryTotal = num(last!.total_value, Number.NaN);
      if (Number.isFinite(carryTotal)) {
        const carryCash = num(last!.cash, Number.NaN);
        const cash = Number.isFinite(carryCash) ? carryCash : carryTotal;
        const holdingsValue = round2(Math.max(0, carryTotal - cash));
        let cursor = addDays(lastDate, 1);
        let written = 0;
        while (cursor < today && written < maxCarryForwardDays) {
          if (!dates.has(cursor) && (!portfolio.inception || cursor >= portfolio.inception)) {
            planned.push({
              portfolio_id: portfolio.id,
              snapshot_date: cursor,
              cash: round2(cash),
              holdings_value: holdingsValue,
              total_value: round2(carryTotal),
              reason: "carry_forward",
            });
            written += 1;
          }
          cursor = addDays(cursor, 1);
        }
      }
    }

    // Today's mark-to-market row. Do not treat the date alone as proof that the
    // value is current: an early read can create a cash-only row before fills
    // or prices arrive, and the date-keyed upsert would otherwise freeze that
    // incorrect value for the rest of the day.
    if (portfolio.inception && today < portfolio.inception) continue;
    const cash = round2(num(portfolio.current_cash));
    const holdingsValue = markHoldingsToMarket(
      holdingsByPortfolio.get(portfolio.id) ?? [],
      prices,
    );
    const total = round2(cash + holdingsValue);
    const todayRow = rows.find((row) => String(row.snapshot_date).slice(0, 10) === today);
    if (
      todayRow &&
      round2(num(todayRow.cash, Number.NaN)) === cash &&
      round2(num(todayRow.holdings_value, Number.NaN)) === holdingsValue &&
      round2(num(todayRow.total_value, Number.NaN)) === total
    ) {
      continue;
    }
    // Never write a meaningless all-zero row for a portfolio with no data at
    // all — that would render a flat zero line instead of an honest empty state.
    if (rows.length === 0 && total <= 0) continue;
    planned.push({
      portfolio_id: portfolio.id,
      snapshot_date: today,
      cash,
      holdings_value: holdingsValue,
      total_value: total,
      reason: "today",
    });
  }

  return planned;
}
