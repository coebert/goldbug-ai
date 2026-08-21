// Cost sensitivity report: how the governor replay changes across fee,
// spread and slippage ranges, for each assumptions preset.
//
//   bun run scripts/run-preset-cost-sensitivity.ts
//   bun run scripts/run-preset-cost-sensitivity.ts --presets realistic,pessimistic
//   bun run scripts/run-preset-cost-sensitivity.ts --spread 0,10,25,50 --slippage 0,5,15
//   bun run scripts/run-preset-cost-sensitivity.ts --fee-schedule ./saxo-classic.json
//
// With --fee-schedule the imported tariff (commission, per-ticket floor, stamp
// duty, PTM levy) replaces the built-in model before the sweep runs, so the
// ladder is centred on what the broker actually charges this account.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { runGovernorReplay, type ReplayBar } from "../src/lib/backtest/governor-replay";
import {
  runCostSensitivity,
  costSensitivityReportText,
  type CostAxis,
} from "../src/lib/backtest/preset-cost-sensitivity";
import type { AssumptionPresetId } from "../src/lib/backtest/execution-assumptions";
import { importFeeSchedule } from "../src/lib/backtest/fee-schedule-import";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const nums = (s: string) => s.split(",").map((x) => Number(x.trim())).filter(Number.isFinite);

const DEFAULT = ["AAPL", "MSFT", "JPM", "XOM", "JNJ", "SPY", "QQQ", "GLD", "TLT", "IWM"];
const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const nav = Number(arg("nav", "10300"));
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim());
const presets = arg("presets", "").split(",").map((s) => s.trim()).filter(Boolean) as AssumptionPresetId[];

const schedulePath = arg("fee-schedule", "");
let floorOverride: number | null = null;
if (schedulePath) {
  const { defaults, schedule, warnings } = importFeeSchedule(readFileSync(schedulePath, "utf8"));
  for (const w of warnings) console.warn(`fee schedule: ${w}`);
  if (!defaults || !schedule) {
    console.error("fee schedule unusable — aborting");
    process.exit(1);
  }
  floorOverride = defaults.commissionFloorBase;
  console.log(
    `fee schedule: ${defaults.note}\n  commissionMult ${defaults.commissionMult}x, ` +
      `stampMult ${defaults.stampMult}, ptmLevy ${defaults.ptmLevy}, ` +
      `floor ${defaults.commissionFloorBase ?? "venue minimum"}\n`,
  );
}

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

const ladders: Partial<Record<CostAxis, number[]>> = {};
if (arg("fees", "")) ladders.fees = nums(arg("fees", ""));
if (arg("spread", "")) ladders.spread = nums(arg("spread", ""));
if (arg("slippage", "")) ladders.slippage = nums(arg("slippage", ""));

const report = runCostSensitivity(
  (assumptions) => {
    const out = runGovernorReplay(bars, "revised", {
      startingEquity: nav,
      assumptions: floorOverride === null ? assumptions : { ...assumptions, commissionFloorBase: floorOverride },
    });
    return {
      totalReturnPct: out.totalReturnPct,
      maxDrawdownPct: out.maxDrawdownPct,
      tradesAdmitted: out.buysAdmitted,
      frictionBpsOfEquity: out.frictionBpsOfEquity,
    };
  },
  { presets: presets.length ? presets : undefined, ladders },
);

console.log(`bars: ${bars.length} (${bars[0]?.date} → ${bars.at(-1)?.date})\n`);
console.log(costSensitivityReportText(report));
