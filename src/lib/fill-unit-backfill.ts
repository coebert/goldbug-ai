// Re-normalising historical `live_fills` prices onto one unit.
//
// Two write paths booked fills for years: the order reconciler, which folded
// LSE pence to pounds through `resolveFillRecord`, and the live executor,
// which wrote Saxo's raw `avgFillPrice` (GBX for LSE common stocks). The
// ledger therefore holds the same instrument in two units — HSBA.L at 15.52
// next to 1556.20 — and every figure derived from it (cost basis, realised
// PnL, holdings reconciliation) is wrong wherever a pence row is involved.
//
// The executor is fixed, but the history is not. This module decides, per
// stored row, whether it is already in the instrument's base unit or still
// in exchange units, and what the corrected price should be.
//
// The decision cannot be "run every row through the folding rule again":
// most rows are already folded, and re-folding them would divide correct
// pounds by 100. It has to be evidence-based. For each fill we build a
// reference price in base units and compare:
//
//   reference  the cached close on/before the fill day, folded to base
//              (falls back to the median of the symbol's other fills that
//              already agree with a close — enough to fix rows on days we
//              never cached a price for)
//   ratio      stored / reference
//
// A ratio near 100 on a GBX-quoted symbol is a raw pence row: divide. A
// ratio near 1/100 is the opposite defect (a base-unit price folded twice):
// multiply. Anything else is left strictly alone — an unexplained 3x gap is
// a data question, not a unit question, and silently "fixing" it would
// destroy the evidence.
//
// Pure: no I/O, no clock. The server driver supplies fills and closes.

import { isLseGbxDisplayQuoted, normalizeLseDisplayPriceToBase } from "./market-price-units";
import { resolveFillCurrency } from "./fill-record";

/** Ratios inside this band of 100 count as a unit error, not a price move. */
const UNIT_RATIO_LO = 25;
const UNIT_RATIO_HI = 400;

export type BackfillFill = {
  id: string;
  portfolio_id: string;
  symbol: string;
  side: string | null;
  quantity: number | string | null;
  fill_price: number | string | null;
  currency: string | null;
  filled_at: string | null;
};

/** Cached daily closes in raw feed units: symbol → sorted [date, close]. */
export type CloseSeries = Map<string, Array<{ date: string; close: number }>>;

export type FillUnitAction =
  /** Stored price already in the instrument's base unit. */
  | "ok"
  /** Raw exchange units (GBX) stored as base — divide by 100. */
  | "fold_gbx"
  /** Base units folded a second time — multiply by 100. */
  | "unfold_gbx"
  /** Price is off by something that is not a unit factor. Left untouched. */
  | "unexplained"
  /** No reference price and no usable peer — cannot judge. Left untouched. */
  | "no_reference";

export type FillUnitDecision = {
  id: string;
  portfolioId: string;
  symbol: string;
  action: FillUnitAction;
  storedPrice: number;
  correctedPrice: number;
  /** Base-unit price the decision was measured against. */
  reference: number | null;
  referenceSource: "close" | "peer_fills" | null;
  ratio: number | null;
  storedCurrency: string | null;
  correctedCurrency: string;
  /** True when either the price or the currency needs rewriting. */
  changed: boolean;
};

export type FillUnitBackfillPlan = {
  decisions: FillUnitDecision[];
  changes: FillUnitDecision[];
  counts: Record<FillUnitAction, number>;
  /** Portfolios touched by at least one change — these need a P&L recompute. */
  affectedPortfolioIds: string[];
};

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

