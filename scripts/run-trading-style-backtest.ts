// Side-by-side swing vs position backtest. Run:
//   bun run scripts/run-trading-style-backtest.ts
import { parseRiskConfig } from "../src/lib/universe.server";
import { compareTradingStyles, type StyleRunMetrics } from "../src/lib/trading-style-backtest";

const pad = (s: string | number, n: number) => String(s).padStart(n);
const num = (v: number, d = 2, n = 8) => pad(v.toFixed(d), n);

const cmp = await compareTradingStyles((style) => parseRiskConfig({ trading_style: style }));

const posCfg = parseRiskConfig({ trading_style: "position" });
const swiCfg = parseRiskConfig({ trading_style: "swing" });
console.log("Rules under test (parseRiskConfig):");
console.log(
  `  position: stop ${(posCfg.stop_loss_pct * 100).toFixed(0)}%  tp ${(posCfg.take_profit_pct * 100).toFixed(0)}%  trail ${posCfg.atr_trailing_mult}xATR  maxHold ${posCfg.max_hold_days || "none"}  timeStop ${posCfg.time_stop_horizon_days}d  reentry ${posCfg.reentry_min_days}-${posCfg.reentry_max_days}d  volTgt ${(posCfg.vol_target_pct * 100).toFixed(1)}%`,
);
console.log(
  `  swing:    stop ${(swiCfg.stop_loss_pct * 100).toFixed(0)}%  tp ${(swiCfg.take_profit_pct * 100).toFixed(0)}%  trail ${swiCfg.atr_trailing_mult}xATR  maxHold ${swiCfg.max_hold_days}  timeStop ${swiCfg.time_stop_horizon_days}d  reentry ${swiCfg.reentry_min_days}-${swiCfg.reentry_max_days}d  volTgt ${(swiCfg.vol_target_pct * 100).toFixed(1)}%  minHold ${swiCfg.swing_min_hold_days}d`,
);
console.log(`\nSeeds averaged per cell: ${cmp.seeds.join(", ")}  |  start £10,300  |  £3/trade\n`);

const header = [
  pad("Horizon", 8), pad("Risk", 9), pad("Style", 9),
  pad("Ret%", 8), pad("CAGR%", 8), pad("MaxDD%", 8), pad("Sharpe", 7),
  pad("Vol%", 7), pad("Calmar", 7), pad("Win%", 6), pad("Trd/y", 7),
  pad("Hold", 6), pad("Fee%", 6), pad("Cash%", 7),
].join(" ");
console.log(header);
console.log("-".repeat(header.length));

const row = (m: StyleRunMetrics) =>
  [
    pad(m.horizon, 8), pad(m.riskLevel, 9), pad(m.style, 9),
    num(m.totalReturnPct), num(m.cagrPct), num(m.maxDrawdownPct), num(m.sharpe, 2, 7),
    num(m.annualisedVolPct, 2, 7), num(m.calmar, 2, 7), num(m.winRatePct, 1, 6),
    num(m.tradesPerYear, 1, 7), num(m.avgHoldBars, 1, 6), num(m.feeDragPct, 2, 6),
    num(m.finalCashPct, 1, 7),
  ].join(" ");

let last = "";
for (const m of cmp.averaged) {
  const key = `${m.horizon}|${m.riskLevel}`;
  if (last && last !== key) console.log("");
  last = key;
  console.log(row(m));
}

// --------------------------------------------------- aggregate deltas
console.log("\nSwing minus position (averaged across all cells):");
const agg = (style: string, f: (m: StyleRunMetrics) => number) => {
  const xs = cmp.averaged.filter((m) => m.style === style).map(f);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
};
const metrics: Array<[string, (m: StyleRunMetrics) => number, number]> = [
  ["Total return %", (m) => m.totalReturnPct, 2],
  ["CAGR %", (m) => m.cagrPct, 2],
  ["Max drawdown %", (m) => m.maxDrawdownPct, 2],
  ["Sharpe", (m) => m.sharpe, 2],
  ["Annualised vol %", (m) => m.annualisedVolPct, 2],
  ["Calmar", (m) => m.calmar, 2],
  ["Win rate %", (m) => m.winRatePct, 1],
  ["Trades / year", (m) => m.tradesPerYear, 1],
  ["Avg hold (bars)", (m) => m.avgHoldBars, 1],
  ["Fee drag %", (m) => m.feeDragPct, 2],
  ["End cash %", (m) => m.finalCashPct, 1],
];
console.log(
  [pad("Metric", 18), pad("position", 10), pad("swing", 10), pad("delta", 10)].join(" "),
);
console.log("-".repeat(52));
for (const [label, f, d] of metrics) {
  const p = agg("position", f);
  const s = agg("swing", f);
  console.log(
    [pad(label, 18), pad(p.toFixed(d), 10), pad(s.toFixed(d), 10), pad((s - p >= 0 ? "+" : "") + (s - p).toFixed(d), 10)].join(" "),
  );
}

console.log("\nExit mix (share of exits, averaged):");
for (const style of ["position", "swing"]) {
  const cells = cmp.averaged.filter((m) => m.style === style);
  const totals: Record<string, number> = {};
  for (const c of cells) for (const [k, v] of Object.entries(c.exitMix)) totals[k] = (totals[k] ?? 0) + v;
  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const parts = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${((v / sum) * 100).toFixed(0)}%`);
  console.log(`  ${pad(style, 9)}  ${parts.join("  ")}`);
}

// ------------------------------------- gross of costs (isolates the rules)
const gross = await compareTradingStyles(
  (style) => parseRiskConfig({ trading_style: style }),
  { feePerTrade: 0 },
);
const aggG = (style: string, f: (m: StyleRunMetrics) => number) => {
  const xs = gross.averaged.filter((m) => m.style === style).map(f);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
};
console.log("\nGross of commission (£0/trade) — rules only, no fee drag:");
console.log([pad("Metric", 18), pad("position", 10), pad("swing", 10), pad("delta", 10)].join(" "));
console.log("-".repeat(52));
for (const [label, f, d] of metrics) {
  const p = aggG("position", f);
  const s = aggG("swing", f);
  console.log(
    [pad(label, 18), pad(p.toFixed(d), 10), pad(s.toFixed(d), 10), pad((s - p >= 0 ? "+" : "") + (s - p).toFixed(d), 10)].join(" "),
  );
}
