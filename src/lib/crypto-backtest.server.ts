// Historical replay backtest for the crypto sleeve.
//
// Replays daily closes for the six Saxo-tradable crypto ETPs and runs the
// same playbook decision resolver used live (open / hold / trim / exit),
// under a derived crypto regime bucket, at a chosen sleeve cap. Returns
// equity curve, drawdown curve, per-symbol contribution and headline risk
// / return stats.
//
// Pure engine — no I/O — so it can be unit-tested and re-used from either
// a server function (real Yahoo/Postgres data) or a synthetic test fixture.

import { sma, rsi, dailyVolatility, type Candle } from "./market-data.server";
import {
  cryptoSleeveCapPct,
  bucketRegime,
  type CryptoRegimeBucket,
  type CryptoAction,
} from "./crypto-strategy.server";
import { classifyCryptoSymbol, type CryptoGroup } from "./crypto-groups";
import type { RegimeLabel } from "./regime-detector.server";
import type { Database } from "@/integrations/supabase/types";

type RiskLevel = Database["public"]["Enums"]["risk_level"];

export type CryptoBacktestSymbol = {
  symbol: string;
  group: CryptoGroup;
  candles: Candle[]; // ascending by date, ideally warmup + window
};

export type CryptoBacktestOpts = {
  from: string;   // inclusive YYYY-MM-DD
  to: string;     // inclusive
  startingCash: number;
  riskLevel: RiskLevel;
  symbols: CryptoBacktestSymbol[];
  /** Optional annualised risk-free rate for Sharpe (defaults to 0). */
  riskFreeRateAnnual?: number;
  /** Legacy: combined per-side trading cost in bps (defaults to 20 = 0.20%).
   *  If set, overrides feeBps + slippageBps. */
  costBps?: number;
  /** Broker/exchange fee per side in bps (default 10 = 0.10%). */
  feeBps?: number;
  /** Slippage vs mid per side in bps (default 10 = 0.10%). */
  slippageBps?: number;
};



export type CryptoBacktestPoint = {
  date: string;
  regime: CryptoRegimeBucket;
  equity: number;
  drawdown: number; // 0..1 (positive number)
  crypto_mv: number;
  cash: number;
  sleeve_pct: number;
};

export type CryptoSymbolContribution = {
  symbol: string;
  group: CryptoGroup;
  finalMv: number;
  realisedPnl: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  contributionPct: number; // fraction of total equity delta attributable to this symbol
};

export type CryptoBenchmarkPoint = { date: string; equity: number };

export type CryptoBenchmarkReport = {
  label: string;              // "Sleeve", "BTC buy & hold", "ETH buy & hold", "Cash"
  symbol: string | null;      // null for cash
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volatilityPctAnnual: number;
  equityCurve: CryptoBenchmarkPoint[];
};

export type CryptoBacktestReport = {
  from: string;
  to: string;
  daysReplayed: number;
  startingCash: number;
  finalEquity: number;
  totalReturnPct: number;      // (final/start) - 1
  cagrPct: number;             // annualised
  maxDrawdownPct: number;      // positive
  sharpe: number;              // ann.
  volatilityPctAnnual: number; // ann. stdev of daily returns
  winRate: number;             // closed-trade win rate
  trades: number;
  bucketDayCount: Record<CryptoRegimeBucket, number>;
  bySymbol: CryptoSymbolContribution[];
  equityCurve: CryptoBacktestPoint[];
  /** Same-window, same-starting-cash benchmarks so users can gauge whether
   *  the playbook actually adds value over the two obvious passive
   *  alternatives plus a do-nothing cash baseline. */
  benchmarks: CryptoBenchmarkReport[];
};


// --- Regime derivation ------------------------------------------------------

/**
 * Crypto-specific regime label from a BTC proxy price history. Chosen so the
 * backtest can run standalone without a full SPY/VIX macro feed. Cheap,
 * transparent, and monotone in the two things that matter for the sleeve:
 * trend break vs the 200d SMA and drawdown from the 90d peak.
 */
