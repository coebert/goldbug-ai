// Cost-floor sweep: which round-trip cost floor (and safety multiple) maximises P&L?
//
//   bun run scripts/run-cost-floor-sweep.ts
//   bun run scripts/run-cost-floor-sweep.ts --from 2021-01-01 --floors 0,45,90,135 --safety 1,1.25,1.5,2
//
// Replays real daily closes through the revised cost governor with the live
// net-of-cost edge gate switched on, once per (floor bps × safety multiple)
// cell. Everything else — signals, sizing, fills, fee model — is identical, so
// the only thing that varies is how hard the gate refuses cheap-edge buys.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { runGovernorReplay, type ReplayBar } from "../src/lib/backtest/governor-replay";
import { assumptionsFromFlags, describeAssumptions } from "../src/lib/backtest/execution-assumptions";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const nums = (s: string) => s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

const DEFAULT = ["AAPL", "MSFT", "JPM", "XOM", "JNJ", "SPY", "QQQ", "GLD", "TLT", "IWM"];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "10300"));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const floors = nums(arg("floors", "0,30,45,60,90,120,150,200"));
const safeties = nums(arg("safety", "1,1.25,1.5,2"));
const signal = (arg("signal", "churn") === "cross" ? "cross" : "churn") as "cross" | "churn";
const assumptions = assumptionsFromFlags(argv);

console.log(`Cost-floor sweep ${from} → ${to} | ${symbols.length} symbols | signal=${signal}`);
console.log(`Assumptions: ${describeAssumptions(assumptions)}`);

const history = await fetchUniverseHistory(symbols, from, to);
const byDate = new Map<string, Record<string, number>>();
for (const [sym, rows] of Object.entries(history)) {
  for (const r of rows as Array<{ date: string; close: number }>) {
    if (!Number.isFinite(r.close)) continue;
    const d = byDate.get(r.date) ?? {};
    d[sym.toUpperCase()] = r.close;
    byDate.set(r.date, d);
  }
}
const bars: ReplayBar[] = Array.from(byDate.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([date, closes]) => ({ date, closes }));
console.log(`${bars.length} bars\n`);

type Cell = {
  floorBps: number;
  safety: number;
  returnPct: number;
  finalEquity: number;
  maxDdPct: number;
  trades: number;
  blocked: number;
  frictionBps: number;
  netPnl: number;
};

const cells: Cell[] = [];
for (const floorBps of floors) {
  for (const safety of safeties) {
    const out = runGovernorReplay(bars, "revised", {
      startingCash: nav,
      foreignSymbols: symbols,
      signal,
      assumptions,
      netEdgeGate: true,
      netEdgeFloorBps: floorBps,
      edgeSafetyMultiple: safety,
    });
    cells.push({
      floorBps,
      safety,
      returnPct: out.totalReturnPct,
      finalEquity: out.finalEquity,
      maxDdPct: out.maxDrawdownPct,
      trades: out.trades.length,
      blocked: out.buysBlocked,
      frictionBps: out.frictionBpsOfEquity,
      netPnl: out.trades.reduce((a, t) => a + t.netPnl, 0),
    });
  }
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(
  `${pad("floor", 6)} ${pad("safety", 7)} ${pad("return%", 9)} ${pad("maxDD%", 8)} ${pad("trades", 7)} ${pad("blocked", 8)} ${pad("frictBps", 9)} ${pad("netPnL", 9)}`,
);
for (const c of cells) {
  console.log(
    `${pad(c.floorBps, 6)} ${pad(c.safety.toFixed(2), 7)} ${pad(c.returnPct.toFixed(2), 9)} ${pad(c.maxDdPct.toFixed(2), 8)} ${pad(c.trades, 7)} ${pad(c.blocked, 8)} ${pad(c.frictionBps.toFixed(0), 9)} ${pad(c.netPnl.toFixed(0), 9)}`,
  );
}

const best = [...cells].sort((a, b) => b.returnPct - a.returnPct)[0]!;
const bestRisk = [...cells]
  .filter((c) => c.returnPct > 0)
  .sort((a, b) => b.returnPct / Math.max(1, b.maxDdPct) - a.returnPct / Math.max(1, a.maxDdPct))[0];

console.log(
  `\nBest P&L: floor ${best.floorBps}bps × safety ${best.safety} → ${best.returnPct.toFixed(2)}% ` +
    `(maxDD ${best.maxDdPct.toFixed(2)}%, ${best.trades} round trips, friction ${best.frictionBps.toFixed(0)}bps)`,
);
if (bestRisk) {
  console.log(
    `Best return/drawdown: floor ${bestRisk.floorBps}bps × safety ${bestRisk.safety} → ` +
      `${bestRisk.returnPct.toFixed(2)}% / ${bestRisk.maxDdPct.toFixed(2)}%DD`,
  );
}
