// Sizing-policy replay on real daily closes (investigation plan, stage D).
//
//   bun run scripts/run-sizing-replay.ts
//   bun run scripts/run-sizing-replay.ts --from 2023-01-01 --nav 10300 --signal churn
//   bun run scripts/run-sizing-replay.ts --assumptions auto
//
// Both arms run the revised cost governor (decaying friction bucket + one
// high-edge reserve ticket) and identical signals/fills. The only difference:
//
//   legacy  — a sub-viable ticket is thrown away; every name, including broad
//             index trackers, sits under the 15% single-name cap.
//   revised — an under-sized ticket is raised to the fee-viable floor when
//             cash and the cap allow, and broad diversified funds sit under
//             the wider 35% cap.
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  compareSizingArms,
  sizingReplayReport,
  type ReplayBar,
} from "../src/lib/backtest/governor-replay";
import {
  assumptionsFromFlags,
  describeAssumptions,
} from "../src/lib/backtest/execution-assumptions";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

// A mix the live book actually trades: US single names, UK single names and
// broad trackers (the ones the wider cap applies to).
const DEFAULT = ["AAPL", "MSFT", "JNJ", "XOM", "TSLA", "SPY", "QQQ", "VOO", "VUSA.L", "ISF.L"];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "10300"));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const foreign = arg("foreign", "AAPL,MSFT,JNJ,XOM,TSLA,SPY,QQQ,VOO")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const floor = Number(arg("viable-floor", "250"));
const floorBps = Number(arg("net-edge-floor-bps", "90"));
const weight = Number(arg("weight", "0.12"));
const signal = (arg("signal", "cross") === "churn" ? "churn" : "cross") as "cross" | "churn";

let assumptions = assumptionsFromFlags(argv);
if (argv.includes("--assumptions") && argv[argv.indexOf("--assumptions") + 1] === "auto") {
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

console.log(`bars: ${bars.length} (${bars[0]?.date} → ${bars.at(-1)?.date})`);
console.log(`assumptions: ${describeAssumptions(assumptions)}`);
console.log(`nav £${nav}  viable floor £${floor}  net-edge floor ${floorBps}bps  weight ${(weight*100).toFixed(1)}%  signal ${signal}\n`);

const cmp = compareSizingArms(bars, {
  startingCash: nav,
  foreignSymbols: foreign,
  viableFloorBase: floor,
  netEdgeFloorBps: floorBps,
  signal,
  targetWeightPct: weight,
  assumptions,
});

console.log(sizingReplayReport(cmp));

for (const arm of [cmp.legacy, cmp.revised]) {
  const byReason = new Map<string, number>();
  for (const b of arm.blocked) {
    const key = b.reason.split(":")[0]!;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  console.log(`\n${arm.sizing} blocked reasons:`);
  for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${r}`);
  const sample = arm.blocked.slice(0, 3).map((b) => `${b.date} ${b.symbol} £${b.notional.toFixed(0)} — ${b.reason}`);
  for (const line of sample) console.log(`  e.g. ${line}`);
}
