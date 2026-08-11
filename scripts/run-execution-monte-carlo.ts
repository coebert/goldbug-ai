// Execution Monte-Carlo: how wide is the outcome distribution once slippage
// is random and fills are partial?
//
//   bun run scripts/run-execution-monte-carlo.ts
//   bun run scripts/run-execution-monte-carlo.ts --paths 400 --from 2015-01-01
//   bun run scripts/run-execution-monte-carlo.ts --sigma 0.8 --full-fill 0.6 --no-fill 0.05
//   bun run scripts/run-execution-monte-carlo.ts --rho-sweep 0,0.3,0.6,0.9 --vol-z-sweep 1,1.5,2,99

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
  jointDrawdownBreachProbabilities,
  conditionalTailStats,

  DEFAULT_DRAWDOWN_THRESHOLDS,
  type PercentileStats,
} from "../src/lib/execution-monte-carlo";
import {
  DEFAULT_CORRELATED_EXECUTION,
  makeCorrelatedExecutionSampler,
  marketVolZScores,
  type CorrelatedExecutionSampler,
} from "../src/lib/execution-correlated-shocks";
import {
  clusterSpilloverMatrix,
  clusterTailContributions,
  formatSpilloverHeatmap,
  formatTailContributions,
  topSpilloverPairs,
} from "../src/lib/execution-cluster-spillover";
import {
  calibrateCorrelations,
  describeCalibration,
  structureFromCalibration,
} from "../src/lib/execution-correlation-calibration";
import {
  clusterMap,
  describeStructure,
  makeCorrelationStructure,
  type CorrelationStructure,
  type CorrelationStructureKind,
} from "../src/lib/execution-correlation-structures";

import {
  EXECUTION_CHANNELS,
  channelSubsets,
  subsetKey,
  shapleyAttribution,
  type ExecutionChannel,
} from "../src/lib/execution-attribution";

import {
  DEFAULT_LIMIT_ORDER,
  barVolBpsSeries,
  limitFillOdds,
  makeLimitOrderSampler,
  type LimitOrderSampler,
} from "../src/lib/execution-limit-orders";

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
  // Regime-dependent coupling: with --regime-blend ramp the within/across
  // correlations migrate continuously between the calm and stress structures
  // as realised volatility moves, instead of snapping at one threshold.
  regimeBlend: arg("regime-blend", DEFAULT_CORRELATED_EXECUTION.regimeBlend) as "binary" | "ramp",
  regimeRampLoZ: Number(arg("regime-ramp-lo", String(DEFAULT_CORRELATED_EXECUTION.regimeRampLoZ))),
  regimeRampHiZ: Number(arg("regime-ramp-hi", String(DEFAULT_CORRELATED_EXECUTION.regimeRampHiZ))),
  stressBlendFloor: Number(arg("stress-blend-floor", String(DEFAULT_CORRELATED_EXECUTION.stressBlendFloor))),
  // Set below, once the coupling assumption is resolved from the CLI.
  structure: undefined as CorrelationStructure | undefined,
};


// --exec-model market  → every order crosses (the legacy behaviour).
// --exec-model limit   → orders rest first: maker/taker odds, queue fill
//                        probability, adverse selection, then cross on timeout.
const execModel = arg("exec-model", "limit") as "limit" | "market";
const limitCfg = {
  ...DEFAULT_LIMIT_ORDER,
  limitOffsetBps: Number(arg("limit-offset-bps", String(DEFAULT_LIMIT_ORDER.limitOffsetBps))),
  touchBeta: Number(arg("touch-beta", String(DEFAULT_LIMIT_ORDER.touchBeta))),
  queueAheadRatio: Number(arg("queue-ahead", String(DEFAULT_LIMIT_ORDER.queueAheadRatio))),
  queueTurnoverRatio: Number(arg("queue-turnover", String(DEFAULT_LIMIT_ORDER.queueTurnoverRatio))),
  crossAfterBars: Number(arg("cross-after", String(DEFAULT_LIMIT_ORDER.crossAfterBars))),
  makerFeeBps: Number(arg("maker-fee-bps", String(DEFAULT_LIMIT_ORDER.makerFeeBps))),
  takerFeeBps: Number(arg("taker-fee-bps", String(DEFAULT_LIMIT_ORDER.takerFeeBps))),
  adverseSelectionBeta: Number(arg("adverse-beta", String(DEFAULT_LIMIT_ORDER.adverseSelectionBeta))),
  waitDriftBeta: Number(arg("wait-drift-beta", String(DEFAULT_LIMIT_ORDER.waitDriftBeta))),
};

// ------------------------------------------------- joint-risk sensitivity sweep
// --rho-sweep 0,0.3,0.6,0.9 --vol-z-sweep 1,1.5,2,99
// Runs the same walk-forward Monte-Carlo across a grid of cross-symbol
// correlation (ρ) × realised-vol stress trigger (z), so you can see how the
// *joint* worst case moves with each assumption instead of trusting one cell.
const parseList = (raw: string) =>
  raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    .map(Number).filter((v) => Number.isFinite(v));

const rhoSweep = parseList(arg("rho-sweep", ""));
const volZSweep = parseList(arg("vol-z-sweep", ""));
// `sweepMode` is set below, once --structure-sweep has been parsed too.
const sweepPaths = Number(arg("sweep-paths", String(Math.max(40, Math.round(paths / 3)))));
// Threshold headlined in the sweep matrix; the full breach table still prints.
const sweepThreshold = Number(arg("sweep-threshold", String(ddThresholds[1] ?? ddThresholds[0] ?? 15)));

