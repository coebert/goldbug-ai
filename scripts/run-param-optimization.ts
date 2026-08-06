// Constrained parameter optimisation: maximise net CAGR under realistic costs
// while capping turnover and enforcing no-leverage / no-borrow / no-short.
//
//   bun run scripts/run-param-optimization.ts
//   bun run scripts/run-param-optimization.ts --style swing --max-turnover 80
//   bun run scripts/run-param-optimization.ts --folds 3 --limit 120 --risk balanced
//
// Runs the real market tape, splits it into walk-forward folds, evaluates each
// candidate on every fold, ranks by mean net CAGR, and reports the frontier
// plus per-axis marginal impact. Candidates that borrow, short, or lever are
// disqualified outright rather than penalised.

import { parseRiskConfig } from "../src/lib/universe.server";
import {
  runStyleBacktest,
  ENTRY_SLEEVE,
  type StyleTradeRow,
} from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import {
  applyParams,
  averageMetrics,
  axisImpact,
  bestFeasible,
  formatParams,
  formatResult,
  paretoFrontier,
  rankResults,
  sampleGrid,
  scoreAll,
  type CandidateMetrics,
  type OptimizerConstraints,
  type ParamAxis,
} from "../src/lib/param-optimizer";
import type { EquityPoint } from "../src/lib/backtest-metrics";
import { renderBacktestReportHtml, type ReportPanel } from "../src/lib/backtest-report-chart";
import type { RiskLevel } from "../src/lib/risk-sim-matrix";
import type { TradingStyle } from "../src/lib/trading-style";
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "SPY", "GLD"];

const from = arg("from", "2018-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const mode = arg("mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const riskLevel = arg("risk", "balanced") as RiskLevel;
const style = arg("style", "swing") as TradingStyle;
const folds = Number(arg("folds", "3"));
const limit = Number(arg("limit", "96"));
const seed = Number(arg("seed", "20260806"));
const maxTurnover = Number(arg("max-turnover", "120"));
const maxDrawdown = Number(arg("max-dd", "30"));
const minTrades = Number(arg("min-trades", "10"));

// Realistic Saxo-like retail execution costs. The objective is CAGR *after*
// these, so the optimiser pays for every trade it proposes.
const FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

// Search space: the knobs that actually move net CAGR and turnover.
const AXES: ParamAxis[] = [
  { key: "stop_loss_pct", values: [0.06, 0.10, 0.14] },
  { key: "take_profit_pct", values: [0.12, 0.20, 0.30] },
  { key: "time_stop_horizon_days", values: [20, 40, 60] },
  { key: "chandelier_k_base", values: [3.0, 4.0, 5.0] },
  { key: "max_names", values: [4, 6, 8] },
  { key: "per_name_weight", values: [0.12, 0.18, 0.24] },
  // Turnover levers — without these the constraint is unreachable.
  { key: "swing_min_hold_days", values: [2, 5, 10] },
  { key: "reentry_min_days", values: [5, 15, 30] },
  { key: "scale_out_enabled", values: [false, true] },
];


const constraints: OptimizerConstraints = {
  maxTradesPerYear: maxTurnover,
  maxDrawdownPct: maxDrawdown,
  minTrades,
  enforceNoLeverage: true,
};

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);
if (tape.bars.length < 120) throw new Error("Not enough bars for a walk-forward optimisation.");

// Walk-forward folds: contiguous, non-overlapping slices in time order.
const foldSize = Math.floor(tape.bars.length / folds);
const foldBars = Array.from({ length: folds }, (_, i) =>
  tape.bars.slice(i * foldSize, i === folds - 1 ? tape.bars.length : (i + 1) * foldSize),
).filter((b) => b.length >= 60);
console.log(`Walk-forward: ${foldBars.length} folds of ~${foldSize} bars.`);

const candidates = sampleGrid(AXES, limit, seed);
console.log(`Evaluating ${candidates.length} candidates × ${foldBars.length} folds…\n`);

const baseCfg = parseRiskConfig({ trading_style: style } as never);
const baseSleeve = ENTRY_SLEEVE[riskLevel];

type Evaluated = { params: (typeof candidates)[number]; metrics: CandidateMetrics };
const evaluated: Evaluated[] = [];
const curves = new Map<string, EquityPoint[]>();
const tradeLogs = new Map<string, StyleTradeRow[]>();

