// "What moved today" — reconciles the headline day change on the equity tile
// with the per-position moves people can see in their holdings list.
//
// WHY THIS EXISTS: on 3 Sep 2026 the live account showed −£7 for the day while
// every stock line was up. The missing pieces were (a) an open short GBPUSD
// funding leg, which is not rendered as a position and moves with the rate,
// and (b) the commission/spread paid on that morning's buy. Both are real
// money; neither was visible. This module lays out the day change as an
// additive list so the arithmetic is checkable by eye.
//
// Contract: every line's `changeBase` is expressed in the portfolio's base
// currency and the following identity always holds
//
//   totalChange = positionsTotal - fees + netFlow + residual
//
// `residual` is whatever the priced lines cannot explain (unpriced symbols,
// broker fees not yet reported, FX on cash balances, intraday snapshot
// timing). Showing it is deliberate: a large residual is a data-quality
// signal, not something to hide.

export type MoverInput = {
  symbol: string;
  assetClass: string | null;
  quantity: number;
  /** Price at the previous snapshot, in major units. Null when unknown. */
  prevPrice: number | null;
  /** Latest price, in major units. Null when unknown. */
  currPrice: number | null;
  /** Instrument quote currency (major units). */
  currency: string;
  /** Rate converting `currency` into the base currency; null = unavailable. */
  fxRate: number | null;
  /** Opened during the current day — prevPrice is the entry price. */
  openedToday: boolean;
};

export type MoverLine = {
  symbol: string;
  assetClass: string | null;
  kind: "position" | "fx";
  quantity: number;
  prevPrice: number | null;
  currPrice: number | null;
  currency: string;
  changeNative: number;
  changeBase: number;
  changePct: number | null;
  openedToday: boolean;
  /** False when the line could not be priced on both ends. */
  priced: boolean;
};

export type DayAttribution = {
  lines: MoverLine[];
  /** Sum of priced line moves, in base currency. */
  positionsTotal: number;
  /** Trading costs paid today (positive number = money out). */
  fees: number;
  /** External deposits (+) / withdrawals (−) inside the window. */
  netFlow: number;
  /** Equity change from the previous snapshot to now. */
  totalChange: number;
  /** Unexplained remainder; see module header. */
  residual: number;
  /** Count of holdings that could not be priced on both ends. */
  unpricedCount: number;
};

function fin(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

export function buildDayAttribution(args: {
  inputs: MoverInput[];
  fees: number;
  netFlow: number;
  totalChange: number;
}): DayAttribution {
  const lines: MoverLine[] = (args.inputs ?? []).map((i) => {
    const qty = fin(i.quantity);
    const prev = i.prevPrice == null ? null : Number(i.prevPrice);
    const curr = i.currPrice == null ? null : Number(i.currPrice);
    const priced =
      prev != null && curr != null && Number.isFinite(prev) && Number.isFinite(curr);
    // An FX spot leg contributes unrealised P&L only, but its *change* over a
    // day is the same qty x (curr - prev) as any other line, because the entry
    // rate cancels. So one formula covers both kinds.
    const changeNative = priced ? qty * (curr! - prev!) : 0;
    const rate = i.fxRate == null || !Number.isFinite(Number(i.fxRate)) ? 1 : Number(i.fxRate);
    return {
      symbol: i.symbol,
      assetClass: i.assetClass,
      kind: String(i.assetClass ?? "").toLowerCase() === "fx" ? "fx" : "position",
      quantity: qty,
      prevPrice: prev,
      currPrice: curr,
      currency: (i.currency || "").toUpperCase(),
      changeNative,
      changeBase: changeNative * rate,
      changePct: priced && prev !== 0 ? ((curr! - prev!) / Math.abs(prev!)) * 100 : null,
      openedToday: Boolean(i.openedToday),
      priced,
    };
  });

  lines.sort((a, b) => Math.abs(b.changeBase) - Math.abs(a.changeBase));

  const positionsTotal = lines.reduce((s, l) => s + l.changeBase, 0);
  const fees = fin(args.fees);
  const netFlow = fin(args.netFlow);
  const totalChange = fin(args.totalChange);

  return {
    lines,
    positionsTotal,
    fees,
    netFlow,
    totalChange,
    residual: totalChange - positionsTotal + fees - netFlow,
    unpricedCount: lines.filter((l) => !l.priced).length,
  };
}
