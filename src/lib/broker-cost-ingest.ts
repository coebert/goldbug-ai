/**
 * Matching booked broker charges onto our fill tape.
 *
 * Pure: rows in, updates out. The server module does the I/O and the FX.
 *
 * Why matching is non-trivial: Saxo's cost report is keyed by *its* trade id,
 * which we never see at placement time. We hold the broker order id
 * (`broker_fill_id`) and our own client reference, and both are absent from
 * some report variants. So this walks three passes in descending confidence
 * and never lets one charge be applied to two fills — double-booking a
 * commission would silently inflate the friction KPI, which is precisely the
 * number this whole path exists to make trustworthy.
 */

import type { BrokerTradeCharge } from "./brokers/adapter";

export type IngestFill = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  fillPrice: number;
  currency: string;
  filledAt: string;
  /** Broker order id recorded when the fill was written. */
  brokerFillId: string | null;
  /** Broker trade id, once a previous ingest matched this fill. */
  brokerTradeId: string | null;
  feeSource: string | null;
};

export type ChargeUpdate = {
  fillId: string;
  brokerTradeId: string;
  /** Currency the charge amounts are stated in (may differ from the fill's). */
  currency: string;
  commission: number;
  exchangeFee: number;
  tax: number;
  other: number;
  total: number;
  /** How the charge was tied to the fill, for diagnostics. */
  matchedBy: "trade-id" | "order-id" | "attributes";
};

export type ChargeMatchResult = {
  updates: ChargeUpdate[];
  /** Fills still without broker cost data after this pass. */
  unmatchedFillIds: string[];
  /** Charges that belong to no fill we hold (manual trades, other portfolios). */
  unmatchedTradeIds: string[];
};

/** ±48h: a report row is dated by trade date, our fill by execution instant. */
const TIME_TOLERANCE_MS = 48 * 3_600_000;
const QTY_TOLERANCE_REL = 0.005;

/** `AAPL:xnas` / `VOD.L` / `vod:xlon` all reduce to the same base ticker. */
export function chargeSymbolKey(symbol: string): string {
  const head = String(symbol ?? "").toUpperCase().split(":")[0] ?? "";
  return head.replace(/\.[A-Z]{1,3}$/, "").trim();
}

function quantityMatches(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  const tol = Math.max(1e-6, Math.max(a, b) * QTY_TOLERANCE_REL);
  return Math.abs(a - b) <= tol;
}

function toUpdate(
  fill: IngestFill,
  charge: BrokerTradeCharge,
  matchedBy: ChargeUpdate["matchedBy"],
): ChargeUpdate {
  return {
    fillId: fill.id,
    brokerTradeId: charge.brokerTradeId,
    currency: (charge.currency || fill.currency || "GBP").toUpperCase(),
    commission: Math.max(0, charge.commission) || 0,
    exchangeFee: Math.max(0, charge.exchangeFee) || 0,
    tax: Math.max(0, charge.tax) || 0,
    other: Math.max(0, charge.other) || 0,
    total: Math.max(0, charge.total) || 0,
    matchedBy,
  };
}

export function matchChargesToFills(args: {
  fills: readonly IngestFill[];
  charges: readonly BrokerTradeCharge[];
  /** Client order references keyed by fill id, when the caller can supply them. */
  clientOrderIdsByFill?: Readonly<Record<string, string | null | undefined>>;
}): ChargeMatchResult {
  const usedCharges = new Set<string>();
  const claimedFills = new Set<string>();
  const updates: ChargeUpdate[] = [];
  const clientRefs = args.clientOrderIdsByFill ?? {};

  const claim = (fill: IngestFill, charge: BrokerTradeCharge, how: ChargeUpdate["matchedBy"]) => {
    usedCharges.add(charge.brokerTradeId);
    claimedFills.add(fill.id);
    updates.push(toUpdate(fill, charge, how));
  };

  const byTradeId = new Map<string, BrokerTradeCharge>();
  for (const c of args.charges) if (c.brokerTradeId) byTradeId.set(c.brokerTradeId, c);

  // Pass 1 — a fill we already tied to a trade id. Re-applying keeps the row
  // current when the broker restates a charge (corrections are common).
  for (const f of args.fills) {
    if (!f.brokerTradeId) continue;
    const c = byTradeId.get(f.brokerTradeId);
    if (c && !usedCharges.has(c.brokerTradeId)) claim(f, c, "trade-id");
  }

  // Pass 2 — broker order id, or our own client reference echoed back.
  for (const f of args.fills) {
    if (claimedFills.has(f.id)) continue;
    const ref = clientRefs[f.id];
    const c = args.charges.find(
      (x) =>
        !usedCharges.has(x.brokerTradeId) &&
        ((f.brokerFillId && x.brokerOrderId && x.brokerOrderId === f.brokerFillId) ||
          (!!ref && !!x.clientOrderId && x.clientOrderId === ref)),
    );
    if (c) claim(f, c, "order-id");
  }

  // Pass 3 — same instrument, same side, same size, close in time. Ambiguity
  // resolves to the nearest fill in time; anything left over stays unmatched
  // rather than being guessed onto an arbitrary row.
  const remaining = args.fills.filter((f) => !claimedFills.has(f.id));
  for (const c of args.charges) {
    if (usedCharges.has(c.brokerTradeId)) continue;
    if (!c.symbol || !c.side || !(c.quantity && c.quantity > 0) || !c.tradedAt) continue;
    const key = chargeSymbolKey(c.symbol);
    const at = Date.parse(c.tradedAt);
    if (!Number.isFinite(at)) continue;

    let best: { fill: IngestFill; dt: number } | null = null;
    for (const f of remaining) {
      if (claimedFills.has(f.id)) continue;
      if (chargeSymbolKey(f.symbol) !== key) continue;
      if (f.side !== c.side) continue;
      if (!quantityMatches(f.quantity, c.quantity)) continue;
      const dt = Math.abs(Date.parse(f.filledAt) - at);
      if (!Number.isFinite(dt) || dt > TIME_TOLERANCE_MS) continue;
      if (!best || dt < best.dt) best = { fill: f, dt };
    }
    if (best) claim(best.fill, c, "attributes");
  }

  return {
    updates,
    unmatchedFillIds: args.fills.filter((f) => !claimedFills.has(f.id)).map((f) => f.id),
    unmatchedTradeIds: args.charges
      .filter((c) => !usedCharges.has(c.brokerTradeId))
      .map((c) => c.brokerTradeId),
  };
}

/** Share of the tape now carrying broker-booked costs, 0..1. */
export function brokerCoverage(fills: readonly { feeSource: string | null }[]): number {
  if (fills.length === 0) return 0;
  const covered = fills.filter((f) => f.feeSource === "broker").length;
  return covered / fills.length;
}
