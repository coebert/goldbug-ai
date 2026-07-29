// Retail-mania guardrail backtest — quantifies drawdown reduction and
// opportunity cost across the curated 2020–2023 episode set in
// `retail-mania-episodes.ts`.
//
// Two policies are compared per snapshot:
//   - Baseline    : always take the long entry at the snapshot close.
//   - Guardrail   : if `detectRetailMania(snapshot).blockNewBuys` is true,
//                   sit out (0 return, 0 drawdown); otherwise take the long.
//
// Metrics reported:
//   - Mean and median forward 20-day return.
//   - Worst forward 20-day return (tail).
//   - Mean and worst 60-day max drawdown.
//   - Confusion matrix:
//       * true-positive block  : blocked, forward 20d ≤ 0
//       * false-positive block : blocked, forward 20d > 0  (missed reversal)
//       * false-negative       : NOT blocked, was mania, forward 20d < 0
//       * true-negative        : NOT blocked, non-mania
//   - By-year averages so we can see 2021 (peak mania) separately from 2023.
//
// Pure module — no I/O, no random. Safe to run in tests, server functions,
// or a UI card.
import {
  RETAIL_MANIA_EPISODES,
  type EpisodeSnapshot,
} from "./retail-mania-episodes";
import { detectRetailMania, type ManiaTier } from "./retail-mania";

export type PolicyStats = {
  n: number;
  meanForward20d: number;
  medianForward20d: number;
  worstForward20d: number;
  bestForward20d: number;
  meanMaxDrawdown60d: number;
  worstMaxDrawdown60d: number;
};

export type ConfusionMatrix = {
  truePositiveBlocks: number; // blocked and would have lost money in 20d
  falsePositiveBlocks: number; // blocked but 20d was positive (opportunity cost)
  falseNegatives: number; // not blocked, was mania, 20d < 0 (guardrail miss)
  trueNegatives: number; // not blocked, non-mania
  blockPrecision: number; // TP / (TP + FP)
  blockRecall: number; // TP / total mania snapshots
};

export type PerEpisode = {
  symbol: string;
  date: string;
  isMania: boolean;
  tier: ManiaTier;
  score: number;
  blocked: boolean;
  forwardReturn20d: number;
  maxDrawdown60d: number;
  note: string;
};

export type BacktestReport = {
  totalSnapshots: number;
  maniaSnapshots: number;
  controlSnapshots: number;
  baseline: PolicyStats;
  guardrail: PolicyStats;
  drawdownReduction: {
    meanAbs: number; // baseline mean DD − guardrail mean DD (positive = safer)
    worstAbs: number;
    meanPct: number; // % reduction relative to baseline mean DD
    worstPct: number;
  };
  opportunityCost: {
    blockedProfitableCount: number;
    blockedProfitableRate: number; // FP / total blocks
    meanForwardOfBlockedProfitable: number;
  };
  confusion: ConfusionMatrix;
  byYear: Record<string, { baseline: PolicyStats; guardrail: PolicyStats }>;
  perEpisode: PerEpisode[];
};

function stats(rows: Array<{ ret: number; dd: number }>): PolicyStats {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      meanForward20d: 0,
      medianForward20d: 0,
      worstForward20d: 0,
      bestForward20d: 0,
      meanMaxDrawdown60d: 0,
      worstMaxDrawdown60d: 0,
    };
  }
  const rets = rows.map((r) => r.ret).sort((a, b) => a - b);
  const dds = rows.map((r) => r.dd).sort((a, b) => a - b);
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 === 0 ? (rets[n / 2 - 1] + rets[n / 2]) / 2 : rets[(n - 1) / 2];
  const meanDD = dds.reduce((s, x) => s + x, 0) / n;
  return {
    n,
    meanForward20d: mean,
    medianForward20d: median,
    worstForward20d: rets[0],
    bestForward20d: rets[n - 1],
    meanMaxDrawdown60d: meanDD,
    worstMaxDrawdown60d: dds[0],
  };
}

