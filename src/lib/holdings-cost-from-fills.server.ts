// Weighted-average cost basis rebuilt from the broker's OWN executed fills.
//
// `live-holdings-sync.server.ts` used to fall back to the current market price
// when Saxo omitted `AverageOpenPrice` on a net position. That made the
// position look like it had been bought at today's mark, so its unrealised
// P&L showed ~0 while the Saxo account showed the real number. Real fills are
// the correct fallback: replay `live_fills` (already stored in the
// instrument's base currency by `resolveFillRecord`) and use the weighted
// average buy price, including the charged commission, as the cost basis.

import { engineSymbolKey } from "@/lib/price-symbol";

export type FillCostRow = {
  symbol: string;
  side: string | null;
  quantity: number | string | null;
  fill_price: number | string | null;
  fee?: number | string | null;
  filled_at: string | null;
};

/**
 * Replay fills into a per-symbol weighted-average cost, keyed by
 * `engineSymbolKey` so broker-native holdings ("VWRL:xlon") match the fill
 * symbols ("VWRL.L"). Prices are in the instrument's base unit (GBP, not GBX).
 */
export function avgCostFromFills(fills: FillCostRow[]): Map<string, number> {
  const ordered = [...fills].sort((a, b) =>
    String(a.filled_at ?? "").localeCompare(String(b.filled_at ?? "")),
  );
  const pos = new Map<string, { qty: number; cost: number }>();

  for (const f of ordered) {
    const qty = Math.abs(Number(f.quantity ?? 0));
    const price = Number(f.fill_price ?? 0);
    if (!(qty > 0) || !(price > 0)) continue;
    const key = engineSymbolKey(String(f.symbol ?? ""));
    if (!key) continue;
    const side = String(f.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
    const cur = pos.get(key) ?? { qty: 0, cost: 0 };

    if (side === "buy") {
      // Commission is part of what the position actually cost us.
      const fee = Math.abs(Number(f.fee ?? 0));
      cur.cost += qty * price + (Number.isFinite(fee) ? fee : 0);
      cur.qty += qty;
    } else {
      const sold = Math.min(qty, cur.qty);
      const avg = cur.qty > 0 ? cur.cost / cur.qty : 0;
      cur.qty = Math.max(0, cur.qty - sold);
      cur.cost = Math.max(0, cur.cost - sold * avg);
      if (cur.qty <= 1e-9) { cur.qty = 0; cur.cost = 0; }
    }
    pos.set(key, cur);
  }

  const out = new Map<string, number>();
  for (const [key, p] of pos) {
    if (p.qty > 0 && p.cost > 0) out.set(key, p.cost / p.qty);
  }
  return out;
}

/** Load a portfolio's fills and derive per-symbol average cost (base units). */
export async function loadAvgCostFromFills(
  db: {
    from: (t: "live_fills") => {
      select: (cols: string) => {
        eq: (c: string, v: string) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown }>;
        };
      };
    };
  },
  portfolioId: string,
): Promise<Map<string, number>> {
  try {
    const res = await db
      .from("live_fills")
      .select("symbol, side, quantity, fill_price, fee, filled_at")
      .eq("portfolio_id", portfolioId)
      .order("filled_at", { ascending: true });
    const rows = (res.data ?? []) as FillCostRow[];
    return avgCostFromFills(rows);
  } catch {
    return new Map();
  }
}
