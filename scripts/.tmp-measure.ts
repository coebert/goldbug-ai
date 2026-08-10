import { runBreakoutBacktest, type SymbolBars } from "../src/lib/breakout-backtest";
import { buildBreakoutTimingReport } from "../src/lib/breakout-timing";

const SYMS = ["SPY","QQQ","AAPL","MSFT","NVDA","JPM","XOM","GLD","TLT","IWM","AMZN","META","JNJ","V"];
const series: SymbolBars[] = [];
for (const s of SYMS) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=10y`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j: any = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) { console.log("skip", s); continue; }
  const q = res.indicators.quote[0];
  const bars = res.timestamp.map((t: number, i: number) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
  })).filter((b: any) => b.high != null && b.low != null && b.close != null);
  series.push({ symbol: s, bars });
}
console.log("symbols", series.length, "bars", series.reduce((a, s) => a + s.bars.length, 0));
const rep = runBreakoutBacktest(series, { emitEveryBar: process.env.EVERY === "1" });
console.log("trades", rep.trades.length, rep.from, "->", rep.to, "verdict", rep.edge.verdict);
const t = buildBreakoutTimingReport(rep.trades);
for (const c of t.cohorts) {
  console.log(`\n== ${c.cohort} n=${c.overall.trades} avg=${c.overall.avgReturnPct.toFixed(2)}% avgAge=${c.avgAgeBars.toFixed(1)} lat=${c.avgPendingLatencyBars?.toFixed(1) ?? "-"} decay=${c.ageDecayPctPerBar.toFixed(3)}%/bar`);
  console.log(" age:", c.byAge.map(r => `${r.label}: n=${r.slice.trades} win=${r.slice.winRatePct.toFixed(0)}% avg=${r.expectancyPct.toFixed(2)}%`).join(" | "));
  console.log(" lat:", c.byPendingLatency.map(r => `${r.label}: n=${r.slice.trades} avg=${r.expectancyPct.toFixed(2)}%`).join(" | "));
  console.log(" hold:", c.byHoldTime.map(r => `${r.label}: n=${r.slice.trades} win=${r.slice.winRatePct.toFixed(0)}% avg=${r.expectancyPct.toFixed(2)}%`).join(" | "));
}
console.log("\nRECOMMENDED");
for (const r of t.recommended) {
  console.log(r.cohort, "stale>=", r.staleAgeBars);
  for (const rule of r.rules) console.log(`  ${rule.minAgeBars}-${rule.maxAgeBars} x${rule.mult.toFixed(2)} veto=${rule.veto} n=${rule.trades} exp=${rule.expectancyPct.toFixed(2)}%`);
  r.notes.forEach(n => console.log("   -", n));
}
