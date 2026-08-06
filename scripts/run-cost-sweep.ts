// Breakeven cost sweep: ticket size × commission/fee assumptions.
//
//   bun run scripts/run-cost-sweep.ts
//   bun run scripts/run-cost-sweep.ts --styles swing --scales 0,0.1,0.25,0.5,1
//   bun run scripts/run-cost-sweep.ts --from 2019-01-01 --risk balanced
//
// Runs the real-market tape once, then re-trades it for every combination of
// ticket size (per-name sleeve weight) and cost scale (a multiplier on the
// baseline Saxo-like friction model). For each ticket size it interpolates the
// cost level where the strategy crosses zero return and where it crosses buy
// & hold — i.e. the breakeven cost at which swing trading becomes viable.

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest, type StyleTradeRow } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import {
  buildCostScenarios,
  findBreakevenScale,
  formatBreakeven,
  roundTripCostBps,
  ticketValue,
  type SweepCell,
  type TicketSpec,
} from "../src/lib/cost-sweep";
import { computeMaxDrawdown, computeSharpe, dailyReturns, type EquityPoint } from "../src/lib/backtest-metrics";
import { renderBacktestReportHtml, type ReportPanel } from "../src/lib/backtest-report-chart";
import { buildCostReturnPanels } from "../src/lib/cost-return-chart";
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
const scales = arg("scales", "0,0.1,0.25,0.5,0.75,1").split(",").map(Number);

// Baseline: Saxo-like retail costs on US lines.
const BASE_FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

// Ticket-size axis. Fewer, larger positions amortise the fixed commission
// minimum; more, smaller ones are eaten alive by it.
const TICKETS: TicketSpec[] = [
  { label: "12 x 7%", maxNames: 12, perNameWeight: 0.07 },
  { label: "8 x 11%", maxNames: 8, perNameWeight: 0.11 },
  { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 },
  { label: "3 x 30%", maxNames: 3, perNameWeight: 0.3 },
];

const scenarios = buildCostScenarios(BASE_FRICTIONS, scales);

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);
if (tape.bars.length < 120) throw new Error("Tape too short to backtest");

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
    total_value: cash + names.reduce((sum, s) => sum + (qty[s] ?? 0) * (b.closes[s] ?? first.closes[s]!), 0),
  }));
  return { curve, ret: (curve.at(-1)!.total_value / startingCash - 1) * 100 };
}
const bh = buyAndHold();
console.log(`Buy & hold on the same tape: ${bh.ret.toFixed(1)}%`);

// ----------------------------------------------------------------- sweep
const cells: SweepCell[] = [];
const curves = new Map<string, EquityPoint[]>();
const tradeLogs = new Map<string, StyleTradeRow[]>();


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
        const cell: SweepCell = {
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
        };
        cells.push(cell);
        curves.set(`${riskLevel}|${style}|${ticket.label}|${scenario.scale}`, m.equityCurve);
        tradeLogs.set(`${riskLevel}|${style}|${ticket.label}|${scenario.scale}`, m.tradeLog);
        console.log(
          `${riskLevel.padEnd(8)} ${style.padEnd(8)} ${ticket.label.padEnd(9)} ` +
            `cost ${(scenario.scale * 100).toFixed(0).padStart(3)}%  ` +
            `ret ${m.totalReturnPct.toFixed(1).padStart(7)}%  ` +
            `sharpe ${m.sharpe.toFixed(2).padStart(5)}  trades ${String(m.trades).padStart(4)}  ` +
            `fees ${m.feeDragPct.toFixed(1).padStart(5)}%`,
        );
      }
    }
  }
}

// ------------------------------------------------------------- breakeven
type BreakRow = [string, string, string, string, string, string, string];
const breakRows: BreakRow[] = [];
console.log("\nBreakeven cost level (share of baseline Saxo-like costs):");
for (const riskLevel of riskLevels) {
  for (const style of styles) {
    for (const ticket of TICKETS) {
      const series = cells.filter(
        (c) => c.riskLevel === riskLevel && c.style === style && c.ticket.label === ticket.label,
      );
      const tv = ticketValue(startingCash, ticket);
      const zero = findBreakevenScale(series, { baseFrictions: BASE_FRICTIONS, ticketValue: tv });
      const bench = findBreakevenScale(series, {
        target: "benchmark",
        baseFrictions: BASE_FRICTIONS,
        ticketValue: tv,
      });
      console.log(
        `  ${riskLevel.padEnd(8)} ${style.padEnd(8)} ${ticket.label.padEnd(9)} ` +
          `ticket £${tv.toFixed(0).padStart(5)}  baseline ${roundTripCostBps(BASE_FRICTIONS, tv).toFixed(0).padStart(4)}bps  ` +
          `vs zero: ${formatBreakeven(zero)}  |  vs B&H: ${formatBreakeven(bench)}`,
      );
      breakRows.push([
        riskLevel,
        style,
        ticket.label,
        `£${tv.toFixed(0)}`,
        `${roundTripCostBps(BASE_FRICTIONS, tv).toFixed(0)}`,
        formatBreakeven(zero),
        formatBreakeven(bench),
      ]);
    }
  }
}

// ---------------------------------------------------------------- report
const COLOURS = ["#39d98a", "#4ea1ff", "#f5a623", "#e5484d", "#a78bfa", "#9aa4b2"];
const panels: ReportPanel[] = [];
for (const riskLevel of riskLevels) {
  for (const style of styles) {
    for (const ticket of TICKETS) {
      panels.push({
        heading: `${riskLevel} · ${style} · ticket ${ticket.label}`,
        subtitle: `real data ${from} → ${to} · cost scales ${scales.map((s) => `${s * 100}%`).join(", ")}`,
        series: [
          ...scenarios.map((sc, i) => ({
            label: sc.label,
            colour: COLOURS[i % COLOURS.length]!,
            curve: curves.get(`${riskLevel}|${style}|${ticket.label}|${sc.scale}`) ?? [],
            trades: tradeLogs.get(`${riskLevel}|${style}|${ticket.label}|${sc.scale}`) ?? [],
          })),
          { label: "buy & hold", colour: "#9aa4b2", dashed: true, curve: bh.curve },
        ],
        table: {
          columns: ["cost", "return %", "sharpe", "maxDD %", "trades", "fees %"],
          rows: cells
            .filter((c) => c.riskLevel === riskLevel && c.style === style && c.ticket.label === ticket.label)
            .map((c) => [
              c.scenario.label,
              c.totalReturnPct.toFixed(1),
              c.sharpe.toFixed(2),
              c.maxDrawdownPct.toFixed(1),
              String(c.trades),
              c.feeDragPct.toFixed(1),
            ]),
        },
      });
    }
  }
}
// Cost-vs-return + breakeven curve, one panel per risk level, for each style.
const costReturnPanels = styles.flatMap((style) =>
  buildCostReturnPanels(cells, {
    baseFrictions: BASE_FRICTIONS,
    startingCash,
    tickets: TICKETS,
    style,
  }),
);
panels.unshift(...costReturnPanels);

panels.unshift({
  heading: "Breakeven summary",
  subtitle: "cost level at which each ticket size turns viable",
  series: [],
  table: {
    columns: ["risk", "style", "ticket", "notional", "baseline bps", "vs zero", "vs buy & hold"],
    rows: breakRows,
  },
});

mkdirSync("reports", { recursive: true });
const outPath = "reports/cost-sweep.html";
writeFileSync(
  outPath,
  renderBacktestReportHtml({ title: `Ticket size × cost sweep · ${from} → ${to}`, panels }),
);
console.log(`\nReport written to ${outPath}`);
