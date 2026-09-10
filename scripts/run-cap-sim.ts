// Full-portfolio simulation of the diversified-fund cap on real daily closes.
//
//   bun run scripts/run-cap-sim.ts
//   bun run scripts/run-cap-sim.ts --nav 9833 --from 2023-01-01 --assumptions auto
//
// Two arms, identical signals, cash, fills and cost governor. The only
// difference is the position cap:
//
//   single-cap     — every name, including broad index trackers, sits under
//                    the 15% single-name cap (the old rule).
//   diversified    — broad diversified trackers sit under the wider 35% cap;
//                    single stocks and concentrating funds stay at 15%.
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  runGovernorReplay,
  type ArmOutcome,
  type ReplayBar,
} from "../src/lib/backtest/governor-replay";
import {
  assumptionsFromFlags,
  describeAssumptions,
} from "../src/lib/backtest/execution-assumptions";
import { isDiversifiedFund } from "../src/lib/diversified-fund";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DEFAULT = ["AAPL", "MSFT", "NVDA", "JNJ", "XOM", "TSLA", "V", "SPY", "QQQ", "VUSA.L", "VWRL.L", "ISF.L", "ULVR.L", "TSCO.L"];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "9833"));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const foreign = arg("foreign", "AAPL,MSFT,NVDA,JNJ,XOM,TSLA,V,SPY,QQQ")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const weight = Number(arg("weight", "0.12"));
const signal = (arg("signal", "cross") === "churn" ? "churn" : "cross") as "cross" | "churn";

let assumptions = assumptionsFromFlags(argv);
if (argv[argv.indexOf("--assumptions") + 1] === "auto" && argv.includes("--assumptions")) {
  const { loadAutoAssumptions } = await import("../src/lib/backtest/auto-assumptions.server");
  const { describeAutoAssumptions } = await import("../src/lib/backtest/auto-assumptions");
  const auto = await loadAutoAssumptions();
  assumptions = auto.assumptions;
  console.log(describeAutoAssumptions(auto));
}

const histories = await fetchUniverseHistory(symbols, { from, to });
const byDate = new Map<string, Record<string, number>>();
for (const h of histories) {
  for (const b of h.bars) {
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    const row = byDate.get(b.date) ?? {};
    row[h.symbol] = b.close;
    byDate.set(b.date, row);
  }
}
const bars: ReplayBar[] = Array.from(byDate.entries())
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([date, closes]) => ({ date, closes }));

const base = {
  startingCash: nav,
  foreignSymbols: foreign,
  sizing: "revised" as const,
  targetWeightPct: weight,
  signal,
  assumptions,
  maxPositionPctOfNav: 0.15,
};

const singleCap = runGovernorReplay(bars, "revised", {
  ...base,
  maxDiversifiedPositionPctOfNav: 0.15,
});
const diversified = runGovernorReplay(bars, "revised", {
  ...base,
  maxDiversifiedPositionPctOfNav: 0.35,
});

function allocations(o: ArmOutcome) {
  const rows = new Map<string, { deployed: number; net: number; cost: number; n: number }>();
  for (const t of o.trades) {
    const r = rows.get(t.symbol) ?? { deployed: 0, net: 0, cost: 0, n: 0 };
    r.deployed += t.notional;
    r.net += t.netPnl;
    r.cost += t.cost;
    r.n += 1;
    rows.set(t.symbol, r);
  }
  return Array.from(rows.entries()).sort((a, b) => b[1].deployed - a[1].deployed);
}

function summary(label: string, o: ArmOutcome) {
  const rows = allocations(o);
  const deployed = rows.reduce((s, [, r]) => s + r.deployed, 0);
  const net = rows.reduce((s, [, r]) => s + r.net, 0);
  console.log(`\n=== ${label} ===`);
  console.log(
    `final equity £${o.finalEquity.toFixed(0)}  return ${o.totalReturnPct.toFixed(2)}%  ` +
      `maxDD ${o.maxDrawdownPct.toFixed(2)}%  trades ${o.trades.length}  ` +
      `friction £${o.frictionPaid.toFixed(0)} (${o.frictionBpsOfEquity.toFixed(0)}bps)`,
  );
  console.log(
    `cash deployed over the run £${deployed.toFixed(0)}  ` +
      `expected profit £${net.toFixed(0)}  sized-up tickets ${o.buysSizedUp}  blocked ${o.buysBlocked}`,
  );
  console.log("symbol        kind          tickets   cash used     costs     net P&L");
  for (const [sym, r] of rows) {
    console.log(
      [
        sym.padEnd(13),
        (isDiversifiedFund({ symbol: sym }) ? "diversified" : "single name").padEnd(13),
        String(r.n).padStart(7),
        `£${r.deployed.toFixed(0)}`.padStart(11),
        `£${r.cost.toFixed(0)}`.padStart(10),
        `£${r.net.toFixed(0)}`.padStart(11),
      ].join(" "),
    );
  }
}

console.log(`bars: ${bars.length} (${bars[0]?.date} → ${bars.at(-1)?.date})`);
console.log(`assumptions: ${describeAssumptions(assumptions)}`);
console.log(`starting NAV £${nav}  target weight ${(weight * 100).toFixed(0)}%  signal ${signal}`);

summary("15% cap on everything (old rule)", singleCap);
summary("35% cap for broad trackers (new rule)", diversified);

const delta = diversified.totalReturnPct - singleCap.totalReturnPct;
console.log(
  `\ndifference: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% return, ` +
    `${(diversified.maxDrawdownPct - singleCap.maxDrawdownPct).toFixed(2)}% drawdown, ` +
    `£${(diversified.finalEquity - singleCap.finalEquity).toFixed(0)} on a £${nav} book`,
);
