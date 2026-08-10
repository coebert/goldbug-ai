import { runBreakoutParamSweep, formatSweepReport, DEFAULT_SWEEP_GRID } from "@/lib/breakout-param-sweep";
import { runBreakoutBacktest, formatBreakoutBacktestReport } from "@/lib/breakout-backtest";
import type { SymbolBars } from "@/lib/breakout-backtest";

const SYMS = ["SPY","QQQ","AAPL","MSFT","NVDA","JPM","XOM","GLD","TLT","IWM"];
const p1 = Math.floor(Date.UTC(2021,0,1)/1000), p2 = Math.floor(Date.now()/1000);
const series: SymbolBars[] = [];
for (const s of SYMS) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${s}?period1=${p1}&period2=${p2}&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j: any = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) { console.log("skip", s, JSON.stringify(j).slice(0,120)); continue; }
  const q = res.indicators.quote[0];
  const bars = res.timestamp.map((t: number, i: number) => ({
    date: new Date(t*1000).toISOString().slice(0,10),
    high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
  })).filter((b: any) => b.high!=null && b.low!=null && b.close!=null);
  series.push({ symbol: s, bars });
  console.log(s, bars.length, bars[0]?.date, "->", bars[bars.length-1]?.date);
}
console.log("\n=== BASELINE (shipped defaults, full window) ===");
console.log(formatBreakoutBacktestReport(runBreakoutBacktest(series, { horizonBars:10, stopAtr:2, targetAtr:3, costBps:20 })));

console.log("\n=== SWEEP ===");
const rep = runBreakoutParamSweep(series, {
  grid: DEFAULT_SWEEP_GRID,
  objective: { minConfirmedTrades: 25, trainFraction: 0.7 },
  backtest: { horizonBars: 10, stopAtr: 2, targetAtr: 3, costBps: 20 },
});
console.log(formatSweepReport(rep, 12));
