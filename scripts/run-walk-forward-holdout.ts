// Walk-forward WITH a final rolling holdout, on real market history.
//
//   bun run scripts/run-walk-forward-holdout.ts
//   bun run scripts/run-walk-forward-holdout.ts --holdout 365 --train 504 --test 126
//
// Walk-forward alone stops being honest once the research loop has iterated on
// its folds. This harness carves a slice off the END of history BEFORE folds
// are built, tunes the sleeve grid fold by fold on the remainder, freezes the
// most-selected parameter set, and replays it once over the untouched tail in
// consecutive rolling segments.
//
// Frictions default to the live cost-governor assumptions, so the verdict is
// net of the costs the real account actually pays.

import { parseRiskConfig } from "../src/lib/universe.server";
import { runStyleBacktest } from "../src/lib/trading-style-backtest";
import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import {
  assessHoldout,
  buildFoldsWithHoldout,
  withHoldout,
  type HoldoutSegmentResult,
} from "../src/lib/walk-forward-holdout";
import {
  selectBestParams,
  summariseWalkForward,
  type FoldMetrics,
  type FoldOutcome,
  type SelectionObjective,
  type WalkForwardMode,
} from "../src/lib/walk-forward";
import { benchmarkIndex, annualisedPct } from "../src/lib/regime-walk-forward";
import type { RiskLevel } from "../src/lib/risk-sim-matrix";
import type { TradingStyle } from "../src/lib/trading-style";

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
const trainDays = Number(arg("train", "504"));
const testDays = Number(arg("test", "126"));
const wfMode = arg("mode-wf", "rolling") as WalkForwardMode;
const objective = arg("objective", "sharpe") as SelectionObjective;
const maxFolds = Number(arg("max-folds", "8"));
const holdoutDays = Number(arg("holdout", "365"));
const segmentDays = Number(arg("segment", "0"));

// Live cost-governor assumptions: Saxo-style commission with a hard minimum.
const FRICTIONS = {
  commissionBps: Number(arg("commission-bps", "8")),
  minCommission: Number(arg("minfee", "3")),
  buyTaxBps: 0,
  slippageBps: Number(arg("slippage", "5")),
  impactPerUnit: 0.0002,
};

type Params = { maxNames: number; perNameWeight: number };
const GRID: Params[] = [
  { maxNames: 4, perNameWeight: 0.22 },
  { maxNames: 5, perNameWeight: 0.18 },
  { maxNames: 6, perNameWeight: 0.15 },
  { maxNames: 8, perNameWeight: 0.11 },
];

console.log(`Fetching real daily history ${from} → ${to} for ${symbols.length} symbols…`);
const histories = await fetchUniverseHistory(symbols, { from, to });
const tape = buildRealTape(histories, { mode, from, to });
const dates = tape.bars.map((b) => b.date);
console.log(`Tape: ${tape.bars.length} bars ${dates[0]} → ${dates[dates.length - 1]} (mode=${mode}).`);

const index = benchmarkIndex(tape.bars);
const cfg = parseRiskConfig({ trading_style: style } as never);

/** First bar on/after a date, and last bar on/before a date. */
const startIdx = (d: string) => dates.findIndex((x) => x >= d);
const endIdx = (d: string) => {
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i]! <= d) return i;
  return -1;
};

async function score(
  warmFrom: number,
  scoreFrom: number,
  scoreTo: number,
  params: Params,
): Promise<FoldMetrics | null> {
  if (scoreTo - scoreFrom < 5) return null;
  const bars = tape.bars.slice(warmFrom, scoreTo + 1);
  const m = await runStyleBacktest({
    cfg,
    bars,
    riskLevel,
    startingCash,
    feePerTrade: 0,
    sleeve: { maxNames: params.maxNames, perNameWeight: params.perNameWeight },
    simulator: { frictions: FRICTIONS },
  });
  // Warm up on everything before the scored slice; only the tail is measured.
  const curve = m.equityCurve.slice(scoreFrom - warmFrom);
  if (curve.length < 2) return null;
  const first = curve[0]!.total_value;
  const last = curve[curve.length - 1]!.total_value;
  const totalReturnPct = ((last - first) / first) * 100;
  const days = curve.length;
  const years = Math.max(0.05, days / 252);
  let peak = first;
  let maxDd = 0;
  const rets: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i]!.total_value;
    if (v > peak) peak = v;
    maxDd = Math.min(maxDd, ((v - peak) / peak) * 100);
    if (i > 0) rets.push(curve[i]!.total_value / curve[i - 1]!.total_value - 1);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1
    ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1))
    : 0;
  return {
    totalReturnPct,
    cagrPct: (Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100,
    maxDrawdownPct: maxDd,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    volatilityPct: sd * Math.sqrt(252) * 100,
    days,
  };
}

function benchMetrics(a: number, b: number): FoldMetrics {
  const start = index[a]!.value;
  const end = index[b]!.value;
  const days = b - a + 1;
  const totalReturnPct = ((end - start) / start) * 100;
  let peak = start;
  let maxDd = 0;
  for (let i = a; i <= b; i++) {
    const v = index[i]!.value;
    if (v > peak) peak = v;
    maxDd = Math.min(maxDd, ((v - peak) / peak) * 100);
  }
  return {
    totalReturnPct,
    cagrPct: annualisedPct(start, end, Math.max(1, days - 1)),
    maxDrawdownPct: maxDd,
    sharpe: 0,
    volatilityPct: 0,
    days,
  };
}

