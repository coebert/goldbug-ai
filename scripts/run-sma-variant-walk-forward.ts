// Walk-forward (rolling) out-of-sample comparison of the three SMA trend
// variants the engine can run:
//
//   sma20        price vs SMA20 only
//   sma20_50     SMA20/SMA50 crossover
//   sma20_50_200 SMA20/50 crossover gated by the SMA50/200 regime filter
//
//   bun run scripts/run-sma-variant-walk-forward.ts
//   bun run scripts/run-sma-variant-walk-forward.ts --train 504 --test 126 --from 2005-01-01
//
// Each fold tunes the two free parameters (separation threshold, confirm bars)
// on the TRAIN window only, freezes them, and scores the following TEST window.
// Only test-window results are aggregated, so the verdict is out-of-sample.
// Costs use the live cost-governor assumptions (commission with a hard floor
// plus spread/slippage), so a variant cannot win on paper by over-trading.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import type { BacktestBar } from "../src/lib/backtest-runner";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "PG", "SPY", "GLD"];

const from = arg("from", "2005-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const priceMode = arg("price-mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const trainDays = Number(arg("train", "504"));
const testDays = Number(arg("test", "126"));
const maxPositions = Number(arg("max-positions", "5"));
const commissionBps = Number(arg("commission-bps", "8"));
const commissionMin = Number(arg("commission-min", "3"));
const slippageBps = Number(arg("slippage-bps", "5"));

const VARIANTS = ["sma20", "sma20_50", "sma20_50_200"] as const;
type Variant = (typeof VARIANTS)[number];

type Params = { separationPct: number; confirmBars: number };
const GRID: Params[] = [];
for (const separationPct of [0, 0.002, 0.005, 0.01]) {
  for (const confirmBars of [1, 2, 3]) GRID.push({ separationPct, confirmBars });
}

// ---------------------------------------------------------------- indicators

function sma(closes: readonly number[], end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let sum = 0;
  for (let i = end - window + 1; i <= end; i++) sum += closes[i]!;
  return sum / window;
}

/** +1 long, 0 flat — the variant's desired state at bar `i` (no look-ahead). */
function desiredState(
  variant: Variant,
  closes: readonly number[],
  i: number,
  p: Params,
): 0 | 1 | null {
  const price = closes[i]!;
  const s20 = sma(closes, i, 20);
  if (s20 == null) return null;

  const sepOk = (a: number, b: number) => Math.abs(a - b) / b >= p.separationPct;
  // The ordering must have persisted for `confirmBars` bars before it counts.
  const persisted = (test: (k: number) => boolean | null) => {
    for (let k = i; k > i - p.confirmBars; k--) {
      if (k < 0) return false;
      if (test(k) !== true) return false;
    }
    return true;
  };

  if (variant === "sma20") {
    const bull = (k: number) => {
      const m = sma(closes, k, 20);
      return m == null ? null : closes[k]! > m && sepOk(closes[k]!, m);
    };
    if (persisted(bull)) return 1;
    return price < s20 ? 0 : null;
  }

  const s50 = sma(closes, i, 50);
  if (s50 == null) return null;

  const fastBull = (k: number) => {
    const a = sma(closes, k, 20);
    const b = sma(closes, k, 50);
    return a == null || b == null ? null : a > b && sepOk(a, b);
  };
  const fastBear = (k: number) => {
    const a = sma(closes, k, 20);
    const b = sma(closes, k, 50);
    return a == null || b == null ? null : a < b;
  };

  if (variant === "sma20_50") {
    if (persisted(fastBull)) return 1;
    if (persisted(fastBear)) return 0;
    return null;
  }

  // sma20_50_200 — the fast cross trades, the regime filter vetoes.
  const s200 = sma(closes, i, 200);
  if (s200 == null) return null; // no regime knowledge yet: stay flat-neutral
  const golden = s50 > s200;
  if (!golden) return 0; // death regime: no longs, exit existing
  if (persisted(fastBull)) return 1;
  if (persisted(fastBear)) return 0;
  return null;
}

// ---------------------------------------------------------------- simulator

type SegmentResult = {
  returnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  trades: number;
  costs: number;
};

function tradeCost(notional: number): number {
  return Math.max(commissionMin, (notional * commissionBps) / 10_000)
    + (notional * slippageBps) / 10_000;
}

/**
 * Long-only equal-weight simulator over a bar slice. `warm` bars before
 * `start` are used for indicator warm-up only (no trading, no P&L).
 */
function simulate(
  variant: Variant,
  bars: readonly BacktestBar[],
  seriesBySymbol: Map<string, number[]>,
  start: number,
  end: number,
  p: Params,
): SegmentResult {
  let cash = startingCash;
  const shares = new Map<string, number>();
  const equityCurve: number[] = [];
  let trades = 0;
  let costs = 0;

  const priceAt = (sym: string, i: number) => seriesBySymbol.get(sym)![i]!;

  for (let i = start; i <= end; i++) {
    const wanted: string[] = [];
    const exits: string[] = [];
    for (const sym of seriesBySymbol.keys()) {
      const closes = seriesBySymbol.get(sym)!;
      const state = desiredState(variant, closes, i, p);
      const held = (shares.get(sym) ?? 0) > 0;
      if (state === 1 && !held) wanted.push(sym);
      if (state === 0 && held) exits.push(sym);
    }

    // Exits first — frees cash for the same bar's entries.
    for (const sym of exits) {
      const qty = shares.get(sym)!;
      const notional = qty * priceAt(sym, i);
      const c = tradeCost(notional);
      cash += notional - c;
      costs += c;
      trades++;
      shares.delete(sym);
    }

    const openSlots = maxPositions - shares.size;
    if (openSlots > 0 && wanted.length) {
      const equityNow =
        cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0);
      const target = equityNow / maxPositions;
      for (const sym of wanted.slice(0, openSlots)) {
        const price = priceAt(sym, i);
        const notional = Math.min(target, cash * 0.98);
        if (notional < 250) continue; // cost-governor minimum ticket
        const c = tradeCost(notional);
        const qty = (notional - c) / price;
        if (!(qty > 0)) continue;
        cash -= notional;
        costs += c;
        trades++;
        shares.set(sym, qty);
      }
    }

    const equity = cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0);
    equityCurve.push(equity);
  }

  // Liquidate at the segment close so segments are comparable.
  const last = end;
  let finalEquity = cash;
  for (const [sym, qty] of shares) {
    const notional = qty * priceAt(sym, last);
    finalEquity += notional - tradeCost(notional);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    rets.push(equityCurve[i]! / equityCurve[i - 1]! - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const varr =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sd = Math.sqrt(varr);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;

  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDd = Math.min(maxDd, e / peak - 1);
  }

  return {
    returnPct: (finalEquity / startingCash - 1) * 100,
    sharpe,
    maxDrawdownPct: maxDd * 100,
    trades,
    costs,
  };
}

