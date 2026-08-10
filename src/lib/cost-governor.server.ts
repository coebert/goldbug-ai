// Server-side inputs for the portfolio cost governor.
//
// Reads the three pieces of portfolio memory the pure governor needs:
//   * NAV                — latest equity snapshot (falls back to cash + holdings)
//   * trailing friction  — estimated round-trip cost of every fill in the
//                          trailing window, reconstructed from `live_fills`
//                          (the `fee` column is unreliable: Saxo often returns
//                          no commission on the fill payload, so we model it)
//   * churn state        — days since the last BUY per symbol, and how many
//                          BUY tickets were already routed today (UK time)
//
// Everything is best-effort: a failed read must never block trading, it just
// degrades the governor to "no memory" for that tick.

import { estimateTradeCosts } from "./trade-viability-gate";
import { convertAmount } from "./fx.server";
import { ukDayKey } from "./uk-time";

export type GovernorInputs = {
  navBase: number;
  trailingCostBase: number;
  buysAlreadyToday: number;
  lastBuyDaysAgo: Record<string, number>;
  windowDays: number;
};

const WINDOW_DAYS = 30;

/** Cache FX conversions per tick so a 40-fill window makes at most a few calls. */
async function makeConverter(baseCcy: string) {
  const cache = new Map<string, number>();
  return async (amount: number, ccy: string): Promise<number> => {
    const from = (ccy || baseCcy).toUpperCase();
    if (!Number.isFinite(amount) || amount === 0) return 0;
    if (from === baseCcy) return amount;
    let rate = cache.get(from);
    if (rate === undefined) {
      try {
        const res = await convertAmount(1, from, baseCcy);
        rate = Number.isFinite(res.amount) && res.amount > 0 ? res.amount : 1;
      } catch {
        rate = 1;
      }
      cache.set(from, rate);
    }
    return amount * rate;
  };
}

export async function loadGovernorInputs(args: {
  supabaseAdmin: {
    from: (t: string) => any;
  };
  portfolioId: string;
  baseCcy: string;
  windowDays?: number;
}): Promise<GovernorInputs> {
  const windowDays = args.windowDays ?? WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const base = (args.baseCcy || "GBP").toUpperCase();
  const toBase = await makeConverter(base);

  let navBase = 0;
  try {
    const snap = await args.supabaseAdmin
      .from("equity_snapshots")
      .select("total_value")
      .eq("portfolio_id", args.portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    navBase = Number(snap?.data?.total_value ?? 0) || 0;
  } catch {
    navBase = 0;
  }

  let trailingCostBase = 0;
  let buysAlreadyToday = 0;
  const lastBuyDaysAgo: Record<string, number> = {};

  try {
    const fills = await args.supabaseAdmin
      .from("live_fills")
      .select("symbol, side, quantity, fill_price, fee, currency, filled_at")
      .eq("portfolio_id", args.portfolioId)
      .gte("filled_at", since)
      .order("filled_at", { ascending: false })
      .limit(1000);

    const today = ukDayKey(new Date());
    const now = Date.now();

    for (const f of (fills?.data ?? []) as Array<Record<string, unknown>>) {
      const symbol = String(f["symbol"] ?? "");
      const side = String(f["side"] ?? "") === "sell" ? "sell" : "buy";
      const quantity = Number(f["quantity"] ?? 0);
      const price = Number(f["fill_price"] ?? 0);
      const ccy = String(f["currency"] ?? base).toUpperCase();
      const filledAt = String(f["filled_at"] ?? "");
      if (!symbol || !(quantity > 0) || !(price > 0)) continue;

      // Model the friction rather than trusting `fee` — broker payloads
      // routinely omit commission, which is exactly how a 2%-of-NAV cost
      // bill became invisible.
      const costs = estimateTradeCosts({ symbol, side, quantity, price });
      const modelled = costs.oneWayCost;
      const reported = Number(f["fee"] ?? 0);
      const oneWay = Math.max(modelled, Number.isFinite(reported) ? reported : 0);
      trailingCostBase += await toBase(oneWay, ccy);

      if (side === "buy") {
        if (filledAt && ukDayKey(filledAt) === today) buysAlreadyToday += 1;
        const t = Date.parse(filledAt);
        if (Number.isFinite(t)) {
          const days = Math.floor((now - t) / 86_400_000);
          const prev = lastBuyDaysAgo[symbol];
          if (prev === undefined || days < prev) lastBuyDaysAgo[symbol] = days;
        }
      }
    }
  } catch {
    /* degrade to no memory */
  }

  return { navBase, trailingCostBase, buysAlreadyToday, lastBuyDaysAgo, windowDays };
}
