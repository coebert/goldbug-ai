// Swing vs position backtest driven by the REAL AI decision policy.
//
//   bun run scripts/run-ai-trading-style-backtest.ts
//
// Each cell replays one seeded tape through the mechanical risk/exit engine
// with the AI gateway as the discretionary decision layer (entries and
// discretionary exits). The deterministic heuristic layer is run over the same
// cells as a control, so the table separates "what the style rules do" from
// "what the AI does with them".
import { parseRiskConfig } from "../src/lib/universe.server";
import {
  runStyleBacktest,
  averageStyleRuns,
  heuristicStylePolicy,
  type StyleRunMetrics,
} from "../src/lib/trading-style-backtest";
import { createAiStylePolicy, type AiStylePolicyStats } from "../src/lib/ai-style-policy.server";
import { buildPriceTape, DEFAULT_UNIVERSE, type RiskLevel } from "../src/lib/risk-sim-matrix";
import type { TradingStyle } from "../src/lib/trading-style";
import {
  renderBacktestReportHtml,
  type ChartSeries,
  type ReportPanel,
} from "../src/lib/backtest-report-chart";
import { mkdirSync, writeFileSync } from "node:fs";

const key = process.env["LOVABLE_API_KEY"];
if (!key) throw new Error("LOVABLE_API_KEY missing");

const SEEDS = [20260731, 771];
const BARS = Number(process.env["AI_BT_BARS"] ?? 126); // 6 months
const RISK: RiskLevel[] = ["balanced", "high"];
const STYLES: TradingStyle[] = ["position", "swing"];
const CADENCE = Number(process.env["AI_BT_CADENCE"] ?? 5); // weekly decisions
const START = 10_300;
const FEE = 3;

const cfgs: Record<TradingStyle, ReturnType<typeof parseRiskConfig>> = {
  position: parseRiskConfig({ trading_style: "position" }),
  swing: parseRiskConfig({ trading_style: "swing" }),
};

const stats: AiStylePolicyStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  repaired: 0,
  emptyDecisions: 0,
  orders: 0,
};

type Cell = { seed: number; riskLevel: RiskLevel; style: TradingStyle; layer: "ai" | "heuristic" };
const cells: Cell[] = [];
for (const seed of SEEDS)
  for (const riskLevel of RISK)
    for (const style of STYLES)
      for (const layer of ["ai", "heuristic"] as const)
        cells.push({ seed, riskLevel, style, layer });

const tapes = new Map(SEEDS.map((s) => [s, buildPriceTape(DEFAULT_UNIVERSE, BARS, s)] as const));

console.log(
  `Running ${cells.length} cells | ${BARS} bars | AI decisions every ${CADENCE} bars | model gemini-2.5-flash`,
);

const results = await Promise.all(
  cells.map(async (c) => {
    const policy =
      c.layer === "ai"
        ? createAiStylePolicy({
            apiKey: key,
            cadenceBars: CADENCE,
            tag: `${c.style}:${c.riskLevel}:${c.seed}:${BARS}`,
            stats,
          })
        : heuristicStylePolicy;
    const m = await runStyleBacktest({
      cfg: cfgs[c.style],
      bars: tapes.get(c.seed)!,
      riskLevel: c.riskLevel,
      startingCash: START,
      feePerTrade: FEE,
      policy,
    });
    return { ...c, metrics: { ...m, style: c.style, horizon: "6M", seed: c.seed } as StyleRunMetrics };
  }),
);

const pad = (s: string | number, n: number) => String(s).padStart(n);
const num = (v: number, d = 2, n = 8) => pad(v.toFixed(d), n);

const header = [
  pad("Layer", 10), pad("Risk", 9), pad("Style", 9),
  pad("Ret%", 8), pad("CAGR%", 8), pad("MaxDD%", 8), pad("Sharpe", 7),
  pad("Vol%", 7), pad("Calmar", 7), pad("Win%", 6), pad("Trd/y", 7),
  pad("Hold", 6), pad("Fee%", 6), pad("Cash%", 7),
].join(" ");
console.log(`\nSeeds averaged per cell: ${SEEDS.join(", ")}  |  start £${START}  |  £${FEE}/trade\n`);
console.log(header);
console.log("-".repeat(header.length));

type Key = `${"ai" | "heuristic"}|${RiskLevel}|${TradingStyle}`;
const averaged = new Map<Key, StyleRunMetrics>();
for (const layer of ["ai", "heuristic"] as const) {
  for (const riskLevel of RISK) {
    for (const style of STYLES) {
      const cell = results.filter(
        (r) => r.layer === layer && r.riskLevel === riskLevel && r.style === style,
      );
      const m = averageStyleRuns(cell.map((r) => r.metrics));
      averaged.set(`${layer}|${riskLevel}|${style}`, m);
      console.log(
        [
          pad(layer, 10), pad(riskLevel, 9), pad(style, 9),
          num(m.totalReturnPct), num(m.cagrPct), num(m.maxDrawdownPct), num(m.sharpe, 2, 7),
          num(m.annualisedVolPct, 2, 7), num(m.calmar, 2, 7), num(m.winRatePct, 1, 6),
          num(m.tradesPerYear, 1, 7), num(m.avgHoldBars, 1, 6), num(m.feeDragPct, 2, 6),
          num(m.finalCashPct, 1, 7),
        ].join(" "),
      );
    }
    console.log("");
  }
}

