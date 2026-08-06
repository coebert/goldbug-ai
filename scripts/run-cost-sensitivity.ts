// Slippage × commission sensitivity analysis on the real market tape.
//
//   bun run scripts/run-cost-sensitivity.ts
//   bun run scripts/run-cost-sensitivity.ts --slippage 2,5,10,20 --pertrade 0,3,8
//   bun run scripts/run-cost-sensitivity.ts --styles swing --risk balanced --target benchmark
//
// Unlike the single-axis cost sweep, this varies slippage (proportional) and
// the fixed per-trade commission (a tax on trade count) independently, so the
// report shows which one actually breaks the rules and how steeply.

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest, type StyleTradeRow } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import {
  buildSensitivityGrid,
  frictionsAt,
  summariseRobustness,
  formatRobustness,
  dominantCostAxis,
  toMarginGrid,
  DEFAULT_PER_TRADE,
  DEFAULT_SLIPPAGE_BPS,
  type SensitivityCell,
  type SensitivityTarget,
} from "../src/lib/cost-sensitivity";
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
const nums = (s: string) => s.split(",").map((x) => Number(x.trim()));

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "SPY", "GLD"];

const from = arg("from", "2018-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const mode = arg("mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const riskLevels = arg("risk", "balanced").split(",") as RiskLevel[];
const styles = arg("styles", "swing,position").split(",") as TradingStyle[];
const slippageAxis = nums(arg("slippage", DEFAULT_SLIPPAGE_BPS.join(",")));
const perTradeAxis = nums(arg("pertrade", DEFAULT_PER_TRADE.join(",")));
const target = arg("target", "zero") as SensitivityTarget;

// Everything except the two swept axes stays at the baseline Saxo-like model.
const BASE_FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const grid = buildSensitivityGrid(slippageAxis, perTradeAxis);

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);
if (tape.bars.length < 30) throw new Error("Not enough bars for a sensitivity analysis.");

