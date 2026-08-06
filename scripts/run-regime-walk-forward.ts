// Regime-segmented walk-forward backtest.
//
//   bun run scripts/run-regime-walk-forward.ts
//   bun run scripts/run-regime-walk-forward.ts --style swing --ticket "5 x 18%"
//   bun run scripts/run-regime-walk-forward.ts --train 252 --test 126 --max-dd 25
//
//   # denser cross-validation: 75%-overlapping windows, capped at 60 draws,
//   # keeping every bear/sideways slice the tape can offer
//   bun run scripts/run-regime-walk-forward.ts --overlap 0.75 --cv-max 60 \
//     --cv-per-regime 25 --cv-min-per-regime 8 --min-eff 3
//
// Runs the optimised parameter set out-of-sample on rolling windows, tags
// each window bull / bear / sideways from the benchmark tape, then reports
// net CAGR and drawdown per regime so the strategy can be judged on
// stability rather than on one flattering all-history number.
//
// Non-overlapping windows (the default) are statistically clean but sparse,
// and bear/sideways regimes often draw only two or three slices. `--overlap`
// slides the window by a fraction of the test length instead of a whole test
// length, and the CV sampler thins the resulting dense candidate set back to
// a manageable, regime-balanced draw. Because overlapping slices share bars,
// every regime also reports an independence-adjusted "eff. windows" count,
// and `--min-eff` gates on that rather than the raw count.


import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import {
  annualisedPct,
  benchmarkIndex,
  buildRegimeReport,
  classifyRegimeBars,
  curveCagrPct,
  curveMaxDrawdownPct,
  dominantRegimeWeighted,
  regimeCoverage,

  formatRegimeTable,
  formatWindowTable,
  regimeTableRows,
  segmentRegimes,
  summariseReport,
  walkForwardWindows,
  resolveWalkForwardStep,
  sampleRegimeBalancedWindows,
  effectiveWindowCount,
  meanWindowOverlap,
  windowTableRows,
  REGIME_COLUMNS,
  WINDOW_COLUMNS,
  type RegimeGate,
  type WindowResult,
} from "../src/lib/regime-walk-forward";
import { renderBacktestReportHtml, type ReportPanel } from "../src/lib/backtest-report-chart";
import type { RiskLevel } from "../src/lib/risk-sim-matrix";
import type { TradingStyle } from "../src/lib/trading-style";
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "SPY", "GLD"];