for (const [i, params] of candidates.entries()) {
  const { cfg, sleeve } = applyParams(baseCfg, baseSleeve, params);
  const perFold: CandidateMetrics[] = [];
  const foldCurves: EquityPoint[][] = [];
  let firstLog: StyleTradeRow[] = [];
  for (const bars of foldBars) {
    const m = await runStyleBacktest({
      cfg,
      bars,
      riskLevel,
      startingCash,
      feePerTrade: 0,
      sleeve,
      simulator: { frictions: FRICTIONS },
    });
    perFold.push({
      cagrPct: m.cagrPct,
      totalReturnPct: m.totalReturnPct,
      maxDrawdownPct: m.maxDrawdownPct,
      sharpe: m.sharpe,
      trades: m.trades,
      tradesPerYear: m.tradesPerYear,
      feeDragPct: m.feeDragPct,
      finalCashPct: m.finalCashPct,
      ...(m.audit ? { audit: m.audit } : {}),
    });
    foldCurves.push(m.equityCurve);
    if (firstLog.length === 0) firstLog = m.tradeLog;
  }
  const metrics = averageMetrics(perFold);
  evaluated.push({ params, metrics });
  const key = formatParams(params);
  curves.set(key, foldCurves.flat());
  tradeLogs.set(key, firstLog);

  if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
    console.log(`  …${i + 1}/${candidates.length} evaluated`);
  }
}

// ------------------------------------------------------------------ rank
const scored = scoreAll(evaluated, constraints);
const ranked = rankResults(scored);
const winner = bestFeasible(scored);
const disqualified = scored.filter((r) => r.check.disqualified);

console.log(
  `\nConstraints: turnover ≤ ${maxTurnover}/yr, |drawdown| ≤ ${maxDrawdown}%, ` +
    `≥ ${minTrades} trades, no borrow / short / leverage.`,
);
console.log(`Feasible: ${scored.filter((r) => r.check.feasible).length}/${scored.length}` +
  `  ·  disqualified for leverage/borrow: ${disqualified.length}`);

console.log("\nTop 10 by mean net CAGR:");
for (const r of ranked.slice(0, 10)) console.log(`  ${formatResult(r)}`);

if (winner) {
  console.log(`\nBest feasible configuration:\n  ${formatResult(winner)}`);
} else {
  console.log("\nNo candidate satisfied every constraint — loosen the turnover or drawdown cap.");
}

// -------------------------------------------------------- axis sensitivity
console.log("\nMarginal impact per axis (mean net CAGR by level):");
const impacts = AXES.map((a) => axisImpact(scored, a.key));
for (const im of impacts) {
  const levels = im.levels
    .map((l) => `${l.value}: ${l.meanCagrPct.toFixed(2)}%`)
    .join("  ");
  console.log(
    `  ${im.key.padEnd(24)} spread ${im.spreadPct.toFixed(2).padStart(5)}pp  best ${String(im.bestValue).padEnd(6)} | ${levels}`,
  );
}

// ------------------------------------------------- turnover attribution
// Which knobs actually drive trading frequency, what churn costs on this tape,
// and how quickly the strategy re-enters names it just exited.
const drivers = rankTurnoverDrivers(scored, AXES.map((a) => a.key));
const costCurve = turnoverCostCurve(scored);
const logOf = (r: (typeof scored)[number]) => tradeLogs.get(formatParams(r.params)) ?? [];
const reentryDriverKey = drivers.find((d) => d.key === "reentry_min_days")?.key ?? drivers[0]?.key;
const reentryLevels = reentryDriverKey
  ? reentryByLevel(scored, reentryDriverKey, logOf, { fastDays: 5 })
  : [];
const overallReentry = reentryProfile(scored.flatMap((r) => logOf(r)), { fastDays: 5 });

console.log("\nTurnover attribution (what drives trading frequency):");
for (const d of drivers) console.log(`  ${describeDriver(d)}`);
console.log(
  `\nCost of churn: ${costCurve.cagrPerTrade >= 0 ? "+" : ""}${costCurve.cagrPerTrade.toFixed(3)}pp net CAGR ` +
    `and ${costCurve.feeDragPerTrade >= 0 ? "+" : ""}${costCurve.feeDragPerTrade.toFixed(3)}pp fees per extra trade/yr` +
    (costCurve.breakevenTradesPerYear !== null
      ? `  ·  fitted breakeven ≈ ${costCurve.breakevenTradesPerYear.toFixed(0)} trades/yr`
      : "  ·  no fitted breakeven"),
);
console.log(
  `Re-entry: ${(overallReentry.reentryRate * 100).toFixed(0)}% of exits re-bought, ` +
    `median gap ${overallReentry.medianGapDays.toFixed(0)}d, ` +
    `${(overallReentry.fastReentryShare * 100).toFixed(0)}% within ${overallReentry.fastDays}d, ` +
    `${overallReentry.roundTripsPerSymbol.toFixed(1)} round trips/symbol`,
);

