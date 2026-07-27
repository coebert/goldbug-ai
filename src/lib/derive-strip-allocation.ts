// Pure derivation for the HoldingsStrip on the portfolio card.
// Anchors the Invested/Cash allocation to the broker's authoritative
// totalEquity so:
//   - investedPct + cashPct == 100 (within rounding)
//   - investedValue == totalEquity − cash
//   - total (displayed) == totalEquity
//   - per-chip weights sum to investedPct (never to a raw cost-basis %)
//
// Cost basis (qty × avg_cost) is used ONLY to rank & split the
// authoritative invested amount across holdings — never as the
// headline Invested figure, which would otherwise disagree with the
// broker snapshot and produce percentages that don't add to 100.

export type StripHolding = {
  symbol: string;
  quantity: number;
  avg_cost: number;
};

export type StripChip = StripHolding & {
  qty: number;
  avg: number;
  /** Cost-basis (qty × avg_cost) — used for ranking only. */
  raw: number;
  /** Scaled to sum to authoritative investedValue. */
  value: number;
  /** Scaled to sum to investedPct. */
  weight: number;
};

export type StripAllocation = {
  chips: StripChip[];
  rawInvested: number;
  investedValue: number;
  safeCash: number;
  denom: number;
  investedPct: number;
  cashPct: number;
};

export function deriveStripAllocation(
  holdings: StripHolding[],
  cash: number,
  totalEquity: number,
): StripAllocation {
  const built = holdings.map((h) => {
    const qty = Number(h.quantity);
    const avg = Number(h.avg_cost);
    const raw = Number.isFinite(qty) && Number.isFinite(avg) ? qty * avg : 0;
    return { ...h, qty, avg, raw };
  });
  const rawInvested = built.reduce((s, r) => s + r.raw, 0);

  const safeTotal = Number.isFinite(totalEquity) && totalEquity > 0 ? totalEquity : 0;
  const safeCashIn = Number.isFinite(cash) ? Math.max(0, cash) : 0;

  // Fall back to raw sums only when the broker snapshot is unavailable.
  const denom = safeTotal > 0 ? safeTotal : Math.max(0, rawInvested + safeCashIn);
  const safeCash = Math.min(safeCashIn, denom);
  const investedValue = Math.max(0, denom - safeCash);
  const investedPct = denom > 0 ? (investedValue / denom) * 100 : 0;
  const cashPct = denom > 0 ? (safeCash / denom) * 100 : 0;

  const scale = rawInvested > 0 ? investedValue / rawInvested : 0;
  const chips: StripChip[] = built.map((r) => ({
    ...r,
    value: r.raw * scale,
    weight: denom > 0 ? ((r.raw * scale) / denom) * 100 : 0,
  }));

  return {
    chips,
    rawInvested,
    investedValue,
    safeCash,
    denom,
    investedPct,
    cashPct,
  };
}
