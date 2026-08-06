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
import {
  describeDriver,
  rankTurnoverDrivers,
  reentryByLevel,
  reentryProfile,
  turnoverCostCurve,
} from "../src/lib/turnover-attribution";
import {
  buildViabilityReport,
  describeRiskLevelViability,
  VERDICT_LABEL,
  type ViabilityRow,
} from "../src/lib/viability-threshold";

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
// `--risk balanced` optimises one level; `--risk low,balanced,high` also runs
// the viability threshold check at every level (costs one full pass each).
const riskLevels = arg("risk", "balanced")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as RiskLevel[];
const riskLevel = riskLevels[0] ?? ("balanced" as RiskLevel);

const style = arg("style", "swing") as TradingStyle;
const folds = Number(arg("folds", "3"));
const limit = Number(arg("limit", "96"));
const seed = Number(arg("seed", "20260806"));
const maxTurnover = Number(arg("max-turnover", "120"));
const maxDrawdown = Number(arg("max-dd", "30"));
const minTrades = Number(arg("min-trades", "10"));
// Minimum net CAGR (after costs) a configuration must clear to count as viable.
const minViableCagr = Number(arg("min-viable-cagr", "0"));


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

type Evaluated = { params: (typeof candidates)[number]; metrics: CandidateMetrics };
const evaluated: Evaluated[] = [];
const curves = new Map<string, EquityPoint[]>();
const tradeLogs = new Map<string, StyleTradeRow[]>();
// Every risk level evaluated, for the viability threshold check. The primary
// level also feeds ranking, sensitivity and the equity curves.
const evaluatedByRisk = new Map<RiskLevel, Evaluated[]>();