const frontier = paretoFrontier(scored);

console.log("\nCAGR vs turnover frontier:");
for (const r of frontier) {
  console.log(
    `  ${r.metrics.tradesPerYear.toFixed(0).padStart(4)}/yr  ` +
      `CAGR ${r.metrics.cagrPct.toFixed(2).padStart(6)}%  ${formatParams(r.params)}`,
  );
}

// ---------------------------------------------------------------- report
const COLOURS = ["#39d98a", "#4ea1ff", "#f5a623", "#e5484d", "#a78bfa", "#9aa4b2"];
const panels: ReportPanel[] = [
  {
    heading: "Best configurations (net of realistic costs)",
    subtitle:
      `${style} · ${riskLevel} · ${foldBars.length} walk-forward folds · ` +
      `objective: mean net CAGR · turnover ≤ ${maxTurnover}/yr · no leverage`,
    series: [],
    table: {
      columns: ["rank", "CAGR %", "DD %", "sharpe", "turnover/yr", "fees %", "cash %", "status", "params"],
      rows: ranked.slice(0, 15).map((r, i) => [
        String(i + 1),
        r.metrics.cagrPct.toFixed(2),
        r.metrics.maxDrawdownPct.toFixed(1),
        r.metrics.sharpe.toFixed(2),
        r.metrics.tradesPerYear.toFixed(0),
        r.metrics.feeDragPct.toFixed(1),
        r.metrics.finalCashPct.toFixed(0),
        r.check.disqualified ? "disqualified" : r.check.feasible ? "ok" : r.check.violations.join("; "),
        formatParams(r.params),
      ]),
    },
  },
  {
    heading: "Parameter sensitivity",
    subtitle: "mean net CAGR by level; a small spread means the axis can be frozen",
    series: [],
    table: {
      columns: ["parameter", "best level", "spread (pp)", "levels"],
      rows: impacts.map((im) => [
        im.key,
        String(im.bestValue),
        im.spreadPct.toFixed(2),
        im.levels.map((l) => `${l.value}→${l.meanCagrPct.toFixed(2)}%`).join(", "),
      ]),
    },
  },
  {
    heading: "CAGR vs turnover frontier",
    subtitle: "non-dominated configurations: no cheaper config earns more",
    series: [],
    table: {
      columns: ["turnover/yr", "CAGR %", "DD %", "fees %", "params"],
      rows: frontier.map((r) => [
        r.metrics.tradesPerYear.toFixed(0),
        r.metrics.cagrPct.toFixed(2),
        r.metrics.maxDrawdownPct.toFixed(1),
        r.metrics.feeDragPct.toFixed(1),
        formatParams(r.params),
      ]),
    },
  },
];

const topCurves = ranked.filter((r) => !r.check.disqualified).slice(0, 5);
panels.push({
  heading: "Equity curves — top 5 configurations",
  subtitle: "walk-forward folds concatenated; each fold restarts from the same cash",
  series: topCurves.map((r, i) => ({
    label: `#${i + 1} CAGR ${r.metrics.cagrPct.toFixed(1)}%`,
    colour: COLOURS[i % COLOURS.length]!,
    curve: curves.get(formatParams(r.params)) ?? [],
    trades: tradeLogs.get(formatParams(r.params)) ?? [],
  })),
});

mkdirSync("reports", { recursive: true });
writeFileSync(
  "reports/param-optimization.html",
  renderBacktestReportHtml({
    title: "Aegis — constrained parameter optimisation",
    subtitle:
      `${symbols.length} symbols · ${tape.bars.length} bars · ${candidates.length} candidates · ` +
      `net of ${FRICTIONS.commissionBps}bps + $${FRICTIONS.minCommission} commission and ${FRICTIONS.slippageBps}bps slippage`,
    panels,
  }),
);
console.log("\nWrote reports/param-optimization.html");
