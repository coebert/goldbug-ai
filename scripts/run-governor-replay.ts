// Cost-governor + FX-leg replay on real daily closes.
//
//   bun run scripts/run-governor-replay.ts
//   bun run scripts/run-governor-replay.ts --from 2021-01-01 --to 2026-08-20
//   bun run scripts/run-governor-replay.ts --symbols AAPL,MSFT,SPY --nav 10300
//
// Execution assumptions (fees / spread / slippage) are configurable:
//   --assumptions optimistic|live|realistic|pessimistic|frictionless
//   --spread-bps 20 --slippage-bps 5 --impact-bps 8 --impact-ref 10000
//   --delay-bps 2 --commission-mult 1.25 --commission-floor 3 --fx-spread-bps 6
//   --no-stamp --no-ptm
// Both arms are always priced under the same assumptions.
//
// Two arms, identical signals/sizing/fills:
//   legacy  — hard 30d friction sum, no high-edge reserve, raw FX amount
//   revised — decaying friction bucket, one reserve ticket, floored FX amount

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  compareGovernorArms,
  governorReplayReport,
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

const DEFAULT = ["AAPL", "MSFT", "JPM", "XOM", "JNJ", "SPY", "QQQ", "GLD", "TLT", "IWM"];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "10300"));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
// Everything on this list is USD-quoted for a GBP account, so each buy needs
// an FX funding leg — the exact path that was silently killing USD buys.
const foreign = arg("foreign", symbols.join(",")).split(",").map((s) => s.trim());
const seed = Number(arg("seed-friction", "0"));
const assumptions = assumptionsFromFlags(argv);
const signal = (arg("signal", "cross") === "churn" ? "churn" : "cross") as "cross" | "churn";

const histories = await fetchUniverseHistory(symbols, { from, to });
const byDate = new Map<string, Record<string, number>>();
for (const h of histories) {
  for (const b of h.bars) {
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    const day = String(b.date).slice(0, 10);
    const row = byDate.get(day) ?? {};
    row[h.symbol] = b.close;
    byDate.set(day, row);
  }
}
const bars: ReplayBar[] = Array.from(byDate.entries())
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([date, closes]) => ({ date, closes }));

if (bars.length < 220) {
  console.error(`not enough history: ${bars.length} bars for ${symbols.join(",")}`);
  process.exit(1);
}

console.log(`\n${symbols.length} symbols, ${bars.length} bars, ${bars[0]!.date} → ${bars.at(-1)!.date}, NAV £${nav}, signal=${signal}\nassumptions: ${describeAssumptions(assumptions)}\n`);

const windows: Array<{ label: string; slice: ReplayBar[] }> = [
  { label: "full period", slice: bars },
];
// Yearly sub-periods, so the verdict isn't a single-regime artefact.
const years = Array.from(new Set(bars.map((b) => b.date.slice(0, 4)))).sort();
for (const y of years) {
  const idx = bars.findIndex((b) => b.date.slice(0, 4) === y);
  const slice = bars.slice(Math.max(0, idx - 210)); // warm-up for SMA200
  const end = slice.findIndex((b) => b.date.slice(0, 4) > y);
  windows.push({ label: y, slice: end > 0 ? slice.slice(0, end) : slice });
}

for (const w of windows) {
  if (w.slice.length < 220) continue;
  const cmp = compareGovernorArms(w.slice, {
    startingCash: nav,
    foreignSymbols: foreign,
    signal,
    seedFrictionBase: seed,
    assumptions,
  });
  console.log(`── ${w.label} (${w.slice.length} bars)`);
  console.log(governorReplayReport(cmp));
  const topMissed = cmp.legacy.blocked
    .filter((b) => b.forwardNetPnl > 0)
    .sort((a, b) => b.forwardNetPnl - a.forwardNetPnl)
    .slice(0, 3);
  for (const m of topMissed) {
    console.log(`   legacy missed ${m.symbol} ${m.date}: +£${m.forwardNetPnl.toFixed(0)} — ${m.reason.slice(0, 90)}`);
  }
  console.log("");
}
