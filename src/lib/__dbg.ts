import { findSignals, runSetupBacktest } from "./backtest/setup-scan-backtest";
function hist(after:number[]){const closes:number[]=[];let p=100;
for(let i=0;i<200;i++){p*=1.003;closes.push(p);}
for(let i=0;i<12;i++){p*=0.975;closes.push(p);}
for(let i=0;i<5;i++){p*=1.07;closes.push(p);}
closes.push(...after);
return closes.map((close,i)=>({date:String(i),close,high:close*1.02,low:close*0.97,volume:i>=212?700000:1000000}));}
const c=hist([180,172,165,168,175,182,190,196,200,205,210,215]);
const s=findSignals("PB",c);
console.log(s.map(x=>[x.index,x.match.price.toFixed(1),x.match.zoneLow.toFixed(1),x.match.zoneHigh.toFixed(1),x.match.invalidationBelow.toFixed(1)]));
console.log(JSON.stringify(runSetupBacktest([{symbol:"PB",candles:c}],{horizons:[5],pullbackWindow:10,frictionBps:40,cooldownDays:20}).trades,null,1));