for (const rl of riskLevels) {
  const baseSleeve = ENTRY_SLEEVE[rl];
  const rows: Evaluated[] = [];
  if (riskLevels.length > 1) console.log(`Risk level: ${rl}`);

  for (const [i, params] of candidates.entries()) {
    const { cfg, sleeve } = applyParams(baseCfg, baseSleeve, params);
    const perFold: CandidateMetrics[] = [];
    const foldCurves: EquityPoint[][] = [];
    let firstLog: StyleTradeRow[] = [];
    for (const bars of foldBars) {
      const m = await runStyleBacktest({
        cfg,
        bars,
        riskLevel: rl,
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
    rows.push({ params, metrics });
    if (rl === riskLevel) {
      evaluated.push({ params, metrics });
      const key = formatParams(params);
      curves.set(key, foldCurves.flat());
      tradeLogs.set(key, firstLog);
    }

    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
      console.log(`  …${i + 1}/${candidates.length} evaluated`);
    }
  }
  evaluatedByRisk.set(rl, rows);
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

// -------------------------------------------------- viability thresholds
// Fit the turnover breakeven at each risk level and flag every configuration
// that trades past it or fails to clear the minimum net return after costs.
const viabilityRows: ViabilityRow[] = [];
for (const [rl, rows] of evaluatedByRisk) {
  const rlScored = scoreAll(rows, constraints);
  for (const r of rlScored) {
    viabilityRows.push({
      id: formatParams(r.params),
      riskLevel: rl,
      params: r.params,
      metrics: {
        tradesPerYear: r.metrics.tradesPerYear,
        cagrPct: r.metrics.cagrPct,
        feeDragPct: r.metrics.feeDragPct,
        maxDrawdownPct: r.metrics.maxDrawdownPct,
        sharpe: r.metrics.sharpe,
      },
      check: { feasible: r.check.feasible, disqualified: r.check.disqualified },
    });
  }
}
const viability = buildViabilityReport(viabilityRows, {
  minCagrPct: minViableCagr,
  marginalBand: 0.1,
});

console.log(`\nViability thresholds (min net CAGR ${minViableCagr.toFixed(2)}%):`);
for (const lvl of viability.levels) console.log(`  ${describeRiskLevelViability(lvl)}`);
console.log(
  `  ${viability.totalFlagged}/${viability.totalAssessed} configurations flagged` +
    (viability.universallyBelow.length
      ? `  ·  ${viability.universallyBelow.length} below breakeven at every risk level`
      : ""),
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
// Report filter tags: every row carrying a parameter set is tagged with its
// risk level and its per-name ticket size, so the HTML toolbar can narrow the
// tables to one scenario without re-running the sweep.
const ticketGbp = (params: { [k: string]: unknown }): number =>
  Math.round(Number(params["per_name_weight"] ?? 0) * startingCash);
const ticketValue = (params: { [k: string]: unknown }): string => String(ticketGbp(params));
const ticketLabel = (v: number): string =>
  v >= 1000 ? `£${(v / 1000).toFixed(1).replace(/\.0$/, "")}k` : `£${v}`;
const paramTags = (params: { [k: string]: unknown }, rl: string) => ({
  risk: rl,
  ticket: ticketValue(params),
});
const ticketOptions = [
  ...new Set(
    (AXES.find((a) => a.key === "per_name_weight")?.values ?? []).map((w) =>
      Math.round(Number(w) * startingCash),
    ),
  ),
]
  .sort((a, b) => a - b)
  .map((v) => ({ value: String(v), label: ticketLabel(v) }));

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
      rows: ranked.slice(0, 40).map((r, i) => ({
        tags: paramTags(r.params, riskLevel),
        cells: [
          String(i + 1),
          r.metrics.cagrPct.toFixed(2),
          r.metrics.maxDrawdownPct.toFixed(1),
          r.metrics.sharpe.toFixed(2),
          r.metrics.tradesPerYear.toFixed(0),
          r.metrics.feeDragPct.toFixed(1),
          r.metrics.finalCashPct.toFixed(0),
          r.check.disqualified ? "disqualified" : r.check.feasible ? "ok" : r.check.violations.join("; "),
          formatParams(r.params),
        ],
      })),

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
      rows: frontier.map((r) => ({
        tags: paramTags(r.params, riskLevel),
        cells: [
          r.metrics.tradesPerYear.toFixed(0),
          r.metrics.cagrPct.toFixed(2),
          r.metrics.maxDrawdownPct.toFixed(1),
          r.metrics.feeDragPct.toFixed(1),
          formatParams(r.params),
        ],
      })),

    },
  },
];

panels.push(
  {
    heading: "Turnover attribution — what drives trading frequency",
    subtitle:
      "share of turnover variance explained by each axis (one-way eta²); " +
      "direction is the slope of trades/yr against the parameter",
    series: [],
    table: {
      columns: [
        "parameter",
        "variance share",
        "direction",
        "trades/yr per unit",
        "quietest",
        "busiest",
        "spread /yr",
        "levels (trades/yr · CAGR %)",
      ],
      rows: drivers.map((d) => [
        d.key,
        `${(d.varianceShare * 100).toFixed(0)}%`,
        d.direction > 0 ? "raises churn" : d.direction < 0 ? "damps churn" : "flat",
        d.slopePerUnit.toFixed(2),
        `${String(d.quietestValue)}`,
        `${String(d.busiestValue)}`,
        d.spreadPerYear.toFixed(0),
        d.levels
          .map((l) => `${l.value}→${l.meanTradesPerYear.toFixed(0)}/yr · ${l.meanCagrPct.toFixed(1)}%`)
          .join(", "),
      ]),
    },
  },
  {
    heading: "Cost of churn after realistic frictions",
    subtitle:
      `${FRICTIONS.commissionBps}bps + $${FRICTIONS.minCommission} commission, ` +
      `${FRICTIONS.slippageBps}bps slippage: regression of outcome on turnover across ${costCurve.n} candidates`,
    series: [],
    table: {
      columns: ["measure", "value"],
      rows: [
        ["net CAGR per extra trade/yr (pp)", costCurve.cagrPerTrade.toFixed(3)],
        ["fee drag per extra trade/yr (pp)", costCurve.feeDragPerTrade.toFixed(3)],
        [
          "fitted breakeven turnover (/yr)",
          costCurve.breakevenTradesPerYear === null
            ? "none in range"
            : costCurve.breakevenTradesPerYear.toFixed(0),
        ],
        ["turnover of best candidate (/yr)", costCurve.bestObservedTradesPerYear.toFixed(0)],
      ],
    },
  },
  {
    heading: "Re-entry behaviour",
    subtitle:
      reentryDriverKey
        ? `flat→re-buy gaps grouped by ${reentryDriverKey}; overall ` +
          `${(overallReentry.reentryRate * 100).toFixed(0)}% of exits were re-bought ` +
          `(median gap ${overallReentry.medianGapDays.toFixed(0)}d)`
        : "no axis available",
    series: [],
    table: {
      columns: [
        `${reentryDriverKey ?? "level"}`,
        "candidates",
        "mean gap (days)",
        `re-entry ≤5d`,
        "exits re-bought",
        "trades/yr",
      ],
      rows: reentryLevels.map((l) => [
        String(l.value),
        String(l.n),
        l.meanGapDays.toFixed(1),
        `${(l.fastReentryShare * 100).toFixed(0)}%`,
        `${(l.reentryRate * 100).toFixed(0)}%`,
        l.meanTradesPerYear.toFixed(0),
      ]),
    },
  },
);

panels.push(
  {
    heading: "Viability thresholds by risk level",
    subtitle:
      `breakeven = turnover at which the fitted net-CAGR line crosses the ` +
      `${minViableCagr.toFixed(2)}% floor, after ${FRICTIONS.commissionBps}bps + ` +
      `$${FRICTIONS.minCommission} commission and ${FRICTIONS.slippageBps}bps slippage`,
    series: [],
    table: {
      columns: [
        "risk level",
        "breakeven /yr",
        "source",
        "CAGR per trade (pp)",
        "viable",
        "marginal",
        "below",
        "viable share",
        "best viable",
      ],
      rows: viability.levels.map((l) => [
        l.riskLevel,
        l.threshold.breakevenTradesPerYear === null
          ? "—"
          : l.threshold.breakevenTradesPerYear.toFixed(0),
        l.threshold.source,
        l.threshold.cagrPerTrade.toFixed(3),
        String(l.viableCount),
        String(l.marginalCount),
        String(l.belowCount),
        `${(l.viableShare * 100).toFixed(0)}%`,
        l.bestViable
          ? `${l.bestViable.metrics.cagrPct.toFixed(2)}% @ ${l.bestViable.metrics.tradesPerYear.toFixed(0)}/yr`
          : "none",
      ]),
    },
  },
  {
    heading: "Configurations flagged below breakeven",
    subtitle:
      `${viability.totalFlagged} of ${viability.totalAssessed} evaluated cells are below or ` +
      `within 10% of their risk level's breakeven` +
      (viability.universallyBelow.length
        ? ` · ${viability.universallyBelow.length} fail at every risk level and can be dropped from the search space`
        : ""),
    series: [],
    table: {
      columns: [
        "risk level",
        "verdict",
        "CAGR %",
        "turnover/yr",
        "headroom /yr",
        "return margin (pp)",
        "reason",
        "params",
      ],
      rows: viability.levels
        .flatMap((l) => l.flagged)
        .sort((a, b) => a.returnMarginPct - b.returnMarginPct)
        .slice(0, 25)
        .map((a) => [
          a.riskLevel,
          VERDICT_LABEL[a.verdict],
          a.metrics.cagrPct.toFixed(2),
          a.metrics.tradesPerYear.toFixed(0),
          a.turnoverHeadroom === null ? "—" : a.turnoverHeadroom.toFixed(0),
          a.returnMarginPct.toFixed(2),
          a.reasons[0] ?? "",
          a.id,
        ]),
    },
  },
);

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