const metrics: Array<[string, (m: StyleRunMetrics) => number, number]> = [
  ["Total return %", (m) => m.totalReturnPct, 2],
  ["CAGR %", (m) => m.cagrPct, 2],
  ["Max drawdown %", (m) => m.maxDrawdownPct, 2],
  ["Sharpe", (m) => m.sharpe, 2],
  ["Calmar", (m) => m.calmar, 2],
  ["Win rate %", (m) => m.winRatePct, 1],
  ["Trades / year", (m) => m.tradesPerYear, 1],
  ["Avg hold (bars)", (m) => m.avgHoldBars, 1],
  ["Fee drag %", (m) => m.feeDragPct, 2],
  ["End cash %", (m) => m.finalCashPct, 1],
];

for (const layer of ["ai", "heuristic"] as const) {
  console.log(`\nSwing minus position — ${layer} decision layer (avg over risk levels):`);
  console.log([pad("Metric", 18), pad("position", 10), pad("swing", 10), pad("delta", 10)].join(" "));
  console.log("-".repeat(52));
  const avgOf = (style: TradingStyle, f: (m: StyleRunMetrics) => number) =>
    RISK.map((r) => f(averaged.get(`${layer}|${r}|${style}`)!)).reduce((a, b) => a + b, 0) / RISK.length;
  for (const [label, f, d] of metrics) {
    const p = avgOf("position", f);
    const s = avgOf("swing", f);
    console.log(
      [
        pad(label, 18), pad(p.toFixed(d), 10), pad(s.toFixed(d), 10),
        pad((s - p >= 0 ? "+" : "") + (s - p).toFixed(d), 10),
      ].join(" "),
    );
  }
}

// Exit mix tells you which layer actually closed the trades.
console.log("\nExit mix by layer/style (share of exits):");
for (const layer of ["ai", "heuristic"] as const) {
  for (const style of STYLES) {
    const mixes = RISK.map((r) => averaged.get(`${layer}|${r}|${style}`)!.exitMix);
    const merged: Record<string, number> = {};
    for (const mix of mixes)
      for (const [k, v] of Object.entries(mix)) merged[k] = (merged[k] ?? 0) + v;
    const total = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
    const parts = Object.entries(merged)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${((v / total) * 100).toFixed(0)}%`)
      .join("  ");
    console.log(`  ${pad(layer, 10)} ${pad(style, 9)}  ${parts || "none"}`);
  }
}

console.log(
  `\nAI policy: ${stats.calls} model calls, ${stats.cacheHits} cache hits, ${stats.failures} schema misses (${stats.repaired} repaired), ` +
    `${stats.orders} orders across ${stats.calls + stats.cacheHits} decisions (${stats.emptyDecisions} no-action).`,
);

// ---- Visual report: equity curve + drawdown per risk level -----------------
const SERIES_COLOUR: Record<TradingStyle, string> = {
  position: "#4da3ff",
  swing: "#33d69f",
};

const panels: ReportPanel[] = RISK.map((riskLevel) => {
  const series: ChartSeries[] = [];
  for (const layer of ["ai", "heuristic"] as const) {
    for (const style of STYLES) {
      const m = averaged.get(`${layer}|${riskLevel}|${style}`)!;
      series.push({
        label: `${layer} · ${style}`,
        colour: SERIES_COLOUR[style],
        dashed: layer === "heuristic",
        curve: m.equityCurve,
      });
    }
  }
  const rows = series.map((s) => {
    const [layer, style] = s.label.split(" · ") as ["ai" | "heuristic", TradingStyle];
    const m = averaged.get(`${layer}|${riskLevel}|${style}`)!;
    return [
      s.label,
      m.totalReturnPct.toFixed(2),
      m.maxDrawdownPct.toFixed(2),
      m.sharpe.toFixed(2),
      m.calmar.toFixed(2),
      m.tradesPerYear.toFixed(1),
      m.feeDragPct.toFixed(2),
      m.finalCashPct.toFixed(1),
    ];
  });
  return {
    heading: `${riskLevel} risk`,
    subtitle: `solid = AI decision layer, dashed = heuristic control · seeds ${SEEDS.join(", ")} averaged`,
    series,
    table: {
      columns: ["Cell", "Ret%", "MaxDD%", "Sharpe", "Calmar", "Trd/y", "Fee%", "Cash%"],
      rows,
    },
  };
});

const html = renderBacktestReportHtml({
  title: "Swing vs position — AI backtest report",
  subtitle: `${BARS} bars · AI decisions every ${CADENCE} bars · start £${START} · £${FEE}/trade · gemini-2.5-flash`,
  panels,
});

const outDir = process.env["AI_BT_OUT_DIR"] ?? "/mnt/documents";
mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/trading-style-backtest.html`;
writeFileSync(outPath, html);
console.log(`\nChart report written to ${outPath}`);
