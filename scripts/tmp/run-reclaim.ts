import { runSetupBacktestAcrossMarket } from "../../src/lib/backtest/setup-scan-backtest.server";
const days = Number(process.argv[2] ?? 1095);
const r = await runSetupBacktestAcrossMarket({ limit: 24, lookbackDays: days });
console.log(JSON.stringify({
  years: (r.lookbackDays/365).toFixed(1), signals: r.signals, symbolsTested: r.symbolsTested,
  verdict: r.verdict, chase: { entries: r.chase.entries, skipped: r.chase.skipped, adverse: r.chase.avgMaxAdversePct, stop: r.chase.stopRatePct, h: r.chase.horizons },
  discipline: { entries: r.discipline.entries, skipped: r.discipline.skipped, adverse: r.discipline.avgMaxAdversePct, stop: r.discipline.stopRatePct, h: r.discipline.horizons },
  errors: r.errors,
}, null, 1));
