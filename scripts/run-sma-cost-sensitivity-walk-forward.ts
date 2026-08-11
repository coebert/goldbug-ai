// Cost-sensitivity walk-forward: how much of the SMA trend edge survives
// harsher slippage and different fee models?
//
//   bun run scripts/run-sma-cost-sensitivity-walk-forward.ts
//   bun run scripts/run-sma-cost-sensitivity-walk-forward.ts --train 504 --test 126 --from 2005-01-01
//
// Same rolling out-of-sample protocol as `run-sma-variant-walk-forward.ts`
// (tune on TRAIN, score the untouched TEST window, aggregate test windows
// only) but repeated across a matrix of cost assumptions:
//
//   • frictionless (upper bound on the paper edge)
//   • the live cost-governor baseline
//   • 2x / 4x slippage
//   • a flat per-ticket fee model instead of bps + floor
//   • a punitive small-account / illiquid-fill scenario
//
// Parameters are re-tuned under each cost scenario, because a strategy that
// knows trading is expensive should trade less — holding the tuning fixed
// would overstate cost sensitivity.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import type { BacktestBar } from "../src/lib/backtest-runner";
import {
  calibrateSymbolExecution,
  executionCostFor,
  type SymbolExecutionCalibration,
} from "../src/lib/execution-calibration-from-bars";
import type { AssetClass } from "../src/lib/universe.server";

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

const VARIANTS = ["sma20", "sma20_50", "sma20_50_200"] as const;
type Variant = (typeof VARIANTS)[number];

type Params = { separationPct: number; confirmBars: number };
const GRID: Params[] = [];
for (const separationPct of [0, 0.002, 0.005, 0.01]) {
  for (const confirmBars of [1, 2, 3]) GRID.push({ separationPct, confirmBars });
}

// ---------------------------------------------------------------- costs

type CostModel = {
  label: string;
  /** Proportional commission in bps of notional. */
  commissionBps: number;
  /** Hard commission floor per ticket, £. */
  commissionMin: number;
  /** Flat per-ticket fee added on top (alternative fee model), £. */
  flatFee: number;
  /** Half-spread + market impact in bps of notional. */
  slippageBps: number;
  /** Minimum ticket the cost governor will place, £. */
  minTicket: number;
  /**
   * Calibrated models price each fill per symbol (own spread, own venue
   * commission, own ADV-driven impact) instead of one flat bps assumption.
   */
  perSymbol?: (symbol: string, notional: number) => number;
};

const BASE_SCENARIOS: CostModel[] = [
  { label: "frictionless", commissionBps: 0, commissionMin: 0, flatFee: 0, slippageBps: 0, minTicket: 0 },
  { label: "live baseline", commissionBps: 8, commissionMin: 3, flatFee: 0, slippageBps: 5, minTicket: 250 },
  { label: "2x slippage", commissionBps: 8, commissionMin: 3, flatFee: 0, slippageBps: 10, minTicket: 250 },
  { label: "4x slippage", commissionBps: 8, commissionMin: 3, flatFee: 0, slippageBps: 20, minTicket: 250 },
  { label: "flat £8/ticket", commissionBps: 0, commissionMin: 0, flatFee: 8, slippageBps: 5, minTicket: 250 },
  { label: "flat £8 + 2x slip", commissionBps: 0, commissionMin: 0, flatFee: 8, slippageBps: 10, minTicket: 250 },
  { label: "saxo-like tiered", commissionBps: 12, commissionMin: 5, flatFee: 0, slippageBps: 10, minTicket: 250 },
  { label: "punitive", commissionBps: 25, commissionMin: 10, flatFee: 0, slippageBps: 40, minTicket: 250 },
];

/** Populated in main() once the calibration step has run. */
let SCENARIOS: CostModel[] = BASE_SCENARIOS;

