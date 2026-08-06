// Stress-test the best feasible parameter set across a wide cost grid.
//
//   bun run scripts/run-param-stress.ts
//   bun run scripts/run-param-stress.ts --max-turnover 40 --max-dd 20
//   bun run scripts/run-param-stress.ts --scales 0.5,1,1.5,2,3,4 --slippage 2,5,10,20,40
//
// 1. Runs the real-market tape once.
// 2. Sweeps every (risk × style × ticket) arm over a wide
//    cost-scale × slippage × minimum-fee grid.
// 3. Picks the highest-robustness arm that already meets the turnover and
//    drawdown constraints at baseline cost.
// 4. Re-checks that arm scenario by scenario and reports where — if
//    anywhere — the constraints break.

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import { buildCostGrid, type SlippageSpec, type TicketSpec } from "../src/lib/cost-sweep";
import {
  armTableRows,
  formatArmTable,
  formatScenarioTable,
  scenarioTableRows,
  selectBestFeasible,
  stressGrid,
  summariseStress,
  STRESS_ARM_COLUMNS,
  STRESS_SCENARIO_COLUMNS,
  type StressCell,
  type StressConstraints,
} from "../src/lib/param-stress";
import { renderBacktestReportHtml, type ReportPanel } from "../src/lib/backtest-report-chart";
import type { EquityPoint } from "../src/lib/backtest-metrics";
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
const riskLevels = arg("risk", "balanced").split(",") as RiskLevel[];
const styles = arg("styles", "swing,position").split(",") as TradingStyle[];

// Wider than the viability sweep on purpose: this is a stress test, so it
// runs well past today's assumptions (up to 4x baseline cost, 40bps of
// execution cost, £15 minimum tickets).
const scales = arg("scales", "0.5,1,1.5,2,3,4").split(",").map(Number);
const slippageSpecs: SlippageSpec[] = arg("slippage", "2,5,10,20,40")
  .split(",")
  .map((raw) => {
    const bps = Number(raw.trim());
    if (!Number.isFinite(bps) || bps < 0) throw new Error(`bad --slippage value ${raw}`);
    return { label: `${bps}bps`, slippageBps: bps / 2, spreadBps: bps / 2 };
  });
const minFees = arg("minfee", "0,3,8,15").split(",").map(Number);

const constraints: StressConstraints = {
  maxTradesPerYear: Number(arg("max-turnover", "60")),
  maxDrawdownPct: Number(arg("max-dd", "25")),
  minReturnPct: Number(arg("min-return", "0")),
  ...(argv.includes("--beat-benchmark") ? { beatBenchmark: true } : {}),
};

const BASE_FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKETS: TicketSpec[] = [
  { label: "12 x 7%", maxNames: 12, perNameWeight: 0.07 },
  { label: "8 x 11%", maxNames: 8, perNameWeight: 0.11 },
  { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 },
  { label: "3 x 30%", maxNames: 3, perNameWeight: 0.3 },
];

const scenarios = buildCostGrid(BASE_FRICTIONS, {
  scales,
  slippage: slippageSpecs,
  minCommission: minFees,
});
const arms = riskLevels.length * styles.length * TICKETS.length;
console.log(
  `Stress grid: ${scenarios.length} cost scenarios x ${arms} arms = ` +
    `${scenarios.length * arms} backtests`,
);
console.log(
  `Constraints: <= ${constraints.maxTradesPerYear} trades/yr, ` +
    `drawdown >= -${constraints.maxDrawdownPct}%, return >= ${constraints.minReturnPct}%` +
    (constraints.beatBenchmark ? ", must beat buy & hold" : ""),
);

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);
if (tape.bars.length < 120) throw new Error("Tape too short to backtest");
const years = tape.bars.length / 252;

