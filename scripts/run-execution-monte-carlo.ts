// Execution Monte-Carlo: how wide is the outcome distribution once slippage
// is random and fills are partial?
//
//   bun run scripts/run-execution-monte-carlo.ts
//   bun run scripts/run-execution-monte-carlo.ts --paths 400 --from 2015-01-01
//   bun run scripts/run-execution-monte-carlo.ts --sigma 0.8 --full-fill 0.6 --no-fill 0.05
//
// The cost-sensitivity sweep answers "what if costs are higher?" with a single
// point estimate per scenario. This script answers the different question the
// live account actually faces: given the *calibrated* per-symbol cost model as
// the centre of the distribution, how bad can a year get when individual fills
// go against you?
//
// Protocol: same rolling walk-forward as the cost sweep — tune on TRAIN with
// deterministic execution, then replay the untouched TEST window `--paths`
// times with seeded randomized execution. Each path is a complete alternative
// history across every fold, so the reported percentiles are percentiles over
// *strategy lifetimes*, not over individual trades.
//
// Randomization (see src/lib/execution-monte-carlo.ts):
//   • slippage multiplier ~ lognormal(median 1, sigma) with a fat tail
//   • partial fills: full / partial / no-fill draw per order, remainder retried
//   • commissions are NOT randomized — the ticket floor is contractual

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import type { BacktestBar } from "../src/lib/backtest-runner";
import {
  calibrateSymbolExecution,
  executionCostFor,
  type SymbolExecutionCalibration,
} from "../src/lib/execution-calibration-from-bars";
import type { AssetClass } from "../src/lib/universe.server";
import {
  SMA_VARIANTS,
  desiredState,
  type SmaVariant,
  type SmaVariantParams,
} from "../src/lib/backtest/sma-variant-state";
import {
  DEFAULT_EXECUTION_SIM,
  DETERMINISTIC_DRAW,
  percentileStats,
  drawdownBreachProbabilities,
  DEFAULT_DRAWDOWN_THRESHOLDS,
  type PercentileStats,
} from "../src/lib/execution-monte-carlo";
import {
  DEFAULT_CORRELATED_EXECUTION,
  makeCorrelatedExecutionSampler,
  marketVolZScores,
  type CorrelatedExecutionSampler,
} from "../src/lib/execution-correlated-shocks";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "PG", "SPY", "GLD"];

