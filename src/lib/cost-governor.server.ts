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
import { engineSymbolKey } from "./price-symbol";
import { CHURN_WINDOW_DAYS } from "./cost-governor";

export type GovernorInputs = {
  navBase: number;
  trailingCostBase: number;
  buysAlreadyToday: number;
  lastBuyDaysAgo: Record<string, number>;
  windowDays: number;
  /** Current gross exposure per sector key (base currency), for concentration budgeting. */
  sectorExposureBase: Record<string, number>;
  /**
   * Current gross exposure per symbol (base currency), keyed by
   * `engineSymbolKey` so broker-native holdings ("MKS:xlon") match order
   * symbols ("MKS.L"). Feeds the single-name concentration cap.
   */
  positionExposureBase: Record<string, number>;
  /** Symbols currently held (upper-cased), so adds can be told apart from new entries. */
  heldSymbols: Set<string>;
  /** Days since the last BUY filled anywhere in the book (windowDays if none). */
  daysSinceLastBuyFill: number;
  /** BUY fills in the last `churnWindowDays` — recent trading cadence. */
  recentBuyFills: number;
  /** Lookback used for `recentBuyFills`. */
  churnWindowDays: number;
  /**
   * Realised-volatility z-score of the book's own tape (recent daily equity
   * vol vs its longer baseline). 0 when there is not enough history.
   */
  tapeVolZ: number;
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
  let recentBuyFills = 0;
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

      // Leaky bucket, not a step function. A flat "sum of the last 30 days"
      // means one churn burst (or a forced de-risking sequence, whose SELL
      // costs land here too) blocks every buy until the whole burst falls out
      // of the window at once — a live account sat on cash for eleven trading
      // days that way. Weighting each fill by how much of the window it has
      // left refills headroom continuously as the burst ages.
      const t = Date.parse(filledAt);
      const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 0;
      const weight = Math.max(0, Math.min(1, 1 - ageDays / windowDays));
      trailingCostBase += (await toBase(oneWay, ccy)) * weight;

      if (side === "buy") {
        if (filledAt && ukDayKey(filledAt) === today) buysAlreadyToday += 1;
        if (Number.isFinite(t) && ageDays <= CHURN_WINDOW_DAYS) recentBuyFills += 1;
        if (Number.isFinite(t)) {
          const days = Math.floor((now - t) / 86_400_000);
          const key = engineSymbolKey(symbol);
          const prev = lastBuyDaysAgo[key];
          if (prev === undefined || days < prev) lastBuyDaysAgo[key] = days;
        }
      }

    }

  } catch {
    /* degrade to no memory */
  }

  // Sector exposure of the *existing* book, valued at cost when no live price
  // is to hand. Cost basis understates winners slightly, which is the safe
  // direction for a concentration cap (it never over-admits by much).
  const sectorExposureBase: Record<string, number> = {};
  const positionExposureBase: Record<string, number> = {};
  const heldSymbols = new Set<string>();
  try {
    const { symbolSector } = await import("./sector-rotation.server");
    const holdings = await args.supabaseAdmin
      .from("holdings")
      .select("symbol, quantity, avg_cost, instrument_ccy")
      .eq("portfolio_id", args.portfolioId)
      .gt("quantity", 0);
    for (const h of (holdings?.data ?? []) as Array<Record<string, unknown>>) {
      const symbol = String(h["symbol"] ?? "").toUpperCase();
      const qty = Number(h["quantity"] ?? 0);
      const cost = Number(h["avg_cost"] ?? 0);
      if (!symbol || !(qty > 0) || !(cost > 0)) continue;
      heldSymbols.add(symbol);
      const ccy = String(h["instrument_ccy"] ?? base).toUpperCase();
      const value = await toBase(qty * cost, ccy);
      const key = symbolSector(symbol) ?? "__unknown__";
      sectorExposureBase[key] = (sectorExposureBase[key] ?? 0) + Math.max(0, value);
      const symKey = engineSymbolKey(symbol);
      positionExposureBase[symKey] = (positionExposureBase[symKey] ?? 0) + Math.max(0, value);
    }
  } catch {
    /* concentration budget degrades to "no existing exposure" */
  }

  // Realised-volatility z of the book's own tape. Recent daily equity return
  // vol against its longer baseline: a cheap, always-available read on how
  // violent the tape the portfolio actually trades is.
  const tapeVolZ = await loadTapeVolZ(args.supabaseAdmin, args.portfolioId);

  return {
    navBase,
    recentBuyFills,
    churnWindowDays: CHURN_WINDOW_DAYS,
    tapeVolZ,
    trailingCostBase,
    buysAlreadyToday,
    lastBuyDaysAgo,
    windowDays,
    daysSinceLastBuyFill: Object.values(lastBuyDaysAgo).length
      ? Math.min(...Object.values(lastBuyDaysAgo))
      : windowDays,
    sectorExposureBase,
    positionExposureBase,
    heldSymbols,
  };


}

const VOL_RECENT_DAYS = 10;
const VOL_BASELINE_DAYS = 60;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}

/**
 * Realised-vol z-score of the portfolio's daily equity returns: how far the
 * last ~two weeks' volatility sits above its own multi-month distribution.
 * Returns 0 (i.e. "normal tape") whenever there is too little history.
 */
export async function loadTapeVolZ(
  supabaseAdmin: { from: (t: string) => any },
  portfolioId: string,
): Promise<number> {
  try {
    const res = await supabaseAdmin
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(VOL_BASELINE_DAYS + VOL_RECENT_DAYS + 2);
    const rows = ((res?.data ?? []) as Array<Record<string, unknown>>)
      .map((r) => Number(r["total_value"] ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reverse();
    if (rows.length < VOL_RECENT_DAYS + 20) return 0;
    const rets: number[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (prev > 0) rets.push(cur / prev - 1);
    }
    if (rets.length < VOL_RECENT_DAYS + 19) return 0;
    const recent = stdev(rets.slice(-VOL_RECENT_DAYS));
    // Rolling window of past realised vols, so the z-score is against the
    // book's own distribution rather than an arbitrary constant.
    const history: number[] = [];
    for (let end = rets.length - VOL_RECENT_DAYS; end >= VOL_RECENT_DAYS; end -= 1) {
      history.push(stdev(rets.slice(end - VOL_RECENT_DAYS, end)));
    }
    if (history.length < 10) return 0;
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const sd = stdev(history);
    if (!(sd > 0)) return 0;
    const z = (recent - mean) / sd;
    return Number.isFinite(z) ? Math.max(0, Math.min(5, z)) : 0;
  } catch {
    return 0;
  }
}
