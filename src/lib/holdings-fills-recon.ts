// Ledger-vs-holdings reconciliation.
//
// The `holdings` table is a materialised view of the book: broker sync writes
// it, the engine reads it, and every valuation flows from it. The fills ledger
// (`live_fills`) is the immutable audit trail. When the two disagree, real
// money is being valued off a number no trade supports — that is exactly how
// the SGLN.L / V phantom shorts and the mirrored-portfolio bugs stayed hidden.
//
// This module is pure: it replays net fills per portfolio+symbol and diffs the
// result against stored holdings. Symbols are compared on `engineSymbolKey`, so
// a broker-native "V:xnys" holding matches a "V" fill rather than showing up as
// two spurious mismatches.

import { engineSymbolKey } from "./price-symbol";

export type ReconFill = {
  portfolioId: string;
  symbol: string;
  side: string | null;
  quantity: number | string | null;
};

export type ReconHolding = {
  portfolioId: string;
  symbol: string;
  quantity: number | string | null;
  avgCost?: number | string | null;
};

export type MismatchKind =
  | "ok"
  /** Fills replay to a negative position — the ledger implies a short. */
  | "phantom_short"
  /** Holdings row exists with no fills backing it at all. */
  | "holding_without_fills"
  /** Fills say we hold it, the holdings table has no row. */
  | "fills_without_holding"
  /** Both exist, quantities differ beyond tolerance. */
  | "quantity_mismatch";

export type ReconRow = {
  portfolioId: string;
  /** Canonical comparison key (e.g. "V", "MKS.L"). */
  symbol: string;
  /** Raw symbol as stored on the holdings row, when there is one. */
  holdingSymbol: string | null;
  fillsQuantity: number;
  holdingsQuantity: number;
  difference: number;
  kind: MismatchKind;
  severity: "none" | "warn" | "critical";
  detail: string;
};

export type ReconSummary = {
  checked: number;
  mismatches: number;
  critical: number;
  byKind: Record<Exclude<MismatchKind, "ok">, number>;
  rows: ReconRow[];
};

/** Share counts below this are broker dust, not a reconciliation failure. */
export const RECON_QTY_TOLERANCE = 1e-6;

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Net position per portfolio+canonical symbol implied by the fills ledger. */
export function netPositionsFromFills(fills: ReconFill[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of fills) {
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    const key = `${f.portfolioId}\u0000${engineSymbolKey(f.symbol)}`;
    const signed = String(f.side ?? "buy").toLowerCase() === "sell" ? -qty : qty;
    out.set(key, (out.get(key) ?? 0) + signed);
  }
  return out;
}

function classify(fillsQty: number, holdingsQty: number, hasHolding: boolean): {
  kind: MismatchKind;
  severity: ReconRow["severity"];
  detail: string;
} {
  if (fillsQty < -RECON_QTY_TOLERANCE) {
    return {
      kind: "phantom_short",
      severity: "critical",
      detail:
        "Fills replay to a negative position — a sell was booked against more shares than this portfolio held.",
    };
  }
  const diff = fillsQty - holdingsQty;
  if (Math.abs(diff) <= RECON_QTY_TOLERANCE) {
    return { kind: "ok", severity: "none", detail: "Ledger matches holdings." };
  }
  if (!hasHolding) {
    return {
      kind: "fills_without_holding",
      severity: "critical",
      detail: "Fills imply an open position but no holdings row exists — valuation misses it.",
    };
  }
  if (fillsQty <= RECON_QTY_TOLERANCE) {
    return {
      kind: "holding_without_fills",
      severity: "critical",
      detail: "Holdings row has no fills behind it — the position cannot be explained by any trade.",
    };
  }
  return {
    kind: "quantity_mismatch",
    severity: Math.abs(diff) / Math.max(fillsQty, holdingsQty) > 0.01 ? "critical" : "warn",
    detail: "Stored quantity differs from the quantity the fills ledger replays to.",
  };
}

/**
 * Diff net fills against the holdings table for every portfolio+symbol seen on
 * either side. Rows are returned worst-first so a UI can surface the critical
 * breaks without sorting.
 */
export function reconcileHoldingsAgainstFills(input: {
  fills: ReconFill[];
  holdings: ReconHolding[];
  /** When false, matching rows are dropped from `rows` (default false). */
  includeMatches?: boolean;
}): ReconSummary {
  const net = netPositionsFromFills(input.fills);

  const holdingsByKey = new Map<string, { symbol: string; quantity: number }>();
  for (const h of input.holdings) {
    const key = `${h.portfolioId}\u0000${engineSymbolKey(h.symbol)}`;
    const prev = holdingsByKey.get(key);
    holdingsByKey.set(key, {
      symbol: prev?.symbol ?? h.symbol,
      quantity: (prev?.quantity ?? 0) + num(h.quantity),
    });
  }

  const keys = new Set<string>([...net.keys(), ...holdingsByKey.keys()]);
  const rows: ReconRow[] = [];

  for (const key of keys) {
    const sep = key.indexOf("\u0000");
    const portfolioId = key.slice(0, sep);
    const symbol = key.slice(sep + 1);
    const fillsQuantity = net.get(key) ?? 0;
    const holding = holdingsByKey.get(key);
    const holdingsQuantity = holding?.quantity ?? 0;

    // A flat ledger with no holdings row is a fully closed position, not a break.
    if (
      !holding &&
      Math.abs(fillsQuantity) <= RECON_QTY_TOLERANCE &&
      fillsQuantity >= -RECON_QTY_TOLERANCE
    ) {
      continue;
    }

    const { kind, severity, detail } = classify(fillsQuantity, holdingsQuantity, Boolean(holding));
    if (kind === "ok" && !input.includeMatches) continue;

    rows.push({
      portfolioId,
      symbol,
      holdingSymbol: holding?.symbol ?? null,
      fillsQuantity,
      holdingsQuantity,
      difference: fillsQuantity - holdingsQuantity,
      kind,
      severity,
      detail,
    });
  }

  const order: Record<ReconRow["severity"], number> = { critical: 0, warn: 1, none: 2 };
  rows.sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    const d = Math.abs(b.difference) - Math.abs(a.difference);
    if (d !== 0) return d;
    return a.symbol.localeCompare(b.symbol);
  });

  const byKind: ReconSummary["byKind"] = {
    phantom_short: 0,
    holding_without_fills: 0,
    fills_without_holding: 0,
    quantity_mismatch: 0,
  };
  for (const r of rows) if (r.kind !== "ok") byKind[r.kind] += 1;

  return {
    checked: keys.size,
    mismatches: rows.filter((r) => r.kind !== "ok").length,
    critical: rows.filter((r) => r.severity === "critical").length,
    byKind,
    rows,
  };
}