// ---------------------------------------------------------- buy & hold ref
function buyAndHold(): { curve: EquityPoint[]; ret: number } {
  const first = tape.bars[0]!;
  const names = tape.symbols.filter((s) => (first.closes[s] ?? 0) > 0);
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

// -------------------------------------------------------------- the grid
const cells: SensitivityCell[] = [];
const curves = new Map<string, EquityPoint[]>();
const tradeLogs = new Map<string, StyleTradeRow[]>();
const key = (r: string, st: string, s: number, c: number) => `${r}|${st}|${s}|${c}`;

for (const riskLevel of riskLevels) {
  for (const style of styles) {
    const cfg = parseRiskConfig({ trading_style: style } as never);
    for (const point of grid) {
      const m = await runStyleBacktest({
        cfg,
        bars: tape.bars,
        riskLevel,
        startingCash,
        feePerTrade: 0,
        simulator: { frictions: frictionsAt(BASE_FRICTIONS, point) },
      });
      cells.push({
        ...point,
        style,
        riskLevel,
        totalReturnPct: m.totalReturnPct,
        benchmarkReturnPct: bh.ret,
        sharpe: m.sharpe,
        maxDrawdownPct: m.maxDrawdownPct,
        trades: m.trades,
        feeDragPct: m.feeDragPct,
      });
      curves.set(key(riskLevel, style, point.slippageBps, point.perTrade), m.equityCurve);
      tradeLogs.set(key(riskLevel, style, point.slippageBps, point.perTrade), m.tradeLog);
      console.log(
        `${riskLevel.padEnd(8)} ${style.padEnd(8)} slip ${String(point.slippageBps).padStart(2)}bps ` +
          `fee $${String(point.perTrade).padStart(2)}  ret ${m.totalReturnPct.toFixed(1).padStart(7)}%  ` +
          `sharpe ${m.sharpe.toFixed(2).padStart(5)}  trades ${String(m.trades).padStart(4)}  ` +
          `fees ${m.feeDragPct.toFixed(1).padStart(5)}%`,
      );
    }
  }
}

// ------------------------------------------------------------- robustness
const slipRange = Math.max(...slippageAxis) - Math.min(...slippageAxis);
const feeRange = Math.max(...perTradeAxis) - Math.min(...perTradeAxis);
type SumRow = [string, string, string, string, string, string, string];
const summaryRows: SumRow[] = [];

console.log(`\nRobustness to execution costs (target: ${target === "zero" ? "positive return" : "beat buy & hold"}):`);
for (const riskLevel of riskLevels) {
  for (const style of styles) {
    const subset = cells.filter((c) => c.riskLevel === riskLevel && c.style === style);
    const s = summariseRobustness(subset, target);
    const dom = dominantCostAxis(s, slipRange, feeRange) ?? "—";
    console.log(`  ${riskLevel.padEnd(8)} ${style.padEnd(8)} ${formatRobustness(s)}  [dominant: ${dom}]`);
    summaryRows.push([
      riskLevel,
      style,
      s.verdict,
      `${(s.survivalRate * 100).toFixed(0)}%`,
      s.slippageElasticity === null ? "—" : `${s.slippageElasticity.toFixed(2)}%/bp`,
      s.perTradeElasticity === null ? "—" : `${s.perTradeElasticity.toFixed(2)}%/$`,
      dom,
    ]);
  }
}

// ----------------------------------------------------------------- report
const COLOURS = ["#39d98a", "#4ea1ff", "#f5a623", "#e5484d", "#a78bfa", "#9aa4b2"];
const panels: ReportPanel[] = [
  {
    heading: "Execution-cost robustness",
    subtitle: `slippage ${slippageAxis.join("/")}bps × $${perTradeAxis.join("/")} per trade · real data ${from} → ${to}`,
    series: [],
    table: {
      columns: ["risk", "style", "verdict", "cells positive", "slippage elasticity", "fee elasticity", "dominant cost"],
      rows: summaryRows,
    },
  },
];

for (const riskLevel of riskLevels) {
  for (const style of styles) {
    const subset = cells.filter((c) => c.riskLevel === riskLevel && c.style === style);
    // Heatmap-style table: rows = slippage bps, columns = $ per trade.
    const marginGrid = toMarginGrid(subset, slippageAxis, perTradeAxis, target);
    panels.push({
      heading: `${riskLevel} · ${style} · margin grid`,
      subtitle: `rows = slippage bps, columns = $ per trade · margin vs ${target === "zero" ? "zero" : "buy & hold"} in % points`,
      series: [],
      table: {
        columns: ["slippage", ...perTradeAxis.map((c) => `$${c}`)],
        rows: marginGrid.map((r) => [
          `${r.slippageBps} bps`,
          ...r.margins.map((m) => (m === null ? "—" : `${m >= 0 ? "+" : ""}${m.toFixed(1)}`)),
        ]),
      },
    });

    // Equity curves along the slippage axis at the cheapest commission level.
    const anchorFee = Math.min(...perTradeAxis);
    panels.push({
      heading: `${riskLevel} · ${style} · slippage axis @ $${anchorFee}/trade`,
      subtitle: `equity curves across ${slippageAxis.join(", ")} bps of slippage`,
      series: [
        ...slippageAxis.map((s, i) => ({
          label: `${s} bps`,
          colour: COLOURS[i % COLOURS.length]!,
          curve: curves.get(key(riskLevel, style, s, anchorFee)) ?? [],
          trades: tradeLogs.get(key(riskLevel, style, s, anchorFee)) ?? [],
        })),
        { label: "buy & hold", colour: "#9aa4b2", dashed: true, curve: bh.curve },
      ],
    });

    // Equity curves along the commission axis at the tightest slippage level.
    const anchorSlip = Math.min(...slippageAxis);
    panels.push({
      heading: `${riskLevel} · ${style} · commission axis @ ${anchorSlip} bps`,
      subtitle: `equity curves across $${perTradeAxis.join(", $")} per trade`,
      series: [
        ...perTradeAxis.map((c, i) => ({
          label: `$${c}/trade`,
          colour: COLOURS[i % COLOURS.length]!,
          curve: curves.get(key(riskLevel, style, anchorSlip, c)) ?? [],
          trades: tradeLogs.get(key(riskLevel, style, anchorSlip, c)) ?? [],
        })),
        { label: "buy & hold", colour: "#9aa4b2", dashed: true, curve: bh.curve },
      ],
    });
  }
}

mkdirSync("reports", { recursive: true });
const html = renderBacktestReportHtml({
  title: "Aegis — slippage & commission sensitivity",
  subtitle: `${symbols.length} symbols · ${tape.bars.length} bars · buy & hold ${bh.ret.toFixed(1)}%`,
  panels,
});
writeFileSync("reports/cost-sensitivity.html", html);
console.log("\nWrote reports/cost-sensitivity.html");