const from = arg("from", "2015-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const priceMode = arg("price-mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const trainDays = Number(arg("train", "504"));
const testDays = Number(arg("test", "126"));
const maxPositions = Number(arg("max-positions", "5"));
const paths = Number(arg("paths", "300"));
const minTicket = Number(arg("min-ticket", "250"));
const baseSeed = Number(arg("seed", "20260811"));
// Positive depths, e.g. --dd-thresholds 5,10,20 asks "how often do we lose 5/10/20%?"
const ddThresholds = arg("dd-thresholds", DEFAULT_DRAWDOWN_THRESHOLDS.join(","))
  .split(",")
  .map((v) => Math.abs(Number(v.trim())))
  .filter((v) => Number.isFinite(v) && v > 0);

const simCfg = {
  slippageSigma: Number(arg("sigma", String(DEFAULT_EXECUTION_SIM.slippageSigma))),
  tailProb: Number(arg("tail-prob", String(DEFAULT_EXECUTION_SIM.tailProb))),
  tailMult: Number(arg("tail-mult", String(DEFAULT_EXECUTION_SIM.tailMult))),
  maxSlippageMult: DEFAULT_EXECUTION_SIM.maxSlippageMult,
  fullFillProb: Number(arg("full-fill", String(DEFAULT_EXECUTION_SIM.fullFillProb))),
  minFillRatio: Number(arg("min-fill", String(DEFAULT_EXECUTION_SIM.minFillRatio))),
  noFillProb: Number(arg("no-fill", String(DEFAULT_EXECUTION_SIM.noFillProb))),
  // Cross-symbol coupling: on a stressed bar every name widens together and
  // every order struggles to fill together, so a rebalance pays the bad tail
  // on all legs at once. --rho 0 --stress-enter 0 --vol-stress-z 99 recovers
  // the old independent-draw behaviour.
  rho: Number(arg("rho", String(DEFAULT_CORRELATED_EXECUTION.rho))),
  stressEnterProb: Number(arg("stress-enter", String(DEFAULT_CORRELATED_EXECUTION.stressEnterProb))),
  stressExitProb: Number(arg("stress-exit", String(DEFAULT_CORRELATED_EXECUTION.stressExitProb))),
  stressSlippageMult: Number(arg("stress-slip", String(DEFAULT_CORRELATED_EXECUTION.stressSlippageMult))),
  stressSigmaMult: DEFAULT_CORRELATED_EXECUTION.stressSigmaMult,
  stressNoFillMult: Number(arg("stress-no-fill", String(DEFAULT_CORRELATED_EXECUTION.stressNoFillMult))),
  stressFullFillMult: DEFAULT_CORRELATED_EXECUTION.stressFullFillMult,
  volStressZ: Number(arg("vol-stress-z", String(DEFAULT_CORRELATED_EXECUTION.volStressZ))),
  volSlippageBeta: DEFAULT_CORRELATED_EXECUTION.volSlippageBeta,
};

const GRID: SmaVariantParams[] = [];
for (const separationPct of [0, 0.002, 0.005, 0.01]) {
  for (const confirmBars of [1, 2, 3]) GRID.push({ separationPct, confirmBars });
}

// ---------------------------------------------------------------- simulator

type SegmentResult = {
  returnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  /** Orders that resulted in at least a partial fill. */
  fills: number;
  /** Orders that got nothing on the bar they were sent. */
  missedOrders: number;
  /** Fills that delivered less than the requested size. */
  partialFills: number;
  costs: number;
  /** Orders sent on a bar the correlated sampler flagged as stressed. */
  stressOrders: number;
  /** Orders that got nothing, on a stressed bar. */
  stressMissed: number;
  /** Execution costs paid on stressed bars. */
  stressCosts: number;
  /** Bars in the segment the sampler flagged as stressed. */
  stressBars: number;
};

type Ctx = {
  seriesBySymbol: Map<string, number[]>;
  /** Cross-sectional realised-vol z-score per bar; drives the stress regime. */
  volZ: number[];
  costFor: (symbol: string, notional: number, slipMult: number) => number;
};

function simulate(
  ctx: Ctx,
  variant: SmaVariant,
  start: number,
  end: number,
  p: SmaVariantParams,
  /** null = deterministic execution (the point estimate). */
  sampler: CorrelatedExecutionSampler | null,
): SegmentResult {
  const { seriesBySymbol, costFor, volZ } = ctx;
  let cash = startingCash;
  const shares = new Map<string, number>();
  const equityCurve: number[] = [];
  let fills = 0;
  let missedOrders = 0;
  let partialFills = 0;
  let costs = 0;
  let stressOrders = 0;
  let stressMissed = 0;
  let stressCosts = 0;
  let stressBars = 0;

  const draw = () => (sampler ? sampler.draw() : DETERMINISTIC_DRAW);
  let stressedBar = false;
  const priceAt = (sym: string, i: number) => seriesBySymbol.get(sym)![i]!;

  for (let i = start; i <= end; i++) {
    // One regime roll per bar, shared by every order on that bar — that shared
    // draw is what makes the legs of a rebalance fail together.
    stressedBar = sampler ? sampler.beginBar(volZ[i] ?? 0).stressed : false;
    if (stressedBar) stressBars++;
    const wanted: string[] = [];
    const exits: string[] = [];
    for (const sym of seriesBySymbol.keys()) {
      const closes = seriesBySymbol.get(sym)!;
      const state = desiredState(variant, closes, i, p);
      const held = (shares.get(sym) ?? 0) > 0;
      // A partially-exited name stays in `exits` next bar; a partially-entered
      // one stays out of `wanted` (no averaging up into a bad fill).
      if (state === 1 && !held) wanted.push(sym);
      if (state === 0 && held) exits.push(sym);
    }

    for (const sym of exits) {
      const qty = shares.get(sym)!;
      const d = draw();
      if (stressedBar) stressOrders++;
      if (d.fillRatio <= 0) {
        missedOrders++;
        if (stressedBar) stressMissed++;
        continue;
      }
      const soldQty = qty * d.fillRatio;
      const notional = soldQty * priceAt(sym, i);
      const c = costFor(sym, notional, d.slippageMult);
      cash += notional - c;
      costs += c;
      if (stressedBar) stressCosts += c;
      fills++;
      if (d.fillRatio < 1) partialFills++;
      const rest = qty - soldQty;
      if (rest > 1e-9) shares.set(sym, rest);
      else shares.delete(sym);
    }

    const openSlots = maxPositions - shares.size;
    if (openSlots > 0 && wanted.length) {
      const equityNow = cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0);
      const target = equityNow / maxPositions;
      for (const sym of wanted.slice(0, openSlots)) {
        const price = priceAt(sym, i);
        const requested = Math.min(target, cash * 0.98);
        if (requested < minTicket) continue;
        const d = draw();
        if (stressedBar) stressOrders++;
        if (d.fillRatio <= 0) {
          missedOrders++;
          if (stressedBar) stressMissed++;
          continue;
        }
        const notional = requested * d.fillRatio;
        // The commission floor is charged on whatever actually fills, so a
        // partial fill is strictly worse in bps than the full ticket.
        if (notional < minTicket * 0.2) {
          missedOrders++;
          if (stressedBar) stressMissed++;
          continue;
        }
        const c = costFor(sym, notional, d.slippageMult);
        const qty = (notional - c) / price;
        if (!(qty > 0)) continue;
        cash -= notional;
        costs += c;
        if (stressedBar) stressCosts += c;
        fills++;
        if (d.fillRatio < 1) partialFills++;
        shares.set(sym, qty);
      }
    }

    equityCurve.push(cash + [...shares].reduce((a, [s, q]) => a + q * priceAt(s, i), 0));
  }

  let finalEquity = cash;
  for (const [sym, qty] of shares) {
    const d = draw();
    const notional = qty * priceAt(sym, end);
    finalEquity += notional - costFor(sym, notional, d.slippageMult);
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
    fills,
    missedOrders,
    partialFills,
    costs,
    stressOrders,
    stressMissed,
    stressCosts,
    stressBars,
  };
}

