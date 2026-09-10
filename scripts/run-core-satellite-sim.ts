// Does leaving most of the account in cash cost real money?
//
//   bun run scripts/run-core-satellite-sim.ts
//   bun run scripts/run-core-satellite-sim.ts --core 0.6 --core-symbol VWRL.L --from 2023-01-01
//
// Two arms on the same real daily closes and the same signals:
//
//   all-satellite  — today's policy: the whole NAV is available to the trading
//                    engine, and whatever it does not deploy sits in cash.
//   core+satellite — a fixed share of NAV is bought once into a broad
//                    diversified tracker and held; the rest funds the same
//                    trading engine with the same rules.
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { runGovernorReplay, type ReplayBar } from "../src/lib/backtest/governor-replay";
import { assumptionsFromFlags, describeAssumptions } from "../src/lib/backtest/execution-assumptions";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DEFAULT = [
  "AAPL", "MSFT", "NVDA", "JNJ", "XOM", "TSLA", "V",
  "SPY", "QQQ", "VUSA.L", "VWRL.L", "ISF.L", "ULVR.L", "TSCO.L",
];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "9833"));
const coreShare = Number(arg("core", "0.6"));
const coreSymbol = arg("core-symbol", "VWRL.L");
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const foreign = arg("foreign", "AAPL,MSFT,NVDA,JNJ,XOM,TSLA,V,SPY,QQQ")
  .split(",").map((s) => s.trim()).filter(Boolean);
const weight = Number(arg("weight", "0.12"));

let assumptions = assumptionsFromFlags(argv);
if (argv.includes("--assumptions") && argv[argv.indexOf("--assumptions") + 1] === "auto") {
  const { loadAutoAssumptions } = await import("../src/lib/backtest/auto-assumptions.server");
  const auto = await loadAutoAssumptions();
  assumptions = auto.assumptions;
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

const coreCloses = bars
  .map((b) => ({ date: b.date, px: b.closes[coreSymbol] }))
  .filter((r): r is { date: string; px: number } => Number.isFinite(r.px));
if (coreCloses.length < 30) {
  console.error(`No usable price history for the core holding ${coreSymbol}.`);
  process.exit(1);
}

const base = {
  foreignSymbols: foreign,
  sizing: "revised" as const,
  targetWeightPct: weight,
  signal: "cross" as const,
  assumptions,
  maxPositionPctOfNav: 0.15,
  maxDiversifiedPositionPctOfNav: 0.35,
};

const allSatellite = runGovernorReplay(bars, "revised", { ...base, startingCash: nav });

// Core arm: buy the tracker once on the first bar it prices, hold to the end.
const coreCash = nav * coreShare;
const entry = coreCloses[0]!;
// LSE trackers quote in pence on this tape.
const entryPx = coreSymbol.endsWith(".L") ? entry.px / 100 : entry.px;
const coreUnits = Math.floor(coreCash / entryPx);
const coreSpent = coreUnits * entryPx;
// One round trip of dealing cost on the core, at the account's measured rate.
const coreCost = coreSpent * 0.009;
const satellite = runGovernorReplay(bars, "revised", {
  ...base,
  startingCash: nav - coreSpent - coreCost,
});

const coreValueOn = (date: string) => {
  let px = entryPx;
  for (const c of coreCloses) {
    if (c.date > date) break;
    px = coreSymbol.endsWith(".L") ? c.px / 100 : c.px;
  }
  return coreUnits * px;
};

// Combined curve = satellite equity + marked core value, so drawdown is
// measured on the whole account, not on the trading sleeve alone.
let peak = 0;
let maxDd = 0;
let finalCombined = nav;
for (const point of satellite.equityCurve) {
  const total = point.equity + coreValueOn(point.date);
  finalCombined = total;
  peak = Math.max(peak, total);
  if (peak > 0) maxDd = Math.max(maxDd, (peak - total) / peak);
}

const coreFinal = coreValueOn(bars.at(-1)!.date);

console.log(`bars ${bars.length} (${bars[0]?.date} → ${bars.at(-1)?.date})`);
console.log(`assumptions: ${describeAssumptions(assumptions)}`);
console.log(`starting NAV £${nav}\n`);

console.log("=== all-satellite (today's policy) ===");
console.log(
  `final £${allSatellite.finalEquity.toFixed(0)}  return ${allSatellite.totalReturnPct.toFixed(2)}%  ` +
    `maxDD ${allSatellite.maxDrawdownPct.toFixed(2)}%  trades ${allSatellite.trades.length}  ` +
    `friction £${allSatellite.frictionPaid.toFixed(0)}`,
);

console.log(`\n=== core ${(coreShare * 100).toFixed(0)}% ${coreSymbol} + satellite ===`);
console.log(
  `core: ${coreUnits} units at £${entryPx.toFixed(2)} = £${coreSpent.toFixed(0)} ` +
    `(dealing £${coreCost.toFixed(0)}) → £${coreFinal.toFixed(0)}`,
);
console.log(
  `satellite: final £${satellite.finalEquity.toFixed(0)}  trades ${satellite.trades.length}  ` +
    `friction £${satellite.frictionPaid.toFixed(0)}`,
);
console.log(
  `combined: final £${finalCombined.toFixed(0)}  return ${((finalCombined / nav - 1) * 100).toFixed(2)}%  ` +
    `maxDD ${(maxDd * 100).toFixed(2)}%`,
);

const delta = (finalCombined / nav - 1) * 100 - allSatellite.totalReturnPct;
console.log(
  `\ndifference: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% return, ` +
    `${(maxDd * 100 - allSatellite.maxDrawdownPct).toFixed(2)}% drawdown, ` +
    `£${(finalCombined - allSatellite.finalEquity).toFixed(0)} on a £${nav} book`,
);