// ------------------------------------------------------- buy & hold ref
function buyAndHold(): { curve: EquityPoint[]; ret: number } {
  const first = tape.bars[0]!;
  const names = Object.keys(first.closes);
  const per = startingCash / names.length;
  const qty: Record<string, number> = {};
  let cash = startingCash;
  for (const s of names) {
    const q = Math.floor(per / first.closes[s]!);
    qty[s] = q;
    cash -= q * first.closes[s]!;
  }
  const curve: EquityPoint[] = tape.bars.map((b) => ({
    snapshot_date: b.date,
    total_value:
      cash + names.reduce((sum, s) => sum + (qty[s] ?? 0) * (b.closes[s] ?? first.closes[s]!), 0),
  }));
  return { curve, ret: (curve.at(-1)!.total_value / startingCash - 1) * 100 };
}
const bh = buyAndHold();
console.log(`Buy & hold on the same tape: ${bh.ret.toFixed(1)}%`);

// ----------------------------------------------------------------- sweep
const cells: StressCell[] = [];
let done = 0;
for (const riskLevel of riskLevels) {
  for (const style of styles) {
    const cfg = parseRiskConfig({ trading_style: style } as never);
    for (const ticket of TICKETS) {
      for (const scenario of scenarios) {
        const m = await runStyleBacktest({
          cfg,
          bars: tape.bars,
          riskLevel,
          startingCash,
          feePerTrade: 0,
          sleeve: { maxNames: ticket.maxNames, perNameWeight: ticket.perNameWeight },
          simulator: { frictions: scenario.frictions },
        });
        cells.push({
          ticket,
          scenario,
          style,
          riskLevel,
          totalReturnPct: m.totalReturnPct,
          benchmarkReturnPct: bh.ret,
          trades: m.trades,
          feeDragPct: m.feeDragPct,
          sharpe: m.sharpe,
          maxDrawdownPct: m.maxDrawdownPct,
          tradesPerYear: m.tradesPerYear,
          years,
        });
        done += 1;
        if (done % 25 === 0) console.log(`  … ${done}/${scenarios.length * arms} cells`);
      }
    }
  }
}

// ------------------------------------------------------- best + stress
const opts = { baseFrictions: BASE_FRICTIONS, startingCash, years };
const best = selectBestFeasible(cells, constraints, opts);
if (!best) throw new Error("no cells produced");

console.log(`\nSelected parameter set: ${best.arm}`);
console.log(`  ${best.reason}`);
console.log(`\n${summariseStress(best.stress, constraints)}\n`);
console.log(formatScenarioTable(best.stress));

const grid = stressGrid(cells, constraints, opts);
console.log("\nAll arms under the same stress grid:");
console.log(formatArmTable(grid));

const breaches = best.stress.scenarios.filter((s) => !s.pass);
if (breaches.length === 0) {
  console.log(
    `\nVerdict: ${best.arm} holds every constraint across all ` +
      `${best.stress.scenarioCount} cost scenarios.`,
  );
} else {
  console.log(
    `\nVerdict: ${best.arm} breaches constraints in ${breaches.length}/` +
      `${best.stress.scenarioCount} scenarios; first breach at ${breaches[0]!.scenarioLabel} ` +
      `(${breaches[0]!.violations.join(", ")}).`,
  );
}

// ---------------------------------------------------------------- report
const panels: ReportPanel[] = [
  {
    heading: `Stress test · ${best.arm}`,
    subtitle: summariseStress(best.stress, constraints),
    series: [],
    table: {
      columns: [...STRESS_SCENARIO_COLUMNS],
      rows: scenarioTableRows(best.stress),
    },
  },
  {
    heading: "All arms",
    subtitle:
      `${scenarios.length} cost scenarios per arm · constraints: ` +
      `<= ${constraints.maxTradesPerYear} trades/yr, drawdown >= -${constraints.maxDrawdownPct}%`,
    series: [],
    table: { columns: [...STRESS_ARM_COLUMNS], rows: armTableRows(grid) },
  },
];

mkdirSync("reports", { recursive: true });
const outPath = "reports/param-stress.html";
writeFileSync(
  outPath,
  renderBacktestReportHtml({ title: `Parameter stress test · ${from} → ${to}`, panels }),
);
console.log(`\nReport written to ${outPath}`);
