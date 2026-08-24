// Single authoritative source for the three headline portfolio numbers.
//
// Rules
// -----
// 1. When we have an equity snapshot (written by `writeCashSyncSnapshot`),
//    it is the ONLY source of truth: `total_value` and `cash` are already
//    FX/GBX-normalised to the portfolio's base currency and pass the
//    equity-invariants guardrails.
// 2. `invested = max(0, total_value − cash)` is derived from that same
//    snapshot so tiles cannot disagree by construction.
// 3. Only when no snapshot exists (brand-new portfolio, first tick) do we
//    fall back to `current_cash + Σ(qty × avg_cost)`. That sum is in native
//    instrument units and is flagged `source: "fallback_native"` so the UI
//    can render a caveat instead of pretending it's authoritative.
//
// Consumers MUST use this helper; never re-derive `totalValue`, `cash`, or
// `invested` locally from a mix of `equity_snapshots`, `portfolios.current_cash`
// and raw holdings — that mix is what caused the >100% invested tile bug.

import { holdingNativeValue } from "@/lib/fx-leg-value";

export type LatestSnapshot = {
  total_value?: number | string | null;
  cash?: number | string | null;
} | null | undefined;

export type HoldingLike = {
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
};


export type PortfolioMetrics = {
  totalValue: number;
  cash: number;
  invested: number;
  source: "snapshot" | "fallback_native";
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function derivePortfolioMetrics(input: {
  latestSnapshot: LatestSnapshot;
  currentCash: number | string | null | undefined;
  holdings: readonly HoldingLike[];
}): PortfolioMetrics {
  const snap = input.latestSnapshot;
  const snapTotal = snap == null ? NaN : Number(snap.total_value);
  const hasSnapshot = Number.isFinite(snapTotal);

  if (hasSnapshot) {
    const totalValue = Math.max(0, snapTotal);
    const rawSnapCash = snap == null ? null : snap.cash;
    const snapCash = rawSnapCash == null ? NaN : Number(rawSnapCash);
    // Prefer snapshot cash (same accounting basis as total_value).
    // Fall back to portfolio.current_cash only if the snapshot pre-dates
    // the cash column being populated.
    const cashCandidate = Number.isFinite(snapCash) ? snapCash : num(input.currentCash);
    // Clamp to [0, totalValue] so invested cannot go negative if a stale
    // cash value briefly exceeds the fresh total.
    const cash = Math.min(Math.max(0, cashCandidate), totalValue);
    const invested = Math.max(0, totalValue - cash);
    return { totalValue, cash, invested, source: "snapshot" };
  }

  const cash = Math.max(0, num(input.currentCash));
  // FX spot legs are funding conversions: their notional already sits in the
  // cash wallet, so they contribute unrealised P&L only (zero at cost here).
  const invested = input.holdings.reduce(
    (s, h) =>
      s +
      holdingNativeValue({
        assetClass: h.asset_class ?? null,
        quantity: num(h.quantity),
        price: num(h.avg_cost),
        avgCost: num(h.avg_cost),
      }),
    0,
  );

  const safeInvested = Math.max(0, invested);
  return {
    totalValue: cash + safeInvested,
    cash,
    invested: safeInvested,
    source: "fallback_native",
  };
}