export function deriveCryptoRegimeFromBtc(btcCloses: number[]): RegimeLabel {
  if (btcCloses.length < 50) return "correction";
  const price = btcCloses[btcCloses.length - 1];
  const s50 = sma(btcCloses, 50);
  const s200 = sma(btcCloses, 200);
  const lookback = btcCloses.slice(-90);
  const peak = Math.max(...lookback);
  const dd = peak > 0 ? (price - peak) / peak : 0; // <= 0

  const trendUp = s50 != null && s200 != null && price > s50 && s50 > s200;
  const trendDown = s200 != null && price < s200;

  if (trendDown && dd <= -0.25) return "crisis";
  if (trendDown && dd <= -0.15) return "bear";
  if (trendUp && dd >= -0.05) return "bull_quiet";
  if (trendUp) return "bull_volatile";
  if (dd <= -0.10) return "correction";
  return "recovery";
}

// --- Signal helpers (self-contained; do not touch the DB) -------------------

function belowSma50Streak(closes: number[], smaPeriod = 50): number {
  if (closes.length < smaPeriod + 1) return 0;
  let streak = 0;
  for (let i = closes.length - 1; i >= smaPeriod - 1; i--) {
    const window = closes.slice(i - smaPeriod + 1, i + 1);
    const m = sma(window, smaPeriod);
    if (m == null || closes[i] >= m) break;
    streak += 1;
    if (streak >= 10) break;
  }
  return streak;
}

function pctChangeArr(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  if (!then) return null;
  return (now - then) / then;
}

// Mirrors the live resolver in crypto-strategy.server.ts:computeCryptoSymbolSignal
// but takes a raw closes[] slice so the backtest can drive it deterministically.
function decideAction(
  closes: number[],
  bucket: CryptoRegimeBucket,
): { action: CryptoAction; size: number } {
  const price = closes.length ? closes[closes.length - 1] : null;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes, 14);
  const ret60 = pctChangeArr(closes, 60);
  const trendUp = price != null && s50 != null && s200 != null && price > s50 && s50 > s200;
  const parabolic = ret60 != null && ret60 > 0.5;
  const regimeVeto = bucket === "risk_off";
  const c1 = trendUp && r14 != null && r14 >= 45 && r14 <= 70;
  const c2 = !regimeVeto;
  const c3 = bucket === "risk_on" && (ret60 ?? 0) > 0;
  const c4 = bucket === "risk_on" && (ret60 ?? 0) > 0;
  const gates = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0);
  const streak = belowSma50Streak(closes, 50);

  if (regimeVeto) return { action: "exit", size: 0 };
  if (price != null && s200 != null && price < s200) return { action: "exit", size: 0 };
  if (streak >= 2) return { action: "trim", size: 0.5 };
  if (parabolic) return { action: "trim", size: 0.6 };
  if (bucket === "caution") return { action: "hold", size: 0.4 };
  if (gates >= 2 && c1 && c2) {
    const size = gates >= 4 ? 0.66 : gates === 3 ? 0.5 : 0.33;
    return { action: "open", size };
  }
  return { action: "hold", size: 0.33 };
}

function regimeSleeveMultiplier(bucket: CryptoRegimeBucket): number {
  switch (bucket) {
    case "risk_on":  return 1.00;
    case "caution":  return 0.40;
    case "risk_off": return 0.00;
  }
}

// --- Backtest engine --------------------------------------------------------

/**
 * Simple per-symbol book: units held and running average cost (VWAP-lite),
 * used to attribute realised PnL on trims/exits without a full lot ledger.
 */
type Book = { units: number; avgCost: number; realised: number; trades: number; wins: number; losses: number };

