// Prints the risk-level × horizon simulation matrix. Run:
//   bun run scripts/run-risk-sim-matrix.ts
import {
  runRiskSimMatrix,
  buildPriceTape,
  buyAndHoldReturnPct,
  DEFAULT_UNIVERSE,
  HORIZONS,
} from "../src/lib/risk-sim-matrix";

const pad = (s: string | number, n: number) => String(s).padStart(n);

const matrix = await runRiskSimMatrix();

console.log(`Universe: ${DEFAULT_UNIVERSE.map((a) => a.symbol).join(", ")}`);
console.log(`Seeds: ${matrix.seeds.join(", ")} (metrics averaged per cell)\n`);

console.log(
  [
    pad("Horizon", 8), pad("Risk", 9), pad("Ret%", 8), pad("CAGR%", 8),
    pad("MaxDD%", 8), pad("Sharpe", 7), pad("Vol%", 7), pad("Calmar", 7),
    pad("Trades", 7), pad("Win%", 6), pad("Cash%", 7), pad("Names", 6),
  ].join(" "),
);
console.log("-".repeat(96));

let lastHorizon = "";
for (const m of matrix.averaged) {
  if (lastHorizon && lastHorizon !== m.horizon) console.log("");
  lastHorizon = m.horizon;
  console.log(
    [
      pad(m.horizon, 8), pad(m.riskLevel, 9),
      pad(m.totalReturnPct.toFixed(2), 8), pad(m.cagrPct.toFixed(2), 8),
      pad(m.maxDrawdownPct.toFixed(2), 8), pad(m.sharpe.toFixed(2), 7),
      pad(m.annualisedVolPct.toFixed(2), 7), pad(m.calmar.toFixed(2), 7),
      pad(m.trades.toFixed(1), 7), pad(m.winRatePct.toFixed(1), 6),
      pad(m.finalCashPct.toFixed(1), 7), pad(m.distinctSymbols.toFixed(1), 6),
    ].join(" "),
  );
}

console.log("\nEqual-weight buy & hold on the same tapes (context):");
for (const h of HORIZONS) {
  const bh =
    matrix.seeds
      .map((s) => buyAndHoldReturnPct(buildPriceTape(DEFAULT_UNIVERSE, h.bars, s)))
      .reduce((a, b) => a + b, 0) / matrix.seeds.length;
  console.log(`  ${pad(h.label, 4)}  ${bh.toFixed(2)}%`);
}