/** Latest cached close on or before `date`, folded into base units. */
export function referenceCloseFor(
  closes: CloseSeries,
  symbol: string,
  date: string,
): number | null {
  const upper = symbol.toUpperCase();
  const series = closes.get(upper) ?? closes.get(symbol) ?? [];
  let best: number | null = null;
  for (const row of series) {
    if (row.date <= date && Number.isFinite(row.close) && row.close > 0) best = row.close;
  }
  if (best === null) return null;
  const folded = normalizeLseDisplayPriceToBase(symbol, best);
  return folded > 0 ? folded : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function classify(
  symbol: string,
  stored: number,
  reference: number,
): { action: FillUnitAction; corrected: number; ratio: number } {
  const ratio = stored / reference;
  const gbx = isLseGbxDisplayQuoted(symbol);
  if (gbx && ratio >= UNIT_RATIO_LO && ratio <= UNIT_RATIO_HI) {
    return { action: "fold_gbx", corrected: stored / 100, ratio };
  }
  if (gbx && ratio <= 1 / UNIT_RATIO_LO && ratio >= 1 / UNIT_RATIO_HI) {
    return { action: "unfold_gbx", corrected: stored * 100, ratio };
  }
  // Outside the unit bands, or a symbol with no pence problem: leave it.
  const plausible = ratio > 1 / UNIT_RATIO_LO && ratio < UNIT_RATIO_LO;
  return { action: plausible ? "ok" : "unexplained", corrected: stored, ratio };
}

/**
 * Decide the corrected price and currency for every stored fill.
 *
 * `portfolioCurrency` maps portfolio id → base currency, used only as the
 * last resort when resolving a fill's currency.
 */
export function planFillUnitBackfill(params: {
  fills: BackfillFill[];
  closes: CloseSeries;
  portfolioCurrency?: Map<string, string>;
}): FillUnitBackfillPlan {
  const { fills, closes } = params;

  // Pass 1: measure every fill that has a cached close to compare against.
  // Those that come out "ok" become the peer reference for the same symbol
  // on days we never cached a price for.
  const peerBySymbol = new Map<string, number[]>();
  const measured = new Map<string, { reference: number; source: "close" }>();
  for (const f of fills) {
    const stored = num(f.fill_price);
    if (!(stored > 0)) continue;
    const day = String(f.filled_at ?? "").slice(0, 10);
    const ref = referenceCloseFor(closes, f.symbol, day);
    if (ref === null) continue;
    measured.set(f.id, { reference: ref, source: "close" });
    if (classify(f.symbol, stored, ref).action === "ok") {
      const key = f.symbol.toUpperCase();
      peerBySymbol.set(key, [...(peerBySymbol.get(key) ?? []), stored]);
    }
  }

  const decisions: FillUnitDecision[] = [];
  const counts: Record<FillUnitAction, number> = {
    ok: 0,
    fold_gbx: 0,
    unfold_gbx: 0,
    unexplained: 0,
    no_reference: 0,
  };

  for (const f of fills) {
    const stored = num(f.fill_price);
    const correctedCurrency = resolveFillCurrency({
      symbol: f.symbol,
      orderCcy: f.currency,
      portfolioCurrency: params.portfolioCurrency?.get(f.portfolio_id) ?? null,
    });

    let reference: number | null = null;
    let referenceSource: "close" | "peer_fills" | null = null;
    const fromClose = measured.get(f.id);
    if (fromClose) {
      reference = fromClose.reference;
      referenceSource = "close";
    } else {
      const peer = median(peerBySymbol.get(f.symbol.toUpperCase()) ?? []);
      if (peer !== null && peer > 0) {
        reference = peer;
        referenceSource = "peer_fills";
      }
    }

    let action: FillUnitAction;
    let corrected = stored;
    let ratio: number | null = null;
    if (!(stored > 0)) {
      // A zero/absent price is a different defect (missing datum), handled by
      // the reconcile path — not something a unit backfill should invent.
      action = "no_reference";
    } else if (reference === null) {
      action = "no_reference";
    } else {
      const c = classify(f.symbol, stored, reference);
      action = c.action;
      corrected = c.corrected;
      ratio = c.ratio;
    }

    counts[action] += 1;
    const priceChanged = corrected !== stored && corrected > 0;
    const ccyChanged =
      (f.currency ?? "").toUpperCase() !== correctedCurrency.toUpperCase();
    decisions.push({
      id: f.id,
      portfolioId: f.portfolio_id,
      symbol: f.symbol,
      action,
      storedPrice: stored,
      correctedPrice: corrected,
      reference,
      referenceSource,
      ratio,
      storedCurrency: f.currency ?? null,
      correctedCurrency,
      changed: priceChanged || ccyChanged,
    });
  }

  const changes = decisions.filter((d) => d.changed);
  return {
    decisions,
    changes,
    counts,
    affectedPortfolioIds: [...new Set(changes.map((d) => d.portfolioId))],
  };
}