export function runRetailManiaBacktest(
  episodes: EpisodeSnapshot[] = RETAIL_MANIA_EPISODES,
): BacktestReport {
  const perEpisode: PerEpisode[] = [];
  const baselineRows: Array<{ ret: number; dd: number }> = [];
  const guardrailRows: Array<{ ret: number; dd: number }> = [];

  const byYearBaseline: Record<string, Array<{ ret: number; dd: number }>> = {};
  const byYearGuardrail: Record<string, Array<{ ret: number; dd: number }>> = {};

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let blockedProfitableSum = 0;

  const maniaCount = episodes.filter((e) => e.isMania).length;

  for (const ep of episodes) {
    const sig = detectRetailMania(ep);
    const blocked = sig.blockNewBuys;
    const year = ep.date.slice(0, 4);
    byYearBaseline[year] ??= [];
    byYearGuardrail[year] ??= [];

    baselineRows.push({ ret: ep.forwardReturn20d, dd: ep.maxDrawdown60d });
    byYearBaseline[year].push({ ret: ep.forwardReturn20d, dd: ep.maxDrawdown60d });

    if (blocked) {
      // Sit out: no return, no drawdown exposure.
      guardrailRows.push({ ret: 0, dd: 0 });
      byYearGuardrail[year].push({ ret: 0, dd: 0 });
    } else {
      guardrailRows.push({ ret: ep.forwardReturn20d, dd: ep.maxDrawdown60d });
      byYearGuardrail[year].push({ ret: ep.forwardReturn20d, dd: ep.maxDrawdown60d });
    }

    // Confusion matrix
    if (blocked) {
      if (ep.forwardReturn20d <= 0) tp += 1;
      else {
        fp += 1;
        blockedProfitableSum += ep.forwardReturn20d;
      }
    } else {
      if (ep.isMania && ep.forwardReturn20d < 0) fn += 1;
      else if (!ep.isMania) tn += 1;
    }

    perEpisode.push({
      symbol: ep.symbol,
      date: ep.date,
      isMania: ep.isMania,
      tier: sig.tier,
      score: sig.score,
      blocked,
      forwardReturn20d: ep.forwardReturn20d,
      maxDrawdown60d: ep.maxDrawdown60d,
      note: ep.note,
    });
  }

  const baseline = stats(baselineRows);
  const guardrail = stats(guardrailRows);

  const blocks = tp + fp;
  const confusion: ConfusionMatrix = {
    truePositiveBlocks: tp,
    falsePositiveBlocks: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    blockPrecision: blocks === 0 ? 0 : tp / blocks,
    blockRecall: maniaCount === 0 ? 0 : tp / maniaCount,
  };

  const meanAbs = guardrail.meanMaxDrawdown60d - baseline.meanMaxDrawdown60d; // less negative = positive number
  const worstAbs = guardrail.worstMaxDrawdown60d - baseline.worstMaxDrawdown60d;
  const meanPct = baseline.meanMaxDrawdown60d === 0
    ? 0
    : (meanAbs / Math.abs(baseline.meanMaxDrawdown60d));
  const worstPct = baseline.worstMaxDrawdown60d === 0
    ? 0
    : (worstAbs / Math.abs(baseline.worstMaxDrawdown60d));

  const byYear: BacktestReport["byYear"] = {};
  for (const y of Object.keys(byYearBaseline).sort()) {
    byYear[y] = {
      baseline: stats(byYearBaseline[y]),
      guardrail: stats(byYearGuardrail[y]),
    };
  }

  return {
    totalSnapshots: episodes.length,
    maniaSnapshots: maniaCount,
    controlSnapshots: episodes.length - maniaCount,
    baseline,
    guardrail,
    drawdownReduction: { meanAbs, worstAbs, meanPct, worstPct },
    opportunityCost: {
      blockedProfitableCount: fp,
      blockedProfitableRate: blocks === 0 ? 0 : fp / blocks,
      meanForwardOfBlockedProfitable: fp === 0 ? 0 : blockedProfitableSum / fp,
    },
    confusion,
    byYear,
    perEpisode,
  };
}

/** Human-readable one-page report — suitable for console logs or a UI card. */
export function formatBacktestReport(r: BacktestReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const s = (p: PolicyStats) =>
    `n=${p.n}  meanR=${pct(p.meanForward20d)}  medR=${pct(p.medianForward20d)}  ` +
    `worstR=${pct(p.worstForward20d)}  meanDD=${pct(p.meanMaxDrawdown60d)}  ` +
    `worstDD=${pct(p.worstMaxDrawdown60d)}`;

  const lines: string[] = [];
  lines.push("Retail-mania guardrail backtest — 2020–2023");
  lines.push(
    `Snapshots: ${r.totalSnapshots} (mania=${r.maniaSnapshots}, controls=${r.controlSnapshots})`,
  );
  lines.push("");
  lines.push(`Baseline  (always buy) : ${s(r.baseline)}`);
  lines.push(`Guardrail (skip mania) : ${s(r.guardrail)}`);
  lines.push("");
  lines.push(
    `Drawdown reduction — mean : ${pct(r.drawdownReduction.meanAbs)} abs, ` +
      `${pct(r.drawdownReduction.meanPct)} of baseline`,
  );
  lines.push(
    `Drawdown reduction — worst: ${pct(r.drawdownReduction.worstAbs)} abs, ` +
      `${pct(r.drawdownReduction.worstPct)} of baseline`,
  );
  lines.push("");
  lines.push(
    `Confusion — TP=${r.confusion.truePositiveBlocks} FP=${r.confusion.falsePositiveBlocks} ` +
      `FN=${r.confusion.falseNegatives} TN=${r.confusion.trueNegatives}  ` +
      `precision=${pct(r.confusion.blockPrecision)} recall=${pct(r.confusion.blockRecall)}`,
  );
  lines.push(
    `Opportunity cost — ${r.opportunityCost.blockedProfitableCount} block(s) ` +
      `had positive 20d ret (${pct(r.opportunityCost.blockedProfitableRate)} of blocks), ` +
      `mean missed = ${pct(r.opportunityCost.meanForwardOfBlockedProfitable)}`,
  );
  lines.push("");
  lines.push("By year:");
  for (const [y, v] of Object.entries(r.byYear)) {
    lines.push(`  ${y}  baseline  ${s(v.baseline)}`);
    lines.push(`  ${y}  guardrail ${s(v.guardrail)}`);
  }
  return lines.join("\n");
}
