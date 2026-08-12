import { evaluateSetup } from "./setup-scan";
function hist(after:number[]){const closes:number[]=[];let p=100;
for(let i=0;i<200;i++){p*=1.003;closes.push(p);}
for(let i=0;i<20;i++){p*=0.975;closes.push(p);}
for(let i=0;i<5;i++){p*=1.07;closes.push(p);}
closes.push(...after);
return closes.map((close,i)=>({date:new Date(Date.UTC(2020,0,1+i)).toISOString().slice(0,10),close,high:close*1.02,low:close*0.97,volume:i>=220?700000:1000000}));}
const c=hist([]);
for(let i=218;i<c.length;i++){const v=evaluateSetup("T",c.slice(0,i+1));console.log(i,v.match?`MATCH score=${v.match.score} zone=${v.match.zoneLow.toFixed(1)}-${v.match.zoneHigh.toFixed(1)} inval=${v.match.invalidationBelow.toFixed(1)} px=${v.match.price.toFixed(1)}`:v.rejected);}