const costOf = (m: CostModel, notional: number, symbol: string) =>
  m.perSymbol
    ? m.perSymbol(symbol, notional)
    : Math.max(m.commissionMin, (notional * m.commissionBps) / 10_000)
      + m.flatFee
      + (notional * m.slippageBps) / 10_000;

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

  const s200 = sma(closes, i, 200);
  if (s200 == null) return null;
  if (!(s50 > s200)) return 0;
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

function simulate(
  variant: Variant,
  seriesBySymbol: Map<string, number[]>,
  start: number,
  end: number,
  p: Params,
  cost: CostModel,
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

    for (const sym of exits) {
      const qty = shares.get(sym)!;
      const notional = qty * priceAt(sym, i);
      const c = costOf(cost, notional);
      cash += notional - c;
      costs += c;
      trades++;
      shares.delete(sym);
    }

    const openSlots = maxPositions - shares.size;
    if (openSlots > 0 && wanted.length) {
      const equityNow = cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0);
      const target = equityNow / maxPositions;
      for (const sym of wanted.slice(0, openSlots)) {
        const price = priceAt(sym, i);
        const notional = Math.min(target, cash * 0.98);
        if (notional < cost.minTicket) continue;
        const c = costOf(cost, notional);
        const qty = (notional - c) / price;
        if (!(qty > 0)) continue;
        cash -= notional;
        costs += c;
        trades++;
        shares.set(sym, qty);
      }
    }

    equityCurve.push(cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0));
  }

  let finalEquity = cash;
  for (const [sym, qty] of shares) {
    const notional = qty * priceAt(sym, end);
    finalEquity += notional - costOf(cost, notional);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) rets.push(equityCurve[i]! / equityCurve[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
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

function buyAndHold(seriesBySymbol: Map<string, number[]>, start: number, end: number): number {
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

const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Paired t across folds for `a - b`. */
function pairedT(a: number[], b: number[]): { mean: number; t: number } {
  const d = a.map((x, i) => x - b[i]!);
  const md = meanOf(d);
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - md) ** 2, 0) / Math.max(1, d.length - 1));
  return { mean: md, t: sd > 0 ? md / (sd / Math.sqrt(d.length)) : 0 };
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Fetching ${symbols.length} symbols ${from} → ${to} …`);
  const histories = await fetchUniverseHistory(symbols, { from, to, pauseMs: 250 });
  const tape = buildRealTape(histories, { mode: priceMode, from, to });
  const bars = tape.bars as BacktestBar[];

  const seriesBySymbol = new Map<string, number[]>();
  for (const sym of tape.symbols) {
    const series = bars.map((b) => b.closes[sym] ?? NaN);
    let lastGood = NaN;
    for (let i = 0; i < series.length; i++) {
      if (Number.isFinite(series[i]!) && series[i]! > 0) lastGood = series[i]!;
      else series[i] = lastGood;
    }
    if (series.every((v) => Number.isFinite(v) && v > 0)) seriesBySymbol.set(sym, series);
  }
  console.log(`Tape: ${bars.length} bars, ${seriesBySymbol.size} usable symbols\n`);

  const warm = 220;
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

  const benchPct = folds.map((f) => buyAndHold(seriesBySymbol, f.testStart, f.testEnd));
  console.log(
    `Walk-forward: ${folds.length} folds (train ${trainDays}d / test ${testDays}d), `
    + `buy&hold mean ${meanOf(benchPct).toFixed(2)}%/fold\n`,
  );

  const perScenario = new Map<string, Map<Variant, number[]>>();

  for (const cost of SCENARIOS) {
    const byVariant = new Map<Variant, SegmentResult[]>();
    for (const v of VARIANTS) byVariant.set(v, []);

    for (const f of folds) {
      for (const variant of VARIANTS) {
        // Re-tune under THIS cost model: expensive trading should change the
        // parameters a rational operator would pick.
        let best: { p: Params; score: number } | null = null;
        for (const p of GRID) {
          const r = simulate(variant, seriesBySymbol, f.trainStart, f.trainEnd, p, cost);
          if (!best || r.sharpe > best.score) best = { p, score: r.sharpe };
        }
        byVariant
          .get(variant)!
          .push(simulate(variant, seriesBySymbol, f.testStart, f.testEnd, best!.p, cost));
      }
    }

    console.log(`=== ${cost.label} `
      + `(comm ${cost.commissionBps}bps/min £${cost.commissionMin}`
      + `${cost.flatFee ? ` + £${cost.flatFee} flat` : ""}, slip ${cost.slippageBps}bps) ===`);
    const header = [
      "variant".padEnd(14),
      "mean ret%".padStart(10),
      "Sharpe".padStart(8),
      "worst DD%".padStart(10),
      "vs bench pp".padStart(12),
      "beat".padStart(6),
      "trades".padStart(7),
      "costs £".padStart(9),
      "cost drag pp".padStart(13),
    ].join(" ");
    console.log(header);
    console.log("-".repeat(header.length));

    const retsByVariant = new Map<Variant, number[]>();
    for (const variant of VARIANTS) {
      const rs = byVariant.get(variant)!;
      const rets = rs.map((r) => r.returnPct);
      retsByVariant.set(variant, rets);
      const beat = rets.filter((r, i) => r > benchPct[i]!).length;
      const dragPp = meanOf(rs.map((r) => (r.costs / startingCash) * 100));
      console.log(
        [
          variant.padEnd(14),
          meanOf(rets).toFixed(2).padStart(10),
          meanOf(rs.map((r) => r.sharpe)).toFixed(2).padStart(8),
          Math.min(...rs.map((r) => r.maxDrawdownPct)).toFixed(2).padStart(10),
          (meanOf(rets) - meanOf(benchPct)).toFixed(2).padStart(12),
          `${beat}/${rets.length}`.padStart(6),
          String(rs.reduce((a, r) => a + r.trades, 0)).padStart(7),
          rs.reduce((a, r) => a + r.costs, 0).toFixed(0).padStart(9),
          dragPp.toFixed(2).padStart(13),
        ].join(" "),
      );
    }
    perScenario.set(cost.label, retsByVariant);
    console.log();
  }

  // ------------------------------------------------ sensitivity summary
  console.log("=== SENSITIVITY OF THE EDGE TO COSTS ===");
  console.log(
    "Mean out-of-sample return per fold, by scenario (pp change vs frictionless):\n",
  );
  const head = ["scenario".padEnd(18), ...VARIANTS.map((v) => v.padStart(16))].join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  const zero = perScenario.get("frictionless")!;
  for (const cost of SCENARIOS) {
    const m = perScenario.get(cost.label)!;
    const cells = VARIANTS.map((v) => {
      const mean = meanOf(m.get(v)!);
      const delta = mean - meanOf(zero.get(v)!);
      return `${mean.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`.padStart(16);
    });
    console.log([cost.label.padEnd(18), ...cells].join(" "));
  }

  console.log("\nPaired significance vs buy&hold, per scenario (mean pp, t):");
  for (const cost of SCENARIOS) {
    const m = perScenario.get(cost.label)!;
    const parts = VARIANTS.map((v) => {
      const { mean, t } = pairedT(m.get(v)!, benchPct);
      return `${v} ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}pp t=${t.toFixed(2)}`;
    });
    console.log(`  ${cost.label.padEnd(18)} ${parts.join("   ")}`);
  }

  console.log("\nCost elasticity (pp of return lost per 1bp of extra slippage, live→4x):");
  const base = perScenario.get("live baseline")!;
  const quad = perScenario.get("4x slippage")!;
  for (const v of VARIANTS) {
    const lost = meanOf(base.get(v)!) - meanOf(quad.get(v)!);
    console.log(`  ${v.padEnd(14)} ${(lost / 15).toFixed(3)} pp/bp  (${lost.toFixed(2)}pp over +15bp)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