// Conditional ("worst-stress regime") tail statistics: keep the paths whose
// share of execution cost paid in stress is at or above this quantile, then
// take the CVaR of the worst `--stress-tail` fraction inside that subset.
const stressQuantile = Number(arg("stress-quantile", "0.8"));
const stressTailFrac = Number(arg("stress-tail", "0.2"));

// ------------------------------------------------ correlation-structure choice
// --corr-structure blocks --within-rho 0.7 --across-rho 0.2
// --structure-sweep independent,global,blocks,contagion
// A single global ρ says every name widens with every other name equally. That
// is one assumption among several; these flags let you re-estimate the joint
// drawdown tail under sector-clustered coupling, or under contagion where the
// clusters merge exactly when the tape is stressed.
const clusters = clusterMap(symbols);
const structureArgs = {
  rho: simCfg.rho,
  withinRho: argOrUndef("within-rho"),
  acrossRho: argOrUndef("across-rho"),
  stressWithinRho: argOrUndef("stress-within-rho"),
  stressAcrossRho: argOrUndef("stress-across-rho"),
  groups: clusters,
};
function argOrUndef(name: string): number | undefined {
  const v = arg(name, "");
  return v === "" ? undefined : Number(v);
}
const buildStructure = (kind: CorrelationStructureKind) =>
  makeCorrelationStructure({ ...structureArgs, kind });

const structureSweep = arg("structure-sweep", "")
  .split(",").map((s) => s.trim()).filter(Boolean) as CorrelationStructureKind[];
simCfg.structure = buildStructure(
  (arg("corr-structure", "global") as CorrelationStructureKind),
);

// ------------------------------------------------ calibrated coupling
// --calibrate-corr [blocks|contagion]
// Estimates ρ_within / ρ_across from the tape itself with a rolling window,
// split into calm and stressed windows, instead of taking them on faith.
const calibrateCorr = argv.includes("--calibrate-corr");
const calibKind = (arg("calibrate-corr", "contagion") as "blocks" | "contagion");
const calibOpts = {
  window: Number(arg("calib-window", "60")),
  step: Number(arg("calib-step", "5")),
  basis: arg("calib-basis", "absReturns") as "returns" | "absReturns",
  shrink: Number(arg("calib-shrink", "1")),
  stressZ: Number(arg("calib-stress-z", String(simCfg.volStressZ))),
  minStressShare: Number(arg("calib-min-stress", "0.25")),
  groups: clusters,
};

// Any of the three axes puts the run into the sweep report.
const sweepMode = rhoSweep.length > 0 || volZSweep.length > 0 || structureSweep.length > 0;



// --calib-diagnostics: how much to believe the calibrated coupling — rolling-fit
// stability, bootstrap confidence intervals (including the contagion test) and
// per-cluster-pair residual errors for the blocks and contagion structures.
const calibDiagnosticsMode = argv.includes("--calib-diagnostics");
const calibBootResamples = Number(arg("calib-resamples", "800"));

// --spillover: cluster × cluster coupling heatmap + leave-one-cluster-out tail
// attribution, i.e. which sectors drive the joint worst case under contagion.
const spilloverMode = process.argv.includes("--spillover");
const spilloverPaths = Number(arg("spillover-paths", String(Math.max(30, Math.round(paths / 4)))));


// --attribution: Shapley breakdown of the tail into slippage / fill-rate / stress.
const attributionMode = process.argv.includes("--attribution");
const attribPaths = Number(arg("attrib-paths", String(Math.max(30, Math.round(paths / 4)))));






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
  /** Orders filled passively (resting), i.e. without crossing the spread. */
  makerFills: number;
  /** Orders that had to cross. */
  takerFills: number;
  /** Fee + adverse-selection + waiting-drift cost, in currency. */
  driftCosts: number;
  /** True when the segment's max-drawdown trough bar was in the stress regime. */
  maxDdTroughStressed: boolean;
  /** % of bars in the peak→trough drawdown window that were stressed. */
  maxDdWindowStressShare: number;

};

