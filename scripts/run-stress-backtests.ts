// Stress backtests: the cost-governor + FX-leg replay over high-volatility,
// event-heavy periods, to confirm the revised logic still admits profitable
// trades when the tape is violent.
//
//   bun run scripts/run-stress-backtests.ts
//   bun run scripts/run-stress-backtests.ts --assumptions pessimistic
//   bun run scripts/run-stress-backtests.ts --signal churn --seed-friction 175
//   bun run scripts/run-stress-backtests.ts --windows covid,inflation-2022
//
// Every window is preceded by 210 warm-up bars (SMA200) that neither trade
// nor count toward the window's return, drawdown or friction.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import {
  compareGovernorArms,
  type ReplayBar,
} from "../src/lib/backtest/governor-replay";
import {
  assumptionsFromFlags,
  describeAssumptions,
} from "../src/lib/backtest/execution-assumptions";
import { STRESS_WINDOWS, sliceStressWindow, volStats } from "../src/lib/backtest/stress-windows";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DEFAULT = ["AAPL", "MSFT", "JPM", "XOM", "JNJ", "SPY", "QQQ", "GLD", "TLT", "IWM"];
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const foreign = arg("foreign", symbols.join(",")).split(",").map((s) => s.trim());
const nav = Number(arg("nav", "10300"));
const seed = Number(arg("seed-friction", "0"));
const signal = (arg("signal", "cross") === "churn" ? "churn" : "cross") as "cross" | "churn";
let assumptions = assumptionsFromFlags(argv);
// `--assumptions auto` calibrates fees/spread/slippage from our own bars,
// invoiced fills and realised slippage instead of a hand-picked preset.
if (argv.includes("--assumptions") && argv[argv.indexOf("--assumptions") + 1] === "auto") {
  const { loadAutoAssumptions } = await import("../src/lib/backtest/auto-assumptions.server");
  const { describeAutoAssumptions } = await import("../src/lib/backtest/auto-assumptions");
  const auto = await loadAutoAssumptions();
  assumptions = auto.assumptions;
  console.log(describeAutoAssumptions(auto));
}
const only = arg("windows", "").split(",").map((s) => s.trim()).filter(Boolean);
const reference = arg("reference", "SPY");

const histories = await fetchUniverseHistory(symbols, { from: "2007-01-01" });
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
const dates = bars.map((b) => b.date);

console.log(
  `\nstress backtests — ${symbols.length} symbols, ${bars.length} bars ${dates[0]} → ${dates.at(-1)}, NAV £${nav}, signal=${signal}${seed ? `, seeded friction £${seed}` : ""}`,
);
console.log(`assumptions: ${describeAssumptions(assumptions)}\n`);

type Row = {
  label: string;
  vol: number;
  refDd: number;
  legacyRet: number;
  revisedRet: number;
  legacyDd: number;
  revisedDd: number;
  legacyFills: number;
  revisedFills: number;
  fxRej: number;
  idle: number;
  missed: number;
  verdict: string;
};
const rows: Row[] = [];

for (const w of STRESS_WINDOWS) {
  if (only.length && !only.includes(w.id)) continue;
  const loc = sliceStressWindow(dates, w);
  if (!loc) continue;
  const slice = bars.slice(loc.sliceStart, loc.end + 1);
  if (slice.length - loc.tradeFromIndex < 20) continue;
  if (loc.tradeFromIndex < 200) {
    console.log(`── ${w.label}: skipped (only ${loc.tradeFromIndex} warm-up bars available)\n`);
    continue;
  }

  const refCloses = slice
    .slice(loc.tradeFromIndex)
    .map((b) => b.closes[reference])
    .filter((c): c is number => Number.isFinite(c));
  const v = volStats(refCloses);

  const cmp = compareGovernorArms(slice, {
    startingCash: nav,
    foreignSymbols: foreign,
    signal,
    seedFrictionBase: seed,
    assumptions,
    tradeFromIndex: loc.tradeFromIndex,
  });

  const windowBars = slice.length - loc.tradeFromIndex;
  console.log(`── ${w.label}  ${dates[loc.start]} → ${dates[loc.end]}  (${windowBars} bars)`);
  console.log(`   ${w.note}`);
  console.log(
    `   ${reference}: vol ${v.annualisedVolPct.toFixed(1)}% ann, worst day ${v.worstDayPct.toFixed(1)}%, ${v.bigMoveDaysPct.toFixed(0)}% of days >2%, drawdown ${v.drawdownPct.toFixed(1)}%`,
  );
  const line = (o: (typeof cmp)["legacy"]) =>
    `   ${o.arm.padEnd(8)} return ${`${o.totalReturnPct.toFixed(2)}%`.padStart(8)}  maxDD ${`${o.maxDrawdownPct.toFixed(2)}%`.padStart(7)}  fills ${String(o.buysAdmitted).padStart(3)}  blocked ${String(o.buysBlocked).padStart(3)}  profBlkd ${String(o.profitableBlocked).padStart(3)} (£${o.profitableBlockedPnl.toFixed(0)})  fxRej ${o.fxLegsRejected}/${o.fxLegsAttempted}  idle ${String(o.longestIdleStreakDays).padStart(3)}d  friction ${o.frictionBpsOfEquity.toFixed(0)}bps`;
  console.log(line(cmp.legacy));
  console.log(line(cmp.revised));
  console.log(`   verdict: ${cmp.verdict}\n`);

  rows.push({
    label: w.label,
    vol: v.annualisedVolPct,
    refDd: v.drawdownPct,
    legacyRet: cmp.legacy.totalReturnPct,
    revisedRet: cmp.revised.totalReturnPct,
    legacyDd: cmp.legacy.maxDrawdownPct,
    revisedDd: cmp.revised.maxDrawdownPct,
    legacyFills: cmp.legacy.buysAdmitted,
    revisedFills: cmp.revised.buysAdmitted,
    fxRej: cmp.revised.fxLegsRejected,
    idle: cmp.revised.longestIdleStreakDays,
    missed: cmp.revised.profitableBlockedPnl,
    verdict: cmp.verdict,
  });
}

console.log("═══ summary ═══");
console.log(
  "window                     vol    refDD   legacy   revised    Δret   legacyDD revisedDD  fills L→R  fxRej  idle",
);
for (const r of rows) {
  console.log(
    [
      r.label.padEnd(24),
      `${r.vol.toFixed(0)}%`.padStart(5),
      `${r.refDd.toFixed(0)}%`.padStart(7),
      `${r.legacyRet.toFixed(2)}%`.padStart(8),
      `${r.revisedRet.toFixed(2)}%`.padStart(9),
      `${(r.revisedRet - r.legacyRet >= 0 ? "+" : "") + (r.revisedRet - r.legacyRet).toFixed(2)}%`.padStart(8),
      `${r.legacyDd.toFixed(2)}%`.padStart(9),
      `${r.revisedDd.toFixed(2)}%`.padStart(9),
      `${r.legacyFills}→${r.revisedFills}`.padStart(10),
      String(r.fxRej).padStart(6),
      `${r.idle}d`.padStart(6),
    ].join(" "),
  );
}
const worse = rows.filter((r) => r.revisedRet < r.legacyRet - 0.25);
const ddWorse = rows.filter((r) => r.revisedDd > r.legacyDd + 1);
console.log(
  `\n${rows.length} windows · revised worse on return in ${worse.length} · drawdown worse by >1pt in ${ddWorse.length} · total FX rejections ${rows.reduce((a, r) => a + r.fxRej, 0)}`,
);
