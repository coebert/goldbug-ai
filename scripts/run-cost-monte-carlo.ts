// Monte Carlo execution-cost stress test on the real market tape.
//
//   bun run scripts/run-cost-monte-carlo.ts
//   bun run scripts/run-cost-monte-carlo.ts --draws 60 --risk balanced --style swing
//   bun run scripts/run-cost-monte-carlo.ts --from 2015-01-01 --max-dd 25
//
// Samples commission bps, per-ticket minimum and slippage jointly (with a
// shared stress factor so bad worlds are bad on every axis), replays the SAME
// draws against turnover cohorts that differ only in min-hold / re-entry gap,
// and reports the distribution of net CAGR and max drawdown per cohort — so
// the cost of churn is measured, not assumed.

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest, ENTRY_SLEEVE } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import { applyParams } from "../src/lib/param-optimizer";
import {
  DEFAULT_COST_SPEC,
  churnImpact,
  dominantAxis,
  explainChurn,
  formatCohort,
  frictionsFromDraw,
  sampleCostDraws,
  summariseByCohort,
  type CostDrawSpec,
  type CostTrial,
} from "../src/lib/cost-monte-carlo";
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
const draws = Number(arg("draws", "48"));
const seed = Number(arg("seed", "20260806"));
const ddCeiling = Number(arg("max-dd", "30"));
const commonFactor = Number(arg("common-factor", "0.5"));

const spec: CostDrawSpec = { ...DEFAULT_COST_SPEC, commonFactor };

// Turnover cohorts: identical alpha rules, different churn brakes.
const COHORTS = [
  { label: "low churn (hold 10d/gap 30d)", params: { swing_min_hold_days: 10, reentry_min_days: 30 } },
  { label: "medium churn (hold 5d/gap 15d)", params: { swing_min_hold_days: 5, reentry_min_days: 15 } },
  { label: "high churn (hold 2d/gap 3d)", params: { swing_min_hold_days: 2, reentry_min_days: 3 } },
];

const BASE_FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);
if (tape.bars.length < 120) throw new Error("Not enough bars for a Monte Carlo cost stress test.");

const costDraws = sampleCostDraws(draws, spec, seed);
console.log(
  `Sampling ${draws} cost worlds: commission ${spec.commissionBps.min}-${spec.commissionBps.max}bps, ` +
    `min fee £${spec.minCommission.min}-${spec.minCommission.max}, slippage ${spec.slippageBps.min}-${spec.slippageBps.max}bps ` +
    `(common factor ${commonFactor}, ${spec.slippageTail} tail, seed ${seed}).`,
);

const baseCfg = parseRiskConfig({ trading_style: style } as never);
const trials: CostTrial[] = [];

for (const cohort of COHORTS) {
  const { cfg, sleeve } = applyParams(baseCfg, ENTRY_SLEEVE[riskLevel], cohort.params);
  for (const draw of costDraws) {
    const m = await runStyleBacktest({
      cfg,
      bars: tape.bars,
      riskLevel,
      startingCash,
      feePerTrade: 0,
      sleeve,
      simulator: { frictions: frictionsFromDraw(BASE_FRICTIONS, draw) },
    });
    trials.push({
      cohort: cohort.label,
      draw,
      netCagrPct: m.cagrPct,
      maxDrawdownPct: m.maxDrawdownPct,
      sharpe: m.sharpe,
      tradesPerYear: m.tradesPerYear,
      feeDragPct: m.feeDragPct,
    });
  }
  const done = trials.filter((t) => t.cohort === cohort.label);
  console.log(
    `  ${cohort.label.padEnd(28)} ${done.length} draws · ` +
      `median net CAGR ${(done.map((t) => t.netCagrPct).sort((a, b) => a - b)[Math.floor(done.length / 2)] ?? 0).toFixed(1)}%`,
  );
}

const summaries = summariseByCohort(trials, ddCeiling);
console.log(`\nCost-stress distribution (${draws} draws each, DD ceiling ${ddCeiling}%):`);
for (const s of summaries) console.log(`  ${formatCohort(s)}`);

console.log("\nPartial cost sensitivities (net CAGR % points):");
for (const s of summaries) {
  console.log(
    `  ${s.cohort.padEnd(28)} ${s.sensitivity.perCommissionBp.toFixed(3)}/bp comm · ` +
      `${s.sensitivity.perMinFee.toFixed(3)}/£ min fee · ${s.sensitivity.perSlippageBp.toFixed(3)}/bp slip · ` +
      `R² ${s.sensitivity.r2.toFixed(2)} · DD +${s.drawdownSlippageSlope.toFixed(3)}pp/bp slip · ` +
      `dominant: ${dominantAxis(s.sensitivity, spec)}`,
  );
}