type Ctx = {
  seriesBySymbol: Map<string, number[]>;
  /** Trailing realised volatility per symbol per bar, in bps. */
  volBpsBySymbol: Map<string, number[]>;
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
  /** null = every order crosses; otherwise orders rest first. */
  limit: LimitOrderSampler | null = null,
  /**
   * Channel mask for attribution runs. Disabling a channel neutralises its
   * *effect* without touching the RNG stream, so every ablation sees exactly
   * the same draws (common random numbers) and differences are causal.
   */
  mask: { slippage: boolean; fillRate: boolean } = { slippage: true, fillRate: true },
): SegmentResult {
  const { seriesBySymbol, costFor, volZ, volBpsBySymbol } = ctx;
  let cash = startingCash;
  const shares = new Map<string, number>();
  const equityCurve: number[] = [];
  /** Stress flag per equity-curve bar, so drawdowns can be attributed. */
  const stressedCurve: boolean[] = [];

  let fills = 0;
  let missedOrders = 0;
  let partialFills = 0;
  let costs = 0;
  let stressOrders = 0;
  let stressMissed = 0;
  let stressCosts = 0;
  let stressBars = 0;
  let makerFills = 0;
  let takerFills = 0;
  let driftCosts = 0;

  const marketDraw = (sym: string) => {
    // Symbol matters once the coupling assumption is clustered: the sampler
    // routes it to its sector factor.
    const d = sampler ? sampler.draw(sym) : DETERMINISTIC_DRAW;
    if (mask.slippage && mask.fillRate) return d;
    return {
      ...d,
      slippageMult: mask.slippage ? d.slippageMult : 1,
      fillRatio: mask.fillRate ? d.fillRatio : 1,
    };
  };

  // One order = one market-order draw, optionally routed through the passive
  // limit book first. `extraBps` is fee + adverse selection + waiting drift,
  // which the calibrated spread model does not know about.
  const order = (sym: string, i: number, forceTaker = false) => {
    const base = marketDraw(sym);

    if (!limit) return { ...base, extraBps: 0, liquidity: "taker" as const };
    const d = limit.draw({
      barVolBps: volBpsBySymbol.get(sym)?.[i] ?? 0,
      stressed: stressedBar,
      takerSlippageMult: base.slippageMult,
      takerFillRatio: base.fillRatio,
      forceTaker,
    });
    if (d.liquidity === "maker") makerFills++;
    else if (d.liquidity === "taker") takerFills++;
    return {
      slippageMult: d.slippageMult,
      fillRatio: d.fillRatio,
      extraBps: d.feeBps + d.driftBps,
      liquidity: d.liquidity,
    };
  };
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
      // Exits are risk-reducing: they rest, but they are not allowed to sit
      // forever, so they cross on timeout like a real stop-out would.
      const d = order(sym, i);
      if (stressedBar) stressOrders++;
      if (d.fillRatio <= 0) {
        missedOrders++;
        if (stressedBar) stressMissed++;
        continue;
      }
      const soldQty = qty * d.fillRatio;
      const notional = soldQty * priceAt(sym, i);
      const drift = notional * (d.extraBps / 10000);
      const c = costFor(sym, notional, d.slippageMult) + drift;
      driftCosts += drift;
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
        const d = order(sym, i);
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
        const drift = notional * (d.extraBps / 10000);
        const c = costFor(sym, notional, d.slippageMult) + drift;
        driftCosts += drift;
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
    stressedCurve.push(stressedBar);

  }

  let finalEquity = cash;
  for (const [sym, qty] of shares) {
    // End-of-segment liquidation is forced, so it always crosses.
    const d = order(sym, end, true);
    const notional = qty * priceAt(sym, end);
    finalEquity += notional - costFor(sym, notional, d.slippageMult) - notional * (d.extraBps / 10000);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) rets.push(equityCurve[i]! / equityCurve[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sd = Math.sqrt(varr);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;

  // Drawdown, plus where it happened: a trough reached while the tape is in
  // the correlated stress regime is an execution tail, not just a signal tail.
  let peak = -Infinity;
  let peakIdx = 0;
  let maxDd = 0;
  let ddPeakIdx = 0;
  let ddTroughIdx = 0;
  for (let i = 0; i < equityCurve.length; i++) {
    const e = equityCurve[i]!;
    if (e > peak) {
      peak = e;
      peakIdx = i;
    }
    const dd = e / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      ddPeakIdx = peakIdx;
      ddTroughIdx = i;
    }
  }
  let windowStressBars = 0;
  for (let i = ddPeakIdx; i <= ddTroughIdx && i < stressedCurve.length; i++) {
    if (stressedCurve[i]) windowStressBars++;
  }
  const windowLen = Math.max(1, ddTroughIdx - ddPeakIdx + 1);

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
    makerFills,
    takerFills,
    driftCosts,
    maxDdTroughStressed: stressedCurve[ddTroughIdx] === true,
    maxDdWindowStressShare: (windowStressBars / windowLen) * 100,

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

  if (calibrateCorr) {
    const cal = calibrateCorrelations(seriesBySymbol, { ...calibOpts, volZ });
    console.log("\nCalibrated coupling (rolling-window historical correlation)");
    console.log(describeCalibration(cal));
    // A short time series of the estimate: coupling is not a constant, and the
    // spread between these rows is the honest error bar on any single number.
    const tail = cal.windows.slice(-12);
    if (tail.length) {
      console.log(
        ["  bar".padStart(7), "within".padStart(8), "across".padStart(8), "stress%".padStart(9)].join(" "),
      );
      for (const w of tail) {
        console.log([
          String(w.endIndex).padStart(7),
          (Number.isFinite(w.withinRho) ? w.withinRho.toFixed(3) : "n/a").padStart(8),
          (Number.isFinite(w.acrossRho) ? w.acrossRho.toFixed(3) : "n/a").padStart(8),
          `${(w.stressShare * 100).toFixed(0)}%${w.stressed ? "*" : ""}`.padStart(9),
        ].join(" "));
      }
    }
    simCfg.structure = structureFromCalibration(cal, calibKind, clusters);
    console.log(`Using calibrated structure: ${describeStructure(simCfg.structure)}\n`);
  }
  const volBpsBySymbol = new Map<string, number[]>();
  for (const [sym, closes] of seriesBySymbol) volBpsBySymbol.set(sym, barVolBpsSeries(closes, 20));
  const ctx: Ctx = {
    seriesBySymbol,
    volBpsBySymbol,
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
    + `slippage ×${simCfg.stressSlippageMult} and no-fill ×${simCfg.stressNoFillMult} while stressed`,
  );
  if (execModel === "limit") {
    const medVolBps = (() => {
      const all = [...volBpsBySymbol.values()].flat().filter((v) => v > 0).sort((a, b) => a - b);
      return all.length ? all[Math.floor(all.length / 2)]! : 0;
    })();
    const odds = limitFillOdds(limitCfg, medVolBps);
    console.log(
      `Order model: LIMIT resting ${limitCfg.limitOffsetBps}bps behind the touch, `
      + `queue ${limitCfg.queueAheadRatio}× ahead vs ${limitCfg.queueTurnoverRatio}× turnover, `
      + `cross after ${limitCfg.crossAfterBars} bar(s). `
      + `At the median bar vol (${medVolBps.toFixed(0)}bps): `
      + `P(touch) ${(odds.pTouch * 100).toFixed(0)}% × P(queue) ${(odds.pQueue * 100).toFixed(0)}% `
      + `= ${(odds.pFill * 100).toFixed(0)}% passive fill odds/bar. `
      + `Maker ${limitCfg.makerFeeBps}bps / taker ${limitCfg.takerFeeBps}bps fees, `
      + `adverse selection ${limitCfg.adverseSelectionBeta}× bar vol.`,
    );
  } else {
    console.log("Order model: MARKET — every order crosses the spread immediately.");
  }
  console.log();

  // Tuning is deterministic (it never sees the random draws), so it is done
  // once per variant and reused by every sweep cell — otherwise the grid would
  // confound parameter drift with shock sensitivity.
  const tuneVariant = (variant: SmaVariant) =>
    folds.map((f) => {
      let best: SmaVariantParams = GRID[0]!;
      let bestScore = -Infinity;
      for (const p of GRID) {
        const r = simulate(ctx, variant, f.trainStart, f.trainEnd, p, null, null);
        const score = r.returnPct + r.sharpe * 5 + r.maxDrawdownPct * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      return best;
    });

  // ---------------------------------------------------- sector spillover mode
  // --spillover: two views of contagion. First the measured cluster × cluster
  // coupling (calm, stress, and the stress uplift), then a leave-one-cluster-
  // out simulation on common random numbers that says which of those clusters
  // actually pays for the joint drawdown tail.
  if (spilloverMode) {
    const spill = clusterSpilloverMatrix(seriesBySymbol, { ...calibOpts, volZ });
    console.log("Sector spillover — rolling-window coupling by cluster pair");
    console.log(
      `basis=${spill.basis} window=${spill.window} step=${spill.step} · `
      + `${spill.windows} windows (${spill.stressWindows} stressed)`,
    );
    for (const c of spill.clusters) {
      console.log(`  ${c.padEnd(12)} ${(spill.members.get(c) ?? []).join(" ")}`);
    }
    for (const layer of ["calm", "stress", "delta"] as const) {
      console.log();
      console.log(`${layer.toUpperCase()} coupling`);
      console.log(formatSpilloverHeatmap(spill, layer));
    }
    const top = topSpilloverPairs(spill, 8);
    if (top.length) {
      console.log("\nBiggest stress uplift (contagion channels):");
      for (const t of top) {
        console.log(
          `  ${`${t.a}↔${t.b}`.padEnd(26)} calm ${t.calm.toFixed(2)} → `
          + `stress ${t.stress.toFixed(2)}  (Δ ${t.delta >= 0 ? "+" : ""}${t.delta.toFixed(2)})`,
        );
      }
    }

    console.log(
      `\nTail contribution: leave-one-cluster-out · ${spilloverPaths} paths/ablation · `
      + `common random numbers · structure ${describeStructure(simCfg.structure!)}`,
    );

    const symbolsByCluster = new Map<string, string[]>();
    for (const [sym] of seriesBySymbol) {
      const g = clusters.get(sym) ?? "other";
      const list = symbolsByCluster.get(g) ?? [];
      list.push(sym);
      symbolsByCluster.set(g, list);
    }
    const clusterNames = [...symbolsByCluster.keys()].sort();

    type Tail = { retCvar: number; deepestP5: number; cost: number };
    const runPaths = (
      variant: SmaVariant,
      tuned: SmaVariantParams[],
      decoupledSymbols?: ReadonlySet<string>,
    ): Tail => {
      const cfg = decoupledSymbols ? { ...simCfg, decoupledSymbols } : simCfg;
      const rets: number[] = [];
      const dds: number[] = [];
      const costs: number[] = [];
      for (let pth = 0; pth < spilloverPaths; pth++) {
        const pathSeed = baseSeed + pth * 7919 + variant.length * 104729;
        const sampler = makeCorrelatedExecutionSampler(cfg, pathSeed);
        const limit = execModel === "limit"
          ? makeLimitOrderSampler(limitCfg, pathSeed ^ 0x5f3759df)
          : null;
        const foldRets: number[] = [];
        let deepest = 0;
        let cost = 0;
        for (let k = 0; k < folds.length; k++) {
          const f = folds[k]!;
          const r = simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, sampler, limit);
          foldRets.push(r.returnPct);
          if (r.maxDrawdownPct < deepest) deepest = r.maxDrawdownPct;
          cost += r.costs;
        }
        rets.push(meanOf(foldRets));
        dds.push(deepest);
        costs.push(cost / folds.length);
      }
      return {
        retCvar: percentileStats(rets).cvar5,
        deepestP5: percentileStats(dds).p5,
        cost: percentileStats(costs).mean,
      };
    };

    for (const variant of SMA_VARIANTS) {
      const tuned = tuneVariant(variant);
      const base = runPaths(variant, tuned);
      const ablations = clusterNames.map((name) => {
        const syms = symbolsByCluster.get(name)!;
        const out = runPaths(variant, tuned, new Set(syms));
        return { name, syms: syms.length, out };
      });

      console.log(`\n=== ${variant} ===`);
      console.log(formatTailContributions(
        clusterTailContributions(
          base.deepestP5,
          ablations.map((a) => ({ cluster: a.name, metric: a.out.deepestP5, symbols: a.syms })),
          "lowerIsWorse",
        ),
        { label: "  deepest drawdown p5 (joint worst case)", unit: "%", baseline: base.deepestP5 },
      ));
      console.log(formatTailContributions(
        clusterTailContributions(
          base.retCvar,
          ablations.map((a) => ({ cluster: a.name, metric: a.out.retCvar, symbols: a.syms })),
          "lowerIsWorse",
        ),
        { label: "  return CVaR5 (mean of worst 5% of lifetimes)", unit: "%", baseline: base.retCvar },
      ));
      console.log(formatTailContributions(
        clusterTailContributions(
          base.cost,
          ablations.map((a) => ({ cluster: a.name, metric: a.out.cost, symbols: a.syms })),
          "higherIsWorse",
        ),
        { label: "  mean execution cost per fold", unit: "", baseline: base.cost },
      ));
    }

    console.log("\nHow to read this: an ablation decouples one cluster from the market and");
    console.log("cluster shock factors and from the stress regime, on identical random draws.");
    console.log("'damage' is how much the joint tail improves once that cluster stops");
    console.log("co-moving, so a large share means the cluster is the contagion channel that");
    console.log("costs money — not merely the one with the highest correlation.");
    return;
  }

  // ------------------------------------------------ channel attribution mode
  // --attribution: run the 2^3 ablation lattice (slippage × fill-rate × stress)
  // on common random numbers and Shapley-split each tail metric, so the worst
  // case comes with a cause breakdown instead of just a number.
  if (attributionMode) {
    console.log(
      `Channel attribution: 2^${EXECUTION_CHANNELS.length} ablations `
      + `(${EXECUTION_CHANNELS.join(" × ")}) · ${attribPaths} paths/ablation · `
      + `common random numbers · breach threshold ${sweepThreshold}%`,
    );
    console.log();

    type PathMetrics = {
      ret: number[];
      worstFold: number[];
      deepestDd: number[];
      cost: number[];
    };

    const runAblation = (
      variant: SmaVariant,
      tuned: SmaVariantParams[],
      subset: readonly ExecutionChannel[],
    ): PathMetrics => {
      const on = new Set(subset);
      const mask = { slippage: on.has("slippage"), fillRate: on.has("fillRate") };
      // Stress is switched off by neutralising its multipliers, not by removing
      // the regime: the Markov chain still rolls and still consumes the same
      // random numbers, so all eight ablations stay perfectly paired.
      const cfg = on.has("stress")
        ? simCfg
        : {
          ...simCfg,
          stressSlippageMult: 1,
          stressSigmaMult: 1,
          stressNoFillMult: 1,
          stressFullFillMult: 1,
          volSlippageBeta: 0,
        };
      const out: PathMetrics = { ret: [], worstFold: [], deepestDd: [], cost: [] };
      for (let pth = 0; pth < attribPaths; pth++) {
        const pathSeed = baseSeed + pth * 7919 + variant.length * 104729;
        const sampler = makeCorrelatedExecutionSampler(cfg, pathSeed);
        const limit = execModel === "limit"
          ? makeLimitOrderSampler(limitCfg, pathSeed ^ 0x5f3759df)
          : null;
        const rets: number[] = [];
        let worstFold = Infinity;
        let deepestDd = 0;
        let costSum = 0;
        for (let k = 0; k < folds.length; k++) {
          const f = folds[k]!;
          const r = simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, sampler, limit, mask);
          rets.push(r.returnPct);
          worstFold = Math.min(worstFold, r.returnPct);
          if (r.maxDrawdownPct < deepestDd) deepestDd = r.maxDrawdownPct;
          costSum += r.costs;
        }
        out.ret.push(meanOf(rets));
        out.worstFold.push(worstFold);
        out.deepestDd.push(deepestDd);
        out.cost.push(costSum / folds.length);
      }
      return out;
    };

    // Every metric is oriented so that "more damage" is a more negative number,
    // except cost and breach probability which are damage-positive; the sign is
    // handled in the label rather than the maths.
    const METRICS: Array<{
      label: string;
      unit: string;
      of: (m: PathMetrics) => number;
    }> = [
      { label: "p5 return", unit: "%/fold", of: (m) => percentileStats(m.ret).p5 },
      { label: "CVaR5 return", unit: "%/fold", of: (m) => percentileStats(m.ret).cvar5 },
      { label: "median return", unit: "%/fold", of: (m) => percentileStats(m.ret).median },
      { label: "CVaR5 worst fold", unit: "%", of: (m) => percentileStats(m.worstFold).cvar5 },
      { label: "worst deepest DD", unit: "%", of: (m) => percentileStats(m.deepestDd).worst },
      { label: "p5 deepest DD", unit: "%", of: (m) => percentileStats(m.deepestDd).p5 },
      {
        label: `P(DD≥${sweepThreshold}%)`,
        unit: "pp",
        of: (m) => drawdownBreachProbabilities(m.deepestDd, [sweepThreshold])[0]!.prob * 100,
      },
      { label: "cost/fold", unit: "£", of: (m) => percentileStats(m.cost).median },
    ];

    const header = [
      "metric".padEnd(18),
      "no shocks".padStart(10),
      "full".padStart(9),
      "total".padStart(9),
      "slippage".padStart(20),
      "fill-rate".padStart(20),
      "stress".padStart(20),
      "interact".padStart(9),
    ].join(" ");

    for (const variant of SMA_VARIANTS) {
      const tuned = tuneVariant(variant);
      // Run each ablation once and reuse it for every metric.
      const byKey = new Map<string, PathMetrics>();
      for (const subset of channelSubsets()) {
        byKey.set(subsetKey(subset), runAblation(variant, tuned, subset));
      }

      console.log(`=== ${variant} ===`);
      console.log(header);
      console.log("-".repeat(header.length));
      for (const metric of METRICS) {
        const a = shapleyAttribution((_subset, key) => metric.of(byKey.get(key)!));
        const cell = (c: (typeof a.contributions)[number]) =>
          `${fmt(c.shapley).padStart(8)} (${(c.share * 100).toFixed(0).padStart(4)}%)`
            .padStart(20);
        console.log([
          `${metric.label} ${metric.unit}`.padEnd(18),
          fmt(a.baseline).padStart(10),
          fmt(a.full).padStart(9),
          fmt(a.total).padStart(9),
          ...a.contributions.map(cell),
          fmt(a.interaction).padStart(9),
        ].join(" "));
      }
      console.log();
    }

    console.log("Reading: 'no shocks' is the metric with perfect execution; 'full' is the same");
    console.log("metric with all three channels live. 'total' is the damage being split, and the");
    console.log("three channel columns are Shapley shares that add back to it exactly.");
    console.log("slippage = you traded at a worse price · fill-rate = you did not get the size");
    console.log("(or missed the trade entirely) · stress = the correlated regime amplifying both.");
    console.log("'interact' is total minus the sum of solo effects: negative on a return metric");
    console.log("means the channels compound — the joint tail is worse than the parts summed.");
    console.log("Stress cannot act alone, so its solo effect is ~0 while its Shapley share is not:");
    console.log("that gap is exactly the amplification it lends to the other two.");
    return;
  }


  if (sweepMode) {
    const rhos = rhoSweep.length ? rhoSweep : [simCfg.rho];
    const zs = volZSweep.length ? volZSweep : [simCfg.volStressZ];
    // Each structure is a different answer to "what couples with what?".
    // Sweeping them shows how much of the joint tail is the coupling assumption.
    const structs: CorrelationStructure[] = structureSweep.length
      ? structureSweep.map(buildStructure)
      : [simCfg.structure!];
    console.log(
      `Sensitivity sweep: ρ ∈ {${rhos.join(", ")}} × vol-z trigger ∈ {${zs.join(", ")}} `
      + `× structure ∈ {${structs.map((s) => s.kind).join(", ")}} `
      + `· ${sweepPaths} paths/cell · headline breach threshold ${sweepThreshold}%`,
    );
    for (const s of structs) console.log(`  · ${describeStructure(s)}`);
    console.log();

    for (const variant of SMA_VARIANTS) {
      const tuned = tuneVariant(variant);
      console.log(`=== ${variant} ===`);
      const header = [
        "structure".padEnd(12),
        "rho".padStart(5),
        "volZ".padStart(6),
        "med ret%".padStart(9),
        "p5 ret%".padStart(9),
        "med DD%".padStart(9),
        "p5 DD%".padStart(9),
        "worstDD%".padStart(9),
        `P(DD≥${sweepThreshold}%)`.padStart(11),
        "∧stress".padStart(9),
        "cCVaR%".padStart(9),
        "stress%".padStart(8),
        "cost£".padStart(9),

      ].join(" ");
      console.log(header);
      console.log("-".repeat(header.length));

      for (const structure of structs) {
      for (const rho of rhos) {
        for (const z of zs) {
          // A bare --rho-sweep still means the global structure: rebuild the
          // structure at this ρ so the sweep axis actually bites.
          const cfg = {
            ...simCfg,
            rho,
            volStressZ: z,
            structure: rhoSweep.length && structure.kind === "global"
              ? makeCorrelationStructure({ kind: "global", rho })
              : structure,
          };

          const pathRet: number[] = [];
          const pathDeepestDd: number[] = [];
          /** Did the path's deepest drawdown happen inside the stress regime? */
          const pathDeepestInStress: boolean[] = [];
          const pathStressShare: number[] = [];
          const pathCosts: number[] = [];
          let stressBars = 0;
          let allBars = 0;

          for (let pth = 0; pth < sweepPaths; pth++) {
            const pathSeed = baseSeed + pth * 7919 + variant.length * 104729;
            const sampler = makeCorrelatedExecutionSampler(cfg, pathSeed);
            const limit = execModel === "limit"
              ? makeLimitOrderSampler(limitCfg, pathSeed ^ 0x5f3759df)
              : null;
            const rets: number[] = [];
            let deepestDd = 0;
            let deepestInStress = false;
            let costSum = 0;
            let stressCostSum = 0;
            for (let k = 0; k < folds.length; k++) {
              const f = folds[k]!;
              const r = simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, sampler, limit);
              rets.push(r.returnPct);
              if (r.maxDrawdownPct < deepestDd) {
                deepestDd = r.maxDrawdownPct;
                deepestInStress = r.maxDdTroughStressed || r.maxDdWindowStressShare > 0;
              }
              costSum += r.costs;
              stressCostSum += r.stressCosts;
              stressBars += r.stressBars;
              allBars += f.testEnd - f.testStart + 1;
            }
            pathRet.push(meanOf(rets));
            pathDeepestDd.push(deepestDd);
            pathDeepestInStress.push(deepestInStress);
            pathCosts.push(costSum / folds.length);
            pathStressShare.push(costSum > 0 ? (stressCostSum / costSum) * 100 : 0);
          }

          const ret = percentileStats(pathRet);
          const deep = percentileStats(pathDeepestDd);
          const cost = percentileStats(pathCosts);
          const stress = percentileStats(pathStressShare);
          const breach = jointDrawdownBreachProbabilities(
            pathDeepestDd, pathDeepestInStress, [sweepThreshold])[0]!;
          // Conditional CVaR: the average bad year *given* the tape was one of
          // the worst-stress 20% of paths.
          const condRet = conditionalTailStats(pathRet, pathStressShare, stressQuantile, stressTailFrac);
          console.log([
            structure.kind.padEnd(12),
            fmt(rho, 2).padStart(5),
            fmt(z, 2).padStart(6),
            fmt(ret.median).padStart(9),
            fmt(ret.p5).padStart(9),
            fmt(deep.median).padStart(9),
            fmt(deep.p5).padStart(9),
            fmt(deep.worst).padStart(9),
            `${(breach.prob * 100).toFixed(1)}%`.padStart(11),
            `${(breach.jointProb * 100).toFixed(1)}%`.padStart(9),
            fmt(condRet.cvar).padStart(9),
            fmt(stress.median, 1).padStart(8),
            fmt(cost.median, 0).padStart(9),
          ].join(" "));
        }
      }
      }
      console.log();
    }

    console.log("'structure' is the coupling assumption: independent = no cross-symbol link,");
    console.log("global = one ρ for every pair, blocks = ρ within a sector cluster and a lower ρ");
    console.log("across clusters, contagion = blocks in calm that converge toward 1 under stress.");



    console.log("Reading: each row is one joint-risk assumption. ρ controls how much every");
    console.log("symbol's slippage moves together; the vol-z trigger is how readily a volatile");
    console.log("tape is treated as a stress regime (lower z = more stressed bars, z=99 = off).");
    console.log("'p5 DD%' and 'worstDD%' are the joint worst cases: read across a row to see");
    console.log("how much of your drawdown budget is an assumption rather than a measurement.");
    console.log("'∧stress' is P(breach AND the drawdown ran through stressed bars) — the part");
    console.log(`of the tail you cannot trade out of. 'cCVaR%' is the mean return of the worst`);
    console.log(`${(stressTailFrac * 100).toFixed(0)}% of paths within the worst-stress `
      + `${((1 - stressQuantile) * 100).toFixed(0)}% of paths.`);

    return;
  }
  for (const variant of SMA_VARIANTS) {
    // 1. Tune on TRAIN with deterministic execution (the strategy cannot know
    //    which fills will go badly, so it must not be tuned against them).
    const tuned = tuneVariant(variant);


    // 2. Deterministic OOS baseline.
    const detFolds = folds.map((f, k) =>
      simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, null, null));
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
    /** Whether each path's deepest drawdown ran through the stress regime. */
    const pathDeepestInStress: boolean[] = [];

    // Passive-execution accounting across all paths.
    let makerFills = 0;
    let takerFills = 0;
    let queueMisses = 0;
    let neverTouched = 0;
    let limitOrders = 0;
    let waitBars = 0;
    const pathDriftShare: number[] = [];

    for (let pth = 0; pth < paths; pth++) {
      const pathSeed = baseSeed + pth * 7919 + variant.length * 104729;
      const sampler = makeCorrelatedExecutionSampler(simCfg, pathSeed);
      // Independent stream for the book so limit-order luck is not aliased to
      // slippage luck within a path.
      const limit = execModel === "limit"
        ? makeLimitOrderSampler(limitCfg, pathSeed ^ 0x5f3759df)
        : null;
      const rets: number[] = [];
      let worstFold = Infinity;
      let ddSum = 0;
      let deepestDd = 0;
      let deepestInStress = false;
      let shSum = 0;
      let costSum = 0;
      let stressCostSum = 0;
      let driftSum = 0;
      for (let k = 0; k < folds.length; k++) {
        const f = folds[k]!;
        const r = simulate(ctx, variant, f.testStart, f.testEnd, tuned[k]!, sampler, limit);
        rets.push(r.returnPct);
        worstFold = Math.min(worstFold, r.returnPct);
        ddSum += r.maxDrawdownPct;
        if (r.maxDrawdownPct < deepestDd) {
          deepestDd = r.maxDrawdownPct;
          // "In stress" = the trough bar was stressed, or the peak→trough slide
          // ran through stressed bars at all.
          deepestInStress = r.maxDdTroughStressed || r.maxDdWindowStressShare > 0;
        }

        shSum += r.sharpe;
        costSum += r.costs;
        stressCostSum += r.stressCosts;
        driftSum += r.driftCosts;
        missed += r.missedOrders;
        partial += r.partialFills;
        totalOrders += r.fills + r.missedOrders;
        stressOrders += r.stressOrders;
        stressMissed += r.stressMissed;
        stressBars += r.stressBars;
        allBars += f.testEnd - f.testStart + 1;
      }
      if (limit) {
        const ls = limit.stats();
        makerFills += ls.makerFills;
        takerFills += ls.takerFills;
        queueMisses += ls.queueMisses;
        neverTouched += ls.neverTouched;
        limitOrders += ls.orders;
        waitBars += ls.totalWaitBars;
      }
      pathDriftShare.push(costSum > 0 ? (driftSum / costSum) * 100 : 0);
      pathStressCostShare.push(costSum > 0 ? (stressCostSum / costSum) * 100 : 0);
      pathMeanRet.push(meanOf(rets));
      pathWorstFold.push(worstFold);
      pathMaxDd.push(ddSum / folds.length);
      pathDeepestDd.push(deepestDd);
      pathDeepestInStress.push(deepestInStress);
      pathSharpe.push(shSum / folds.length);
      pathCosts.push(costSum / folds.length);
    }

    const ret = percentileStats(pathMeanRet);
    const worst = percentileStats(pathWorstFold);
    const dd = percentileStats(pathMaxDd);
    const deepDd = percentileStats(pathDeepestDd);
    const breaches = jointDrawdownBreachProbabilities(
      pathDeepestDd, pathDeepestInStress, ddThresholds);
    const sh = percentileStats(pathSharpe);
    const cost = percentileStats(pathCosts);
    const stressShare = percentileStats(pathStressCostShare);
    const driftShare = percentileStats(pathDriftShare);
    // Conditional tails on the worst-stress paths: the outcome distribution
    // given the tape actually turned ugly, rather than averaged over calm ones.
    const condRet = conditionalTailStats(
      pathMeanRet, pathStressCostShare, stressQuantile, stressTailFrac);
    const condWorstFold = conditionalTailStats(
      pathWorstFold, pathStressCostShare, stressQuantile, stressTailFrac);
    const condDd = conditionalTailStats(
      pathDeepestDd, pathStressCostShare, stressQuantile, stressTailFrac);


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
    if (execModel === "limit") {
      console.log(statLine("fee+drift %", driftShare));
      console.log(
        `book: ${((makerFills / Math.max(1, limitOrders)) * 100).toFixed(1)}% passive fills · `
        + `${((takerFills / Math.max(1, limitOrders)) * 100).toFixed(1)}% crossed · `
        + `queue misses ${((queueMisses / Math.max(1, limitOrders)) * 100).toFixed(1)}% · `
        + `never touched ${((neverTouched / Math.max(1, limitOrders)) * 100).toFixed(1)}% · `
        + `avg wait ${(waitBars / Math.max(1, limitOrders)).toFixed(2)} bars`,
      );
    }
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
    console.log(
      "P(breach ≥ X ∧ in stress): "
      + breaches
        .map((b) => `${b.thresholdPct}% ${(b.jointProb * 100).toFixed(1)}%`
          + ` [${Number.isFinite(b.probStressGivenBreach)
            ? (b.probStressGivenBreach * 100).toFixed(0)
            : "n/a"}% of breaches]`)
        .join("  ·  "),
    );
    console.log(
      `worst-stress ${((1 - stressQuantile) * 100).toFixed(0)}% of paths `
      + `(cost-in-stress ≥ ${condRet.cutoff.toFixed(1)}%, n=${condRet.count}): `
      + `return median ${fmt(condRet.median)}% vs ${fmt(ret.median)}% overall · `
      + `conditional CVaR${(stressTailFrac * 100).toFixed(0)} ${fmt(condRet.cvar)}% `
      + `(unconditional CVaR5 ${fmt(ret.cvar5)}%) · `
      + `worst fold CVaR ${fmt(condWorstFold.cvar)}% · `
      + `deepest DD CVaR ${fmt(condDd.cvar)}% (worst ${fmt(condDd.worst)}%)`,
    );
    console.log();
  }

  console.log("Reading: 'return %/fold' percentiles are over whole strategy lifetimes.");
  console.log("p5 is the 1-in-20 bad-execution-luck year; CVaR5 is the average of those.");
  console.log("'deepest DD %' is the worst single fold on each path; the breach line reads");
  console.log("as the chance a lifetime touches that drawdown depth at least once.");
  if (execModel === "limit") {
    console.log("'fee+drift %' is the share of cost that is NOT spread: maker/taker fees plus");
    console.log("adverse selection and waiting drift — the price of resting instead of crossing.");
  }
  console.log("Shocks are correlated: on a stressed bar every symbol widens and every order");
  console.log("struggles together, so these tails are joint outcomes, not averaged-away ones.");
  console.log("The joint line splits each breach into the part that happened while the tape was");
  console.log("stressed — that share is execution risk you cannot trade out of; the rest is signal.");
  console.log("The worst-stress line conditions on the ugliest tapes instead of averaging them in:");
  console.log("it is the drawdown budget you need when the stress regime shows up, not on average.");

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
