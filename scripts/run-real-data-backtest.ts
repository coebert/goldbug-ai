// Swing vs position backtest on REAL historical market data.
//
//   bun run scripts/run-real-data-backtest.ts
//   bun run scripts/run-real-data-backtest.ts --from 2019-01-01 --to 2024-12-31
//   bun run scripts/run-real-data-backtest.ts --symbols AAPL,MSFT,SPY --mode price_return
//
// Differences vs the synthetic harness:
//   - The tape comes from the provider's daily closes (splits back-adjusted,
//     dividends folded in via adjusted close in total-return mode).
//   - Execution runs with realistic frictions: commission bps + minimum,
//     UK-style buy tax where applicable, half-spread slippage, and per-unit
//     market impact — all applied inside the broker simulator.
//   - Every cell is scored against buy-and-hold on the same tape, so the
//     table answers "does the rules-based edge survive real data and costs?"

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest, type StyleRunMetrics } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  buildRealTape,
  detectUnhandledActions,
  type PriceMode,
} from "../src/lib/real-market-tape";
import {
  computeMaxDrawdown,
  computeSharpe,
  dailyReturns,
  type EquityPoint,
} from "../src/lib/backtest-metrics";
import { renderBacktestReportHtml, type ReportPanel } from "../src/lib/backtest-report-chart";
import type { RiskLevel } from "../src/lib/risk-sim-matrix";
import type { TradingStyle } from "../src/lib/trading-style";
import { mkdirSync, writeFileSync } from "node:fs";

// ------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = [
  "AAPL", // mega-cap tech (4:1 split in 2020)
  "MSFT",
  "NVDA", // high beta, 4:1 and 10:1 splits
  "JPM", // financials
  "XOM", // energy / cyclical
  "JNJ", // defensive, steady dividend
  "KO", // consumer staple, high dividend
  "SPY", // index benchmark
  "GLD", // gold hedge sleeve
];

const from = arg("from", "2018-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const mode = arg("mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const riskLevels: RiskLevel[] = ["low", "balanced", "high"];
const styles: TradingStyle[] = ["position", "swing"];

// ----------------------------------------------------------- cost model
// Saxo-like retail costs: 8bps commission with a $3 minimum, plus a
// half-spread slippage of 5bps and a small per-unit impact term.
const FRICTIONS = {
  commissionBps: 8,
  minCommission: 3,
  // UK single stocks pay 50bps stamp on buys; ETFs and US lines pay none.
  // `--stamp` sets the blended rate for a mixed book.
  buyTaxBps: Number(arg("stamp", "0")),

  slippageBps: 5,
  impactPerUnit: 0.0002,
};

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, {
  from,
  to,
  onProgress: (m) => console.log(`  ${m}`),
});

const tape = buildRealTape(histories, { mode, from, to });
console.log(
  `\nTape: ${tape.bars.length} bars, ${tape.symbols.length} symbols, ` +
    `${tape.actions.filter((a) => a.kind === "split").length} splits / ` +
    `${tape.actions.filter((a) => a.kind === "dividend").length} dividends in window (mode=${mode}).`,
);
const anomalies = detectUnhandledActions(tape.bars);
if (anomalies.length) {
  console.log(`Unhandled-action candidates (>45% single-bar move):`);
  for (const a of anomalies.slice(0, 20)) {
    console.log(
      `  ${a.date} ${a.symbol} ${a.fromPrice.toFixed(2)} → ${a.toPrice.toFixed(2)} (${a.movePct.toFixed(1)}%)`,
    );
  }
} else {
  console.log("No unhandled corporate actions detected in the tape.");
}
if (tape.bars.length < 120) throw new Error("Tape too short to backtest");

// ------------------------------------------------------- buy & hold ref
function buyAndHold(): { curve: EquityPoint[]; metrics: { ret: number; dd: number; sharpe: number } } {
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
  const end = curve.at(-1)!.total_value;
  return {
    curve,
    metrics: {
      ret: (end / startingCash - 1) * 100,
      dd: computeMaxDrawdown(curve).pct,
      sharpe: computeSharpe(dailyReturns(curve)),
    },
  };
}
const bh = buyAndHold();

// --------------------------------------------------------------- cells
const rows: StyleRunMetrics[] = [];
for (const riskLevel of riskLevels) {
  for (const style of styles) {
    const cfg = parseRiskConfig({ trading_style: style } as never);
    const m = await runStyleBacktest({
      cfg,
      bars: tape.bars,
      riskLevel,
      startingCash,
      feePerTrade: 0, // frictions own the cost model now
      simulator: { frictions: FRICTIONS },
    });
    rows.push({ ...m, style, horizon: `${from}→${to}`, seed: 0 });
    console.log(
      `${riskLevel.padEnd(8)} ${style.padEnd(8)} ` +
        `ret ${m.totalReturnPct.toFixed(1)}%  cagr ${m.cagrPct.toFixed(1)}%  ` +
        `dd ${m.maxDrawdownPct.toFixed(1)}%  sharpe ${m.sharpe.toFixed(2)}  ` +
        `trades ${m.trades}  win ${m.winRatePct.toFixed(0)}%  fees ${m.feeDragPct.toFixed(2)}%`,
    );
  }
}

console.log(
  `\nBuy & hold (equal weight, same tape): ret ${bh.metrics.ret.toFixed(1)}%  ` +
    `dd ${bh.metrics.dd.toFixed(1)}%  sharpe ${bh.metrics.sharpe.toFixed(2)}`,
);
console.log("\nEdge vs buy & hold (excess total return, pp):");
for (const r of rows) {
  console.log(
    `  ${r.riskLevel.padEnd(8)} ${r.style.padEnd(8)} ${(r.totalReturnPct - bh.metrics.ret).toFixed(1)}pp`,
  );
}

// -------------------------------------------------------------- report
const COLOURS: Record<string, string> = { position: "#4ea1ff", swing: "#39d98a" };
const panels: ReportPanel[] = riskLevels.map((riskLevel) => ({
  heading: `${riskLevel} risk`,
  subtitle: `real data ${from} → ${to} · ${mode} · frictions on`,
  series: [
    ...rows
      .filter((r) => r.riskLevel === riskLevel)
      .map((r) => ({
        label: r.style,
        colour: COLOURS[r.style] ?? "#4ea1ff",
        curve: r.equityCurve,
        trades: r.tradeLog,
      })),
    { label: "buy & hold", colour: "#9aa4b2", dashed: true, curve: bh.curve },
  ],
  table: {
    columns: ["style", "return %", "cagr %", "maxDD %", "sharpe", "trades", "win %", "fees %"],
    rows: rows
      .filter((r) => r.riskLevel === riskLevel)
      .map((r) => [
        r.style,
        r.totalReturnPct.toFixed(1),
        r.cagrPct.toFixed(1),
        r.maxDrawdownPct.toFixed(1),
        r.sharpe.toFixed(2),
        String(r.trades),
        r.winRatePct.toFixed(0),
        r.feeDragPct.toFixed(2),
      ]),
  },
}));
mkdirSync("reports", { recursive: true });
const outPath = "reports/real-data-backtest.html";
writeFileSync(
  outPath,
  renderBacktestReportHtml({
    title: `Real-data swing vs position · ${from} → ${to}`,
    panels,
  }),
);
console.log(`\nReport written to ${outPath}`);
