// Valuing FX spot legs (e.g. a short GBPUSD funding leg left on the account).
//
// BUG THIS EXISTS TO PREVENT: the broker reports FX spot conversions as net
// positions, so `holdings` can contain a row like `GBPUSD qty -1233.52`. Every
// other holding is worth `quantity x price`, but an FX spot leg is NOT: the
// currency it bought is already sitting in the cash wallet, so counting the
// leg's notional as well double-counts it. On 24 Aug 2026 a stranded GBPUSD
// leg knocked GBP 1.68k off a GBP 9.9k live account, which read as a −17%
// daily loss and a 20% drawdown and hard-halted every buy for days, while the
// broker's own NAV was flat.
//
// The economically correct contribution of an open FX spot leg is its
// unrealised P&L: quantity x (current rate − entry rate), expressed in the
// quote currency of the pair.

export function isFxLegHolding(h: { asset_class?: string | null }): boolean {
  return String(h?.asset_class ?? "").toLowerCase() === "fx";
}

/**
 * Native-currency value of a holding line.
 * FX spot legs contribute unrealised P&L only; everything else is qty x price.
 */
export function holdingNativeValue(args: {
  assetClass?: string | null;
  quantity: number;
  price: number;
  avgCost?: number | null;
}): number {
  const qty = Number(args.quantity);
  const px = Number(args.price);
  if (!Number.isFinite(qty) || !Number.isFinite(px)) return 0;
  if (!isFxLegHolding({ asset_class: args.assetClass })) return qty * px;
  const cost = Number(args.avgCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0; // no entry rate -> no P&L claim
  return qty * (px - cost);
}