export function runCryptoPlaybookBacktest(opts: CryptoBacktestOpts): CryptoBacktestReport {
  const cap = cryptoSleeveCapPct(opts.riskLevel);
  // Unified execution cost model applied identically to strategy trades AND
  // benchmarks. Legacy `costBps` still wins if callers set it; otherwise the
  // per-side cost is fee + slippage in bps.
  const feeBps = opts.feeBps ?? 10;
  const slipBps = opts.slippageBps ?? 10;
  const totalBps = opts.costBps ?? (feeBps + slipBps);
  const cost = totalBps / 10_000;
  const rf = opts.riskFreeRateAnnual ?? 0;


  // Symbol index by date for O(1) close lookups.
  const closesBySymbol = new Map<string, { dates: string[]; closes: number[]; index: Map<string, number> }>();
  for (const s of opts.symbols) {
    const dates: string[] = [];
    const closes: number[] = [];
    const index = new Map<string, number>();
    for (const c of s.candles) {
      const p = Number(c.close);
      if (!Number.isFinite(p) || p <= 0) continue;
      dates.push(c.date);
      closes.push(p);
      index.set(c.date, dates.length - 1);
    }
    closesBySymbol.set(s.symbol, { dates, closes, index });
  }

  // BTC proxy for regime derivation: first BTC-group symbol we find.
  const btcRef = opts.symbols.find((s) => s.group === "BTC") ?? opts.symbols[0];
  const btcSeries = btcRef ? closesBySymbol.get(btcRef.symbol) : null;

  // Union of trading days.
  const dateSet = new Set<string>();
  for (const s of opts.symbols) {
    for (const c of s.candles) {
      if (c.date >= opts.from && c.date <= opts.to) dateSet.add(c.date);
    }
  }
  const days = Array.from(dateSet).sort();

  const books = new Map<string, Book>();
  for (const s of opts.symbols) {
    books.set(s.symbol, { units: 0, avgCost: 0, realised: 0, trades: 0, wins: 0, losses: 0 });
  }

  let cash = opts.startingCash;
  const bucketDayCount: Record<CryptoRegimeBucket, number> = { risk_on: 0, caution: 0, risk_off: 0 };
  const equityCurve: CryptoBacktestPoint[] = [];
  let peakEquity = opts.startingCash;
  let maxDd = 0;
  const dailyReturns: number[] = [];
  let prevEquity = opts.startingCash;

  const perSymbolCap = cap / Math.max(1, opts.symbols.length);

  for (const day of days) {
    // Regime for the day, computed on closes strictly <= day.
    let bucket: CryptoRegimeBucket = "caution";
    if (btcSeries) {
      const idx = btcSeries.index.get(day);
      if (idx != null) {
        const window = btcSeries.closes.slice(0, idx + 1);
        const label = deriveCryptoRegimeFromBtc(window);
        bucket = bucketRegime(label);
      }
    }
    bucketDayCount[bucket]++;

    const sleeveTarget = cap * regimeSleeveMultiplier(bucket);

    // Mark-to-market first so we can compute a valid NAV for sizing.
    const priceByDay = new Map<string, number>();
    let cryptoMv = 0;
    for (const s of opts.symbols) {
      const series = closesBySymbol.get(s.symbol)!;
      const idx = series.index.get(day);
      const price = idx != null ? series.closes[idx] : null;
      if (price != null) priceByDay.set(s.symbol, price);
      const b = books.get(s.symbol)!;
      if (price != null && b.units > 0) cryptoMv += b.units * price;
    }
    const nav = cash + cryptoMv;

    // Per-symbol decisions in a stable order (symbols as configured).
    for (const s of opts.symbols) {
      const series = closesBySymbol.get(s.symbol)!;
      const idx = series.index.get(day);
      if (idx == null || idx < 50) continue; // warmup
      const closes = series.closes.slice(0, idx + 1);
      const price = closes[closes.length - 1];
      const decision = decideAction(closes, bucket);
      const book = books.get(s.symbol)!;

      // Per-symbol dollar cap tied to sleeve target so total sleeve exposure
      // stays under `sleeveTarget` by construction.
      const dollarCap = nav * Math.min(perSymbolCap, sleeveTarget) * decision.size;

      if (decision.action === "exit" && book.units > 0) {
        const proceeds = book.units * price * (1 - cost);
        const costBasis = book.units * book.avgCost;
        const pnl = proceeds - costBasis;
        book.realised += pnl;
        book.trades++;
        if (pnl >= 0) book.wins++; else book.losses++;
        cash += proceeds;
        book.units = 0;
        book.avgCost = 0;
      } else if (decision.action === "trim" && book.units > 0) {
        const sellUnits = book.units * decision.size;
        const proceeds = sellUnits * price * (1 - cost);
        const costBasis = sellUnits * book.avgCost;
        const pnl = proceeds - costBasis;
        book.realised += pnl;
        book.trades++;
        if (pnl >= 0) book.wins++; else book.losses++;
        cash += proceeds;
        book.units -= sellUnits;
        if (book.units < 1e-9) { book.units = 0; book.avgCost = 0; }
      } else if (decision.action === "open") {
        const currentMv = book.units * price;
        const room = Math.max(0, dollarCap - currentMv);
        const spend = Math.min(room, Math.max(0, cash));
        if (spend > 0) {
          const units = (spend * (1 - cost)) / price;
          const newUnits = book.units + units;
          book.avgCost = newUnits > 0
            ? (book.units * book.avgCost + units * price) / newUnits
            : 0;
          book.units = newUnits;
          cash -= spend;
        }
      }
      // hold: do nothing
    }

    // Recompute end-of-day MV & equity for the point.
    let mvEod = 0;
    for (const s of opts.symbols) {
      const price = priceByDay.get(s.symbol);
      const b = books.get(s.symbol)!;
      if (price != null && b.units > 0) mvEod += b.units * price;
    }
    const equity = cash + mvEod;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDd) maxDd = dd;
    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;

    equityCurve.push({
      date: day,
      regime: bucket,
      equity,
      drawdown: dd,
      crypto_mv: mvEod,
      cash,
      sleeve_pct: equity > 0 ? mvEod / equity : 0,
    });
  }

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : opts.startingCash;
  const totalReturn = opts.startingCash > 0 ? finalEquity / opts.startingCash - 1 : 0;
  // CAGR is only meaningful over a sufficient window. Annualising a handful
  // of trading days compounds tiny per-day moves into absurd figures (e.g.
  // +2% on day 1 → ~1270× annualised). Below ~30 trading days we report the
  // total return unannualised; above that we use actual elapsed calendar
  // days rather than a 252-day proxy so weekends don't inflate the exponent.
  const MIN_TRADING_DAYS_FOR_CAGR = 30;
  const firstTs = equityCurve.length ? Date.parse(equityCurve[0].date) : 0;
  const lastTs = equityCurve.length ? Date.parse(equityCurve[equityCurve.length - 1].date) : 0;
  const elapsedYears = lastTs > firstTs ? (lastTs - firstTs) / (365.25 * 24 * 60 * 60 * 1000) : 0;
  const cagr =
    opts.startingCash > 0 && equityCurve.length >= MIN_TRADING_DAYS_FOR_CAGR && elapsedYears > 0
      ? Math.pow(finalEquity / opts.startingCash, 1 / elapsedYears) - 1
      : totalReturn;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / Math.max(1, dailyReturns.length);
  const varr = dailyReturns.length > 1
    ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const stdev = Math.sqrt(varr);
  const annVol = stdev * Math.sqrt(252);
  const dailyRf = rf / 252;
  const sharpe = stdev > 0 ? ((mean - dailyRf) / stdev) * Math.sqrt(252) : 0;

  // Volatility helper is exercised for parity with the live path (harmless).
  dailyVolatility(dailyReturns.slice(-20), 20);

  const totalTrades = Array.from(books.values()).reduce((s, b) => s + b.trades, 0);
  const totalWins = Array.from(books.values()).reduce((s, b) => s + b.wins, 0);
  const totalRealised = Array.from(books.values()).reduce((s, b) => s + b.realised, 0);

  // Attribute contribution per symbol as (finalMv - startCost + realised) share.
  const equityDelta = finalEquity - opts.startingCash;
  const bySymbol: CryptoSymbolContribution[] = opts.symbols.map((s) => {
    const b = books.get(s.symbol)!;
    const price = closesBySymbol.get(s.symbol)?.closes.slice(-1)[0] ?? 0;
    const finalMv = b.units * price;
    const openPnl = b.units > 0 ? (price - b.avgCost) * b.units : 0;
    const symbolContribution = b.realised + openPnl;
    const contributionPct = equityDelta !== 0 ? symbolContribution / equityDelta : 0;
    return {
      symbol: s.symbol,
      group: s.group,
      finalMv,
      realisedPnl: b.realised,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      winRate: b.trades > 0 ? b.wins / b.trades : 0,
      contributionPct,
    };
  });

  // ---- Benchmarks (same window, same starting cash) ----
  const benchmarks: CryptoBenchmarkReport[] = [];
  const sleeveCurve: CryptoBenchmarkPoint[] = equityCurve.map((p) => ({ date: p.date, equity: p.equity }));
  benchmarks.push(summariseBenchmarkCurve(`Sleeve (${opts.riskLevel})`, null, sleeveCurve, opts.startingCash, rf));

  const btcHold = opts.symbols.find((s) => s.group === "BTC");
  if (btcHold) {
    benchmarks.push(
      summariseBenchmarkCurve("BTC buy & hold", btcHold.symbol, buildBuyHoldCurve(days, closesBySymbol.get(btcHold.symbol), opts.startingCash, cost), opts.startingCash, rf),
    );
  }
  const ethHold = opts.symbols.find((s) => s.group === "ETH");
  if (ethHold) {
    benchmarks.push(
      summariseBenchmarkCurve("ETH buy & hold", ethHold.symbol, buildBuyHoldCurve(days, closesBySymbol.get(ethHold.symbol), opts.startingCash, cost), opts.startingCash, rf),
    );
  }
  // Cash baseline: risk-free compounded daily.
  benchmarks.push(
    summariseBenchmarkCurve(
      rf > 0 ? `Cash @ ${(rf * 100).toFixed(1)}%` : "Cash (flat)",
      null,
      buildCashCurve(days, opts.startingCash, rf),
      opts.startingCash,
      rf,
    ),
  );

  return {
    from: opts.from,
    to: opts.to,
    daysReplayed: equityCurve.length,
    startingCash: opts.startingCash,
    finalEquity,
    totalReturnPct: totalReturn,
    cagrPct: cagr,
    maxDrawdownPct: maxDd,
    sharpe,
    volatilityPctAnnual: annVol,
    winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
    trades: totalTrades,
    bucketDayCount,
    bySymbol,
    equityCurve,
    benchmarks,
  };
}