const from = arg("from", "2015-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const mode = arg("mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const riskLevel = arg("risk", "balanced") as RiskLevel;
const style = arg("style", "swing") as TradingStyle;
const maxNames = Number(arg("names", "5"));
const perNameWeight = Number(arg("weight", "0.18"));
const trainBars = Number(arg("train", "252"));
const testBars = Number(arg("test", "126"));
// `--overlap 0..0.95` shares that fraction of each test slice with the next
// window. An explicit `--step` still wins. Default 0 = disjoint slices.
const overlapPct = Number(arg("overlap", "0"));
const explicitStep = argv.includes("--step") ? Number(arg("step", String(testBars))) : undefined;
const step = resolveWalkForwardStep({ trainBars, testBars, step: explicitStep, overlapPct });

// Cross-validation sampling of the (possibly dense) candidate windows.
const cvMaxWindows = Number(arg("cv-max", "0")); // 0 = keep everything
const cvPerRegime = Number(arg("cv-per-regime", "0")); // 0 = uncapped
const cvMinPerRegime = Number(arg("cv-min-per-regime", "0"));
const cvSeed = Number(arg("cv-seed", "1"));

// The optimised cost assumptions the parameter set was chosen under.
const FRICTIONS = {
  commissionBps: Number(arg("commission-bps", "8")),
  minCommission: Number(arg("minfee", "3")),
  buyTaxBps: 0,
  slippageBps: Number(arg("slippage", "5")),
  impactPerUnit: 0.0002,
};

const gate: RegimeGate = {
  maxDrawdownPct: Number(arg("max-dd", "25")),
  minMedianCagrPct: Number(arg("min-cagr", "0")),
  minPositiveRate: Number(arg("min-hit", "0.5")),
  minEffectiveWindows: Number(arg("min-eff", "0")),
};


console.log(
  `Parameter set: ${riskLevel} · ${style} · ${maxNames} x ${(perNameWeight * 100).toFixed(0)}% · ` +
    `${FRICTIONS.commissionBps}bps + £${FRICTIONS.minCommission} min, ${FRICTIONS.slippageBps}bps slippage`,
);
console.log(
  `Gate: drawdown >= -${gate.maxDrawdownPct}%, median net CAGR >= ${gate.minMedianCagrPct}%, ` +
    `>= ${Math.round(gate.minPositiveRate * 100)}% of windows profitable`,
);

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
console.log(`Tape: ${tape.bars.length} bars, ${tape.symbols.length} symbols (mode=${mode}).`);

const index = benchmarkIndex(tape.bars);
const regimeBars = classifyRegimeBars(index, {
  bullAnnualPct: Number(arg("bull-annual", "10")),
  bearAnnualPct: Number(arg("bear-annual", "-10")),
  bearDrawdownPct: Number(arg("bear-dd", "15")),
  sidewaysBandPct: Number(arg("sideways-band", "6")),
  sidewaysRangePct: Number(arg("sideways-range", "8")),
  minTrendR2: Number(arg("min-r2", "0.35")),
});
const labels = regimeBars.map((b) => b.label);
const coverage = regimeCoverage(regimeBars);
console.log("\nRegime coverage (per bar):");
for (const r of ["bull", "bear", "sideways"] as const) {
  console.log(
    `  ${r.padEnd(8)} ${String(coverage[r].bars).padStart(5)} bars  ` +
      `${(coverage[r].share * 100).toFixed(1).padStart(5)}%  ` +
      `mean confidence ${(coverage[r].meanConfidence * 100).toFixed(0)}%`,
  );
}

const segments = segmentRegimes(index, labels);
console.log(`\nRegime segments (${segments.length}):`);
for (const s of segments) {
  console.log(`  ${s.label.padEnd(8)} ${s.from} → ${s.to}  (${s.bars} bars)`);
}


const candidates = walkForwardWindows(tape.bars.length, { trainBars, testBars, step });
if (candidates.length === 0) throw new Error("history too short for the requested train/test split");
console.log(
  `\nWalk-forward: ${candidates.length} candidate windows of ${trainBars} train + ${testBars} test bars ` +
    `(step ${step}${overlapPct > 0 && explicitStep == null ? `, ${Math.round(overlapPct * 100)}% overlap` : ""}).`,
);

// Label every candidate up front so the CV sampler can balance regimes
// BEFORE we spend a backtest on each window.
const minShare = Number(arg("min-share", "0.45"));
const minConf = Number(arg("min-conf", "0.5"));
const labelled = candidates.map((w) => ({
  window: w,
  regime: dominantRegimeWeighted(regimeBars, w.testStart, w.testEnd, {
    minDirectionalShare: minShare,
    minConfidence: minConf,
  }),
}));

const sample = sampleRegimeBalancedWindows(labelled, (c) => c.regime.label, {
  maxWindows: cvMaxWindows > 0 ? cvMaxWindows : undefined,
  perRegimeCap: cvPerRegime > 0 ? cvPerRegime : undefined,
  minPerRegime: cvMinPerRegime > 0 ? cvMinPerRegime : undefined,
  seed: cvSeed,
});
const windows = sample.selected;
if (windows.length < labelled.length) console.log(`CV sampling: ${sample.note} (seed ${cvSeed}).`);
console.log(
  `Independence: ${effectiveWindowCount(windows.map((w) => w.window)).toFixed(1)} effective windows, ` +
    `mean overlap ${Math.round(meanWindowOverlap(windows.map((w) => w.window)) * 100)}%.`,
);

const cfg = parseRiskConfig({ trading_style: style } as never);
const results: WindowResult[] = [];

for (const { window: w, regime } of windows) {

  // The strategy warms up on the training slice and is scored only on the
  // out-of-sample tail, so indicators are never cold at the window open.
  const bars = tape.bars.slice(w.trainStart, w.testEnd);
  const m = await runStyleBacktest({
    cfg,
    bars,
    riskLevel,
    startingCash,
    feePerTrade: 0,
    sleeve: { maxNames, perNameWeight },
    simulator: { frictions: FRICTIONS },
  });
  const oosCurve = m.equityCurve.slice(w.testStart - w.trainStart);
  if (oosCurve.length < 2) continue;



  const benchStart = index[w.testStart]!.value;
  const benchEnd = index[w.testEnd - 1]!.value;
  const years = (w.testEnd - w.testStart) / 252;

  const row: WindowResult = {
    window: w,
    regime: regime.label,
    purity: regime.purity,
    confidence: regime.confidence,
    demoted: regime.demoted,
    from: tape.bars[w.testStart]!.date,
    to: tape.bars[w.testEnd - 1]!.date,

    netCagrPct: curveCagrPct(oosCurve),
    maxDrawdownPct: curveMaxDrawdownPct(oosCurve),
    benchmarkCagrPct: annualisedPct(benchStart, benchEnd, w.testEnd - w.testStart - 1),
    trades: m.trades,
    tradesPerYear: years > 0 ? m.trades / years : m.trades,
    feeDragPct: m.feeDragPct,
    sharpe: m.sharpe,
  };
  results.push(row);
  console.log(
    `  #${String(w.index).padStart(2)} ${row.from} → ${row.to}  ${row.regime.padEnd(8)} ` +
      `conf ${Math.round(regime.confidence * 100).toString().padStart(3)}%` +
      `${regime.demoted ? "*" : " "} ` +
      `CAGR ${row.netCagrPct.toFixed(1).padStart(7)}%  maxDD ${row.maxDrawdownPct.toFixed(1).padStart(6)}%  ` +
      `bench ${row.benchmarkCagrPct.toFixed(1).padStart(7)}%  trades/yr ${row.tradesPerYear.toFixed(0)}`,
  );

}

const report = buildRegimeReport(results, gate);
console.log("\nPer-regime walk-forward results:");
console.log(formatRegimeTable(report.summaries));
console.log(`\n${summariseReport(report, gate)}`);

for (const s of report.summaries) {
  if (s.windows === 0) {
    console.log(
      `  ${s.regime}: no out-of-sample window landed in this regime — widen --from or raise --overlap.`,
    );
  } else if (!s.sufficientEvidence) {
    console.log(
      `  ${s.regime}: only ${s.effectiveWindows.toFixed(1)} independent windows (${s.windows} raw at ` +
        `${Math.round(s.overlapShare * 100)}% overlap) vs the --min-eff ${gate.minEffectiveWindows} ` +
        `requirement — verdict withheld, lengthen the history rather than the overlap.`,
    );
  } else if (!s.drawdownStable) {

    console.log(
      `  ${s.regime}: drawdown breach — worst ${s.worstMaxDrawdownPct.toFixed(1)}% vs the ` +
        `-${gate.maxDrawdownPct}% ceiling.`,
    );
  } else if (!s.pass) {
    console.log(
      `  ${s.regime}: drawdown holds but returns do not — median CAGR ` +
        `${s.medianNetCagrPct.toFixed(1)}%, ${Math.round(s.positiveRate * 100)}% of windows profitable.`,
    );
  }
}

// ---------------------------------------------------------------- report
const panels: ReportPanel[] = [
  {
    heading: "Per-regime walk-forward summary",
    subtitle: summariseReport(report, gate),
    series: [],
    table: { columns: [...REGIME_COLUMNS], rows: regimeTableRows(report.summaries) },
  },
  {
    heading: "Out-of-sample windows",
    subtitle:
      `${riskLevel} · ${style} · ${maxNames} x ${(perNameWeight * 100).toFixed(0)}% · ` +
      `${trainBars} train / ${testBars} test bars`,
    series: [],
    table: { columns: [...WINDOW_COLUMNS], rows: windowTableRows(results) },
  },
  {
    heading: "Regime segments",
    subtitle: "benchmark index labelled from trailing trend and drawdown",
    series: [],
    table: {
      columns: ["regime", "from", "to", "bars"],
      rows: segments.map((s) => [s.label, s.from, s.to, String(s.bars)]),
    },
  },
];

console.log("\n", formatWindowTable(results));

mkdirSync("reports", { recursive: true });
const outPath = "reports/regime-walk-forward.html";
writeFileSync(
  outPath,
  renderBacktestReportHtml({ title: `Regime walk-forward · ${from} → ${to}`, panels }),
);
console.log(`\nReport written to ${outPath}`);