const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

function statLine(label: string, s: PercentileStats): string {
  return [
    label.padEnd(14),
    fmt(s.worst).padStart(9),
    fmt(s.p5).padStart(8),
    fmt(s.p25).padStart(8),
    fmt(s.median).padStart(8),
    fmt(s.mean).padStart(8),
    fmt(s.p75).padStart(8),
    fmt(s.p95).padStart(8),
    fmt(s.cvar5).padStart(9),
    fmt(s.stdev).padStart(8),
    `${(s.probLoss * 100).toFixed(1)}%`.padStart(9),
  ].join(" ");
}

const STAT_HEADER = [
  "variant".padEnd(14),
  "worst".padStart(9),
  "p5".padStart(8),
  "p25".padStart(8),
  "median".padStart(8),
  "mean".padStart(8),
  "p75".padStart(8),
  "p95".padStart(8),
  "CVaR5".padStart(9),
  "sd".padStart(8),
  "P(loss)".padStart(9),
].join(" ");

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
  console.log(`Tape: ${bars.length} bars, ${seriesBySymbol.size} usable symbols`);

  // Calibrated per-symbol execution model = the centre of the distribution.
  const guessClass = (sym: string): AssetClass => {
    if (/^(GLD|SGLN|IAU|SLV)/i.test(sym)) return "commodity";
    if (/^(SPY|QQQ|VOO|IVV|VUKE|ISF|EQQQ|XU|VWRL)/i.test(sym)) return "etf";
    if (/(BTC|ETH)/i.test(sym)) return "crypto";
    return "stock";
  };
  const calibs = new Map<string, SymbolExecutionCalibration>();
  for (const h of histories) {
    if (!seriesBySymbol.has(h.symbol)) continue;
    calibs.set(h.symbol, calibrateSymbolExecution({
      symbol: h.symbol,
      bars: h.bars,
      currency: h.currency,
      assetClass: guessClass(h.symbol),
      window: Math.min(756, h.bars.length),
    }));
  }
  const fallback = calibrateSymbolExecution({ symbol: "UNKNOWN", bars: [] });
  const volZ = marketVolZScores(seriesBySymbol, 20);
  const ctx: Ctx = {
    seriesBySymbol,
    volZ,
    costFor: (sym, notional, slipMult) =>
      executionCostFor(calibs.get(sym) ?? fallback, notional, "normal", slipMult).total,
  };

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

  console.log(
    `Walk-forward: ${folds.length} folds (train ${trainDays}d / test ${testDays}d), `
    + `${paths} Monte-Carlo paths per variant`,
  );
  console.log(
    `Execution draw: slippage lognormal σ=${simCfg.slippageSigma} `
    + `(+${(simCfg.tailProb * 100).toFixed(1)}% tail × ${simCfg.tailMult}), `
    + `fills full ${(simCfg.fullFillProb * 100).toFixed(0)}% / `
    + `none ${(simCfg.noFillProb * 100).toFixed(0)}% / partial rest ≥${simCfg.minFillRatio}`,
  );
  console.log(
    `Correlated shocks: cross-symbol log-slippage ρ=${simCfg.rho}, `
    + `stress regime enter ${(simCfg.stressEnterProb * 100).toFixed(1)}%/bar `
    + `(mean length ${(1 / Math.max(1e-9, simCfg.stressExitProb)).toFixed(1)} bars, `
    + `forced when vol z ≥ ${simCfg.volStressZ}), `
    + `slippage ×${simCfg.stressSlippageMult} and no-fill ×${simCfg.stressNoFillMult} while stressed\n`,
  );

  for (const variant of SMA_VARIANTS) {
    // 1. Tune on TRAIN with deterministic execution (the strategy cannot know
    //    which fills will go badly, so it must not be tuned against them).
    const tuned = folds.map((f) => {
      let best: SmaVariantParams = GRID[0]!;
      let bestScore = -Infinity;
      for (const p of GRID) {
        const r = simulate(ctx, variant, f.trainStart, f.trainEnd, p, null);
        const score = r.returnPct + r.sharpe * 5 + r.maxDrawdownPct * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      return best;
    });

    // 2. Deterministic OOS baseline.
    const detFolds = folds.map((f, k) =>
      simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, null));
    const detMean = meanOf(detFolds.map((r) => r.returnPct));

    // 3. Monte-Carlo paths. A path uses one sampler across all folds, so a
    //    "bad path" is a strategy lifetime with persistently unlucky fills.
    const pathMeanRet: number[] = [];
    const pathWorstFold: number[] = [];
    const pathMaxDd: number[] = [];
    // Deepest single-fold drawdown on the path — the number that actually
    // trips a risk limit, unlike the across-fold average.
    const pathDeepestDd: number[] = [];
    const pathSharpe: number[] = [];
    const pathCosts: number[] = [];
    let missed = 0;
    let partial = 0;
    let totalOrders = 0;
    let stressOrders = 0;
    let stressMissed = 0;
    let stressBars = 0;
    let allBars = 0;
    // Share of a path's total execution cost incurred on stressed bars — the
    // clean read on joint (rather than average) execution risk.
    const pathStressCostShare: number[] = [];

    for (let pth = 0; pth < paths; pth++) {
      const sampler = makeCorrelatedExecutionSampler(
        simCfg,
        baseSeed + pth * 7919 + variant.length * 104729,
      );
      const rets: number[] = [];
      let worstFold = Infinity;
      let ddSum = 0;
      let deepestDd = 0;
      let shSum = 0;
      let costSum = 0;
      let stressCostSum = 0;
      for (let k = 0; k < folds.length; k++) {
        const f = folds[k]!;
        const r = simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, sampler);
        rets.push(r.returnPct);
        worstFold = Math.min(worstFold, r.returnPct);
        ddSum += r.maxDrawdownPct;
        deepestDd = Math.min(deepestDd, r.maxDrawdownPct);
        shSum += r.sharpe;
        costSum += r.costs;
        stressCostSum += r.stressCosts;
        missed += r.missedOrders;
        partial += r.partialFills;
        totalOrders += r.fills + r.missedOrders;
        stressOrders += r.stressOrders;
        stressMissed += r.stressMissed;
        stressBars += r.stressBars;
        allBars += f.testEnd - f.testStart + 1;
      }
      pathStressCostShare.push(costSum > 0 ? (stressCostSum / costSum) * 100 : 0);
      pathMeanRet.push(meanOf(rets));
      pathWorstFold.push(worstFold);
      pathMaxDd.push(ddSum / folds.length);
      pathDeepestDd.push(deepestDd);
      pathSharpe.push(shSum / folds.length);
      pathCosts.push(costSum / folds.length);
    }

    const ret = percentileStats(pathMeanRet);
    const worst = percentileStats(pathWorstFold);
    const dd = percentileStats(pathMaxDd);
    const deepDd = percentileStats(pathDeepestDd);
    const breaches = drawdownBreachProbabilities(pathDeepestDd, ddThresholds);
    const sh = percentileStats(pathSharpe);
    const cost = percentileStats(pathCosts);
    const stressShare = percentileStats(pathStressCostShare);

    console.log(`=== ${variant} ===`);
    console.log(
      `deterministic OOS mean ${detMean.toFixed(2)}%/fold  →  `
      + `randomized median ${ret.median.toFixed(2)}%  `
      + `(execution luck costs ${(ret.median - detMean).toFixed(2)}pp at the median)`,
    );
    console.log(
      `orders: ${totalOrders} across all paths · `
      + `${((partial / Math.max(1, totalOrders)) * 100).toFixed(1)}% partial · `
      + `${((missed / Math.max(1, totalOrders)) * 100).toFixed(1)}% unfilled on the bar`,
    );
    console.log(STAT_HEADER);
    console.log("-".repeat(STAT_HEADER.length));
    console.log(statLine("return %/fold", ret));
    console.log(statLine("worst fold %", worst));
    console.log(statLine("mean maxDD %", dd));
    console.log(statLine("deepest DD %", deepDd));
    console.log(statLine("Sharpe", sh));
    console.log(statLine("costs £/fold", cost));
    console.log(statLine("stress cost %", stressShare));
    console.log(
      `stressed bars ${((stressBars / Math.max(1, allBars)) * 100).toFixed(1)}% of tape · `
      + `${((stressOrders / Math.max(1, totalOrders)) * 100).toFixed(1)}% of orders sent into stress · `
      + `unfilled in stress ${((stressMissed / Math.max(1, stressOrders)) * 100).toFixed(1)}% `
      + `vs calm ${(((missed - stressMissed) / Math.max(1, totalOrders - stressOrders)) * 100).toFixed(1)}%`,
    );
    console.log(
      "P(deepest drawdown ≥ X): "
      + breaches
        .map((b) => `${b.thresholdPct}% ${(b.prob * 100).toFixed(1)}% (${b.count}/${paths})`)
        .join("  ·  "),
    );
    console.log();
  }

  console.log("Reading: 'return %/fold' percentiles are over whole strategy lifetimes.");
  console.log("p5 is the 1-in-20 bad-execution-luck year; CVaR5 is the average of those.");
  console.log("'deepest DD %' is the worst single fold on each path; the breach line reads");
  console.log("as the chance a lifetime touches that drawdown depth at least once.");
  console.log("Shocks are correlated: on a stressed bar every symbol widens and every order");
  console.log("struggles together, so these tails are joint outcomes, not averaged-away ones.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