function buildBuyHoldCurve(
  days: string[],
  series: { dates: string[]; closes: number[]; index: Map<string, number> } | undefined,
  startingCash: number,
  costPerSide: number,
): CryptoBenchmarkPoint[] {
  const out: CryptoBenchmarkPoint[] = [];
  if (!series || days.length === 0) return out;
  // Entry: pay fee + slippage on the buy side (same combined per-side cost as
  // the strategy). Model slippage by lifting the fill price above the close,
  // matching how the strategy's `open` branch also pays `cost` on entry.
  let entryPrice = 0;
  for (const d of days) {
    const idx = series.index.get(d);
    if (idx != null) { entryPrice = series.closes[idx]; break; }
  }
  if (!(entryPrice > 0)) {
    return days.map((d) => ({ date: d, equity: startingCash }));
  }
  const effectiveEntry = entryPrice * (1 + costPerSide);
  const units = startingCash / effectiveEntry;
  let lastPrice = entryPrice;
  for (const d of days) {
    const idx = series.index.get(d);
    if (idx != null) lastPrice = series.closes[idx];
    // Report mark-to-market at the close (raw price), same convention the
    // strategy uses for open positions in `equityCurve`. Exit-side cost is
    // only realised on liquidation, which for buy & hold never happens.
    out.push({ date: d, equity: units * lastPrice });
  }
  return out;
}


