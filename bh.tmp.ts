import { fetchUniverseHistory } from "./src/lib/real-market-tape.server";
import { buildRealTape } from "./src/lib/real-market-tape";
import { computeMaxDrawdown, computeSharpe, dailyReturns } from "./src/lib/backtest-metrics";
const symbols="VUKE.L,VMID.L,VUSA.L,VWRL.L,HSBA.L,ULVR.L,MKS.L,TSCO.L,BP.L,AAPL".split(",");
const from="2019-01-01", to="2026-09-05", cash=10293.72;
const tape = buildRealTape(await fetchUniverseHistory(symbols,{from,to}),{mode:"total_return",from,to});
function bh(bars:any[]) {
  const first=bars[0]; const names=Object.keys(first.closes); const per=cash/names.length;
  const q:Record<string,number>={}; let c=cash;
  for(const s of names){ const n=Math.floor(per/first.closes[s]); q[s]=n; c-=n*first.closes[s]; }
  return bars.map((b:any)=>({snapshot_date:b.date,total_value:c+names.reduce((a,s)=>a+(q[s]??0)*(b.closes[s]??first.closes[s]),0)}));
}
for (const [label, bars] of [["FULL", tape.bars], ["LIVEWIN", tape.bars.filter((b:any)=>b.date>="2026-07-23")]] as any) {
  const curve=bh(bars); const end=curve.at(-1).total_value; const yrs=bars.length/252;
  console.log(label, JSON.stringify({ bars: bars.length, retPct:+((end/cash-1)*100).toFixed(1), cagrPct:+(((end/cash)**(1/yrs)-1)*100).toFixed(1), ddPct:+computeMaxDrawdown(curve).pct.toFixed(1), sharpe:+computeSharpe(dailyReturns(curve)).toFixed(2) }));
}