const { folds, split } = buildFoldsWithHoldout({
  from: dates[0]!,
  to: dates[dates.length - 1]!,
  trainDays,
  testDays,
  mode: wfMode,
  maxFolds,
  holdoutDays,
  ...(segmentDays > 0 ? { segmentDays } : {}),
});

console.log(
  `\nTrainable ${split.trainable.from} → ${split.trainable.to} · holdout ${
    split.holdout ? `${split.holdout.from} → ${split.holdout.to} (${split.segments.length} segments)` : `none (${split.note})`
  }`,
);
console.log(`Walk-forward: ${folds.length} folds of ${trainDays}d train + ${testDays}d test (${wfMode}, objective ${objective}).`);

const outcomes: Array<FoldOutcome<Params>> = [];
for (const fold of folds) {
  const trainA = startIdx(fold.train.from);
  const trainB = endIdx(fold.train.to);
  const testA = startIdx(fold.test.from);
  const testB = endIdx(fold.test.to);
  if (trainA < 0 || testA < 0 || testB <= testA) continue;

  const candidates: Array<{ params: Params; metrics: FoldMetrics }> = [];
  for (const params of GRID) {
    const m = await score(trainA, trainA, trainB, params);
    if (m) candidates.push({ params, metrics: m });
  }
  const best = selectBestParams(candidates, objective);
  if (!best) continue;
  const oos = await score(trainA, testA, testB, best.params);
  if (!oos) continue;
  outcomes.push({
    fold,
    params: best.params,
    inSample: best.metrics,
    outOfSample: oos,
    benchmark: benchMetrics(testA, testB),
  });
  console.log(
    `  fold ${String(fold.index).padStart(2)} ${fold.test.from} → ${fold.test.to}  ` +
      `params ${best.params.maxNames}x${(best.params.perNameWeight * 100).toFixed(0)}%  ` +
      `IS sharpe ${best.metrics.sharpe.toFixed(2)}  OOS sharpe ${oos.sharpe.toFixed(2)}  ` +
      `OOS ret ${oos.totalReturnPct.toFixed(1)}%  maxDD ${oos.maxDrawdownPct.toFixed(1)}%`,
  );
}

const summary = summariseWalkForward(outcomes);

// Freeze the most-selected parameter set (ties broken by mean OOS Sharpe).
const buckets = new Map<string, { params: Params; n: number; sharpe: number }>();
for (const o of outcomes) {
  const k = `${o.params.maxNames}|${o.params.perNameWeight}`;
  const b = buckets.get(k) ?? { params: o.params, n: 0, sharpe: 0 };
  b.n += 1;
  b.sharpe += o.outOfSample.sharpe;
  buckets.set(k, b);
}
const frozen = [...buckets.values()].sort((a, b) => b.n - a.n || b.sharpe / b.n - a.sharpe / a.n)[0]?.params ?? null;

const segments: HoldoutSegmentResult[] = [];
if (frozen && split.holdout) {
  const warm = startIdx(split.trainable.from);
  console.log(`\nHoldout replay with frozen params ${frozen.maxNames}x${(frozen.perNameWeight * 100).toFixed(0)}%:`);
  for (const [i, w] of split.segments.entries()) {
    const a = startIdx(w.from);
    const b = endIdx(w.to);
    if (a < 0 || b <= a) continue;
    const m = await score(Math.max(0, warm), a, b, frozen);
    if (!m) continue;
    segments.push({ index: i, window: w, metrics: m, benchmark: benchMetrics(a, b) });
    console.log(
      `  seg ${i} ${w.from} → ${w.to}  ret ${m.totalReturnPct.toFixed(1)}%  sharpe ${m.sharpe.toFixed(2)}  ` +
        `maxDD ${m.maxDrawdownPct.toFixed(1)}%  bench ${benchMetrics(a, b).totalReturnPct.toFixed(1)}%`,
    );
  }
}

const holdout = assessHoldout(segments, outcomes.length ? summary : null);
const final = withHoldout(summary, holdout);

console.log("\n── WALK-FORWARD ──");
console.log(
  `folds ${outcomes.length} · OOS sharpe ${summary.oosSharpe.toFixed(2)} · OOS CAGR ${summary.oosCagrPct.toFixed(1)}% · verdict ${summary.verdict}`,
);
console.log("\n── HOLDOUT ──");
console.log(holdout.sentence);
console.log(
  `segments ${holdout.segments} · total ${holdout.totalReturnPct}% · CAGR ${holdout.cagrPct}% · sharpe ${holdout.sharpe} · ` +
    `hit ${Math.round(holdout.segmentHitRate * 100)}% · retention ${holdout.retention ?? "n/a"} · maxDD ${holdout.maxDrawdownPct}% · ` +
    `bench ${holdout.benchmarkReturnPct ?? "n/a"}% · excess ${holdout.excessReturnPct ?? "n/a"}pp`,
);
console.log(`\nFINAL VERDICT: ${final.verdict}`);
for (const r of final.reasons) console.log(`  • ${r}`);