function buildCashCurve(days: string[], startingCash: number, rfAnnual: number): CryptoBenchmarkPoint[] {
  const daily = rfAnnual > 0 ? Math.pow(1 + rfAnnual, 1 / 252) - 1 : 0;
  const out: CryptoBenchmarkPoint[] = [];
  let equity = startingCash;
  for (const d of days) {
    equity = equity * (1 + daily);
    out.push({ date: d, equity });
  }
  return out;
}

function summariseBenchmarkCurve(
  label: string,
  symbol: string | null,
  curve: CryptoBenchmarkPoint[],
  startingCash: number,
  rfAnnual: number,
): CryptoBenchmarkReport {
  const final = curve.length ? curve[curve.length - 1].equity : startingCash;
  const totalReturn = startingCash > 0 ? final / startingCash - 1 : 0;
  const MIN_TRADING_DAYS_FOR_CAGR = 30;
  const firstTs = curve.length ? Date.parse(curve[0].date) : 0;
  const lastTs = curve.length ? Date.parse(curve[curve.length - 1].date) : 0;
  const elapsedYears = lastTs > firstTs ? (lastTs - firstTs) / (365.25 * 24 * 60 * 60 * 1000) : 0;
  const cagr =
    startingCash > 0 && curve.length >= MIN_TRADING_DAYS_FOR_CAGR && elapsedYears > 0
      ? Math.pow(final / startingCash, 1 / elapsedYears) - 1
      : totalReturn;
  let peak = startingCash;
  let maxDd = 0;
  const rets: number[] = [];
  let prev = startingCash;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    if (prev > 0) rets.push((p.equity - prev) / prev);
    prev = p.equity;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const varr = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
  const stdev = Math.sqrt(varr);
  const annVol = stdev * Math.sqrt(252);
  const dailyRf = rfAnnual / 252;
  const sharpe = stdev > 0 ? ((mean - dailyRf) / stdev) * Math.sqrt(252) : 0;
  return {
    label,
    symbol,
    finalEquity: final,
    totalReturnPct: totalReturn,
    cagrPct: cagr,
    maxDrawdownPct: maxDd,
    sharpe,
    volatilityPctAnnual: annVol,
    equityCurve: curve,
  };
}


// -- Convenience: the six approved crypto ETPs mapped to their groups.
export const CRYPTO_BACKTEST_SYMBOLS: Array<{ symbol: string; group: CryptoGroup }> = [
  { symbol: "BTCE.DE", group: "BTC" },
  { symbol: "ABTC.SW", group: "BTC" },
  { symbol: "BTCW.L",  group: "BTC" },
  { symbol: "ZETH.SW", group: "ETH" },
  { symbol: "ZETH.DE", group: "ETH" },
  { symbol: "HODL.SW", group: "Basket" },
];

// Belt-and-braces: keep in sync with CRYPTO_SYMBOLS.
for (const s of CRYPTO_BACKTEST_SYMBOLS) {
  if (!classifyCryptoSymbol(s.symbol)) {
    throw new Error(`CRYPTO_BACKTEST_SYMBOLS: ${s.symbol} missing from CRYPTO_SYMBOL_MAP`);
  }
}

// Guard against realised PnL contribution going astray from equity delta,
// used by tests.
export function _sumContribution(r: CryptoBacktestReport): number {
  return r.bySymbol.reduce((a, s) => a + s.contributionPct, 0);
}
