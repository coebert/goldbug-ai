// Thesis-break exit replay on real daily closes.
//
//   bun run scripts/run-thesis-break-backtest.ts
//   bun run scripts/run-thesis-break-backtest.ts --from 2019-01-01 --symbols AAPL,MKS.L
//
// Two arms, identical entries: stop-only vs stop + thesis-break (with the
// decaying loss post-mortem memory tightening stops on repeat losers).

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  runThesisBreakReplay,
  type ReplayTape,
  type ArmResult,
} from "../src/lib/backtest/thesis-break-replay";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DEFAULT = ["AAPL", "MKS.L", "MSFT", "NVDA", "JPM", "XOM", "KO", "SPY", "GLD", "TSLA"];
const from = arg("from", "2018-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());

const pad = (s: string | number, n: number) => String(s).padStart(n);

const histories = await fetchUniverseHistory(symbols, { from, to });
const tape: ReplayTape = {};
for (const h of histories) {
  const bars = h.bars
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .map((b) => ({ date: b.date, close: (b.adjClose ?? b.close) as number }));
  if (bars.length > 60) tape[h.symbol] = bars;
}
const loaded = Object.keys(tape);
console.log(`Tape: ${loaded.length} symbols (${loaded.join(", ")})  ${from} → ${to}\n`);

const { base, tb, firing } = runThesisBreakReplay(tape);

const row = (m: ArmResult) =>
  [
    pad(m.arm, 13),
    pad(m.totalReturnPct.toFixed(2), 9),
    pad(m.maxDrawdownPct.toFixed(2), 9),
    pad(m.winRatePct.toFixed(1), 7),
    pad(m.avgLossPct.toFixed(2), 9),
    pad(m.trades.length, 7),
  ].join(" ");

console.log([pad("Arm", 13), pad("Ret%", 9), pad("MaxDD%", 9), pad("Win%", 7), pad("AvgLoss%", 9), pad("Trades", 7)].join(" "));
console.log("-".repeat(58));
console.log(row(base));
console.log(row(tb));

console.log("\nExit mix (thesis-break arm):");
for (const [k, v] of Object.entries(tb.exitMix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(k, 22)} ${pad(v, 4)}`);
}

console.log("\nThesis-break firings by symbol loss history:");
console.log(
  `  first loss (no prior loss on symbol): ${firing.firstLoss} of ${firing.firstLossOpportunities} losing trades ` +
    `(${firing.firstLossFireRatePct.toFixed(1)}%)`,
);
console.log(
  `  repeat loser (>=1 prior loss):        ${firing.repeatLoser} of ${firing.repeatOpportunities} losing trades ` +
    `(${firing.repeatFireRatePct.toFixed(1)}%)`,
);

const fires = tb.trades.filter((t) => t.thesisBreak).sort((a, b) => a.exitDate.localeCompare(b.exitDate));
console.log(`\nEvery thesis-break cut (${fires.length}):`);
console.log([pad("Symbol", 8), pad("Entry", 11), pad("Exit", 11), pad("Ret%", 8), pad("Prior", 6), "Signals"].join(" "));
for (const t of fires.slice(0, 40)) {
  console.log(
    [
      pad(t.symbol, 8),
      pad(t.entryDate, 11),
      pad(t.exitDate, 11),
      pad((t.returnPct * 100).toFixed(2), 8),
      pad(t.priorLosses, 6),
      t.signals.join("; "),
    ].join(" "),
  );
}

// Per-symbol comparison so a repeat loser like MKS.L is visible on its own.
console.log("\nPer-symbol realised loss (sum of losing round-trips, %):");
const bySym = (r: ArmResult) => {
  const m: Record<string, number> = {};
  for (const t of r.trades) if (t.returnPct < 0) m[t.symbol] = (m[t.symbol] ?? 0) + t.returnPct * 100;
  return m;
};
const a = bySym(base);
const b = bySym(tb);
console.log([pad("Symbol", 8), pad("stop-only", 11), pad("thesis", 11), pad("delta", 9)].join(" "));
for (const s of loaded) {
  const x = a[s] ?? 0;
  const y = b[s] ?? 0;
  console.log([pad(s, 8), pad(x.toFixed(2), 11), pad(y.toFixed(2), 11), pad((y - x >= 0 ? "+" : "") + (y - x).toFixed(2), 9)].join(" "));
}