const impact = churnImpact(summaries);
const churned = summaries.find((s) => s.cohort === impact?.churned);
console.log(`\n${explainChurn(impact, spec, churned?.sensitivity)}`);

// ----------------------------------------------------------------- report
const panels: ReportPanel[] = [
  {
    heading: "Monte Carlo cost stress — outcome distribution",
    subtitle: `${draws} sampled cost worlds × ${COHORTS.length} turnover cohorts · ${riskLevel} · ${style} · real data ${from} → ${to}`,
    series: [],
    table: {
      columns: [
        "cohort",
        "trades/yr",
        "net CAGR p5",
        "median",
        "p95",
        "CVaR5",
        "maxDD median",
        "maxDD p95",
        "profitable",
        `DD ≤ ${ddCeiling}%`,
      ],
      rows: summaries.map((s) => [
        s.cohort,
        s.tradesPerYear.toFixed(0),
        `${s.netCagr.p5.toFixed(1)}%`,
        `${s.netCagr.median.toFixed(1)}%`,
        `${s.netCagr.p95.toFixed(1)}%`,
        `${s.cvarNetCagr.toFixed(1)}%`,
        `${s.maxDrawdown.median.toFixed(1)}%`,
        `${s.maxDrawdown.p95.toFixed(1)}%`,
        `${(s.profitableRate * 100).toFixed(0)}%`,
        `${(s.drawdownPassRate * 100).toFixed(0)}%`,
      ]),
    },
  },
  {
    heading: "Cost elasticity by cohort",
    subtitle: "partial OLS slopes — how much each cost axis costs, holding the others fixed",
    series: [],
    table: {
      columns: [
        "cohort",
        "per bp commission",
        "per £ min fee",
        "per bp slippage",
        "R²",
        "DD per bp slippage",
        "fee drag median",
        "dominant axis",
      ],
      rows: summaries.map((s) => [
        s.cohort,
        `${s.sensitivity.perCommissionBp.toFixed(3)}pp`,
        `${s.sensitivity.perMinFee.toFixed(3)}pp`,
        `${s.sensitivity.perSlippageBp.toFixed(3)}pp`,
        s.sensitivity.r2.toFixed(2),
        `${s.drawdownSlippageSlope.toFixed(3)}pp`,
        `${s.feeDrag.median.toFixed(1)}%`,
        dominantAxis(s.sensitivity, spec),
      ]),
    },
  },
  {
    heading: "Churn attribution",
    subtitle: explainChurn(impact, spec, churned?.sensitivity),
    series: [],
    table: impact
      ? {
          columns: ["metric", "value"],
          rows: [
            ["baseline cohort", impact.baseline],
            ["churned cohort", impact.churned],
            ["extra round-trips / yr", impact.extraTradesPerYear.toFixed(0)],
            ["median net CAGR given up", `${impact.medianCagrCostPct.toFixed(1)}pp`],
            ["per extra trade / yr", `${impact.cagrPerExtraTrade.toFixed(2)}pp`],
            ["extra fee drag", `${impact.extraFeeDragPct.toFixed(1)}%`],
            ["p95 drawdown widening", `${impact.tailDrawdownCostPct.toFixed(1)}pp`],
            ["profitable-world rate change", `${(impact.profitableRateDelta * 100).toFixed(0)}pp`],
            ["cost spread amplification", `${impact.spreadAmplification.toFixed(2)}x`],
            ["verdict", impact.verdict],
          ] as [string, string][],
        }
      : undefined,
  },
];

mkdirSync("reports", { recursive: true });
writeFileSync(
  "reports/cost-monte-carlo.html",
  renderBacktestReportHtml({
    title: "Aegis — Monte Carlo execution-cost stress test",
    subtitle: `${symbols.length} symbols · ${tape.bars.length} bars · ${draws} cost worlds · seed ${seed}`,
    panels,
  }),
);
writeFileSync(
  "reports/cost-monte-carlo.json",
  JSON.stringify({ spec, seed, draws, riskLevel, style, summaries, impact }, null, 2),
);
console.log("\nWrote reports/cost-monte-carlo.html and reports/cost-monte-carlo.json");