// ---------------------------------------------------------------- benchmark

function buyAndHold(
  seriesBySymbol: Map<string, number[]>,
  start: number,
  end: number,
): number {
  let sum = 0;
  let n = 0;
  for (const closes of seriesBySymbol.values()) {
    const a = closes[start]!;
    const b = closes[end]!;
    if (a > 0 && b > 0) {
      sum += b / a - 1;
      n++;
    }
  }
  return n ? (sum / n) * 100 : 0;
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Fetching ${symbols.length} symbols ${from} → ${to} …`);
  const histories = await fetchUniverseHistory(symbols, {
    from,
    to,
    pauseMs: 250,
    onProgress: (m) => console.log(`  ${m}`),
  });
  const tape = buildRealTape(histories, { mode: priceMode, from, to });
  const bars = tape.bars as BacktestBar[];
  console.log(`Tape: ${bars.length} bars, ${tape.symbols.length} symbols\n`);

  const seriesBySymbol = new Map<string, number[]>();
  for (const sym of tape.symbols) {
    const series = bars.map((b) => b.closes[sym] ?? NaN);
    // Forward-fill leading holes so index maths stays aligned.
    let lastGood = NaN;
    for (let i = 0; i < series.length; i++) {
      if (Number.isFinite(series[i]!) && series[i]! > 0) lastGood = series[i]!;
      else series[i] = lastGood;
    }
    if (series.every((v) => Number.isFinite(v) && v > 0)) seriesBySymbol.set(sym, series);
  }
  console.log(`Usable symbols: ${[...seriesBySymbol.keys()].join(", ")}\n`);

  const warm = 220; // SMA200 + confirm buffer
  const folds: Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> = [];
  let cursor = warm;
  while (cursor + trainDays + testDays <= bars.length) {
    folds.push({
      trainStart: cursor,
      trainEnd: cursor + trainDays - 1,
      testStart: cursor + trainDays,
      testEnd: cursor + trainDays + testDays - 1,
    });
    cursor += testDays;
  }
  console.log(`Walk-forward: ${folds.length} folds (train ${trainDays}d / test ${testDays}d)\n`);

  const perVariant = new Map<Variant, SegmentResult[]>();
  const chosen = new Map<Variant, Params[]>();
  for (const v of VARIANTS) {
    perVariant.set(v, []);
    chosen.set(v, []);
  }
  const benchPct: number[] = [];

  for (const [n, f] of folds.entries()) {
    const label = `${bars[f.testStart]!.date} → ${bars[f.testEnd]!.date}`;
    const bench = buyAndHold(seriesBySymbol, f.testStart, f.testEnd);
    benchPct.push(bench);
    const row: string[] = [];
    for (const variant of VARIANTS) {
      // --- tune on train only
      let best: { p: Params; score: number } | null = null;
      for (const p of GRID) {
        const r = simulate(variant, bars, seriesBySymbol, f.trainStart, f.trainEnd, p);
        const score = r.sharpe;
        if (!best || score > best.score) best = { p, score };
      }
      const p = best!.p;
      chosen.get(variant)!.push(p);
      // --- score the untouched test window
      const test = simulate(variant, bars, seriesBySymbol, f.testStart, f.testEnd, p);
      perVariant.get(variant)!.push(test);
      row.push(`${variant} ${test.returnPct >= 0 ? "+" : ""}${test.returnPct.toFixed(2)}%`);
    }
    console.log(
      `fold ${String(n + 1).padStart(2)} ${label}  bench ${bench >= 0 ? "+" : ""}${bench.toFixed(2)}%  |  ${row.join("  ")}`,
    );
  }

  console.log("\n=== OUT-OF-SAMPLE AGGREGATE (test windows only) ===");
  const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const header = [
    "variant".padEnd(14),
    "mean ret%".padStart(10),
    "median%".padStart(9),
    "win rate".padStart(9),
    "mean Sharpe".padStart(12),
    "worst DD%".padStart(10),
    "vs bench".padStart(9),
    "trades".padStart(7),
    "costs £".padStart(9),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const variant of VARIANTS) {
    const rs = perVariant.get(variant)!;
    const rets = rs.map((r) => r.returnPct);
    const sorted = [...rets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const wins = rets.filter((r) => r > 0).length;
    const beat = rets.filter((r, i) => r > benchPct[i]!).length;
    console.log(
      [
        variant.padEnd(14),
        meanOf(rets).toFixed(2).padStart(10),
        median.toFixed(2).padStart(9),
        `${((wins / rets.length) * 100).toFixed(0)}%`.padStart(9),
        meanOf(rs.map((r) => r.sharpe)).toFixed(2).padStart(12),
        Math.min(...rs.map((r) => r.maxDrawdownPct)).toFixed(2).padStart(10),
        `${beat}/${rets.length}`.padStart(9),
        String(rs.reduce((a, r) => a + r.trades, 0)).padStart(7),
        rs.reduce((a, r) => a + r.costs, 0).toFixed(0).padStart(9),
      ].join(" "),
    );
  }
  console.log(
    `${"buy&hold".padEnd(14)}${meanOf(benchPct).toFixed(2).padStart(10)}`,
  );

  // Paired significance of 20/50/200 vs 20/50 across folds.
  const a = perVariant.get("sma20_50")!.map((r) => r.returnPct);
  const b = perVariant.get("sma20_50_200")!.map((r) => r.returnPct);
  const diffs = b.map((x, i) => x - a[i]!);
  const md = meanOf(diffs);
  const sd = Math.sqrt(
    diffs.reduce((s, d) => s + (d - md) ** 2, 0) / Math.max(1, diffs.length - 1),
  );
  const t = sd > 0 ? md / (sd / Math.sqrt(diffs.length)) : 0;
  console.log(
    `\npaired diff (20/50/200 − 20/50): mean ${md.toFixed(2)}pp, t=${t.toFixed(2)} over ${diffs.length} folds`,
  );

  console.log("\nMost-selected params per variant (train windows):");
  for (const variant of VARIANTS) {
    const counts = new Map<string, number>();
    for (const p of chosen.get(variant)!) {
      const k = `sep ${(p.separationPct * 100).toFixed(1)}% / confirm ${p.confirmBars}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 3);
    console.log(`  ${variant.padEnd(14)} ${top.map(([k, c]) => `${k} ×${c}`).join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
