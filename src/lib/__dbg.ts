import { evaluateSetup } from "./setup-scan";
function hist(after:number[]){const closes:number[]=[];let p=100;for(let i=0;i<220;i++){p*= i<170?0.998:1.0005;closes.push(p);}const b=closes[closes.length-1];for(let i=0;i<5;i++)closes.push(b*1.05**(i+1));closes.push(...after);return closes.map((close,i)=>({date:new Date(Date.UTC(2020,0,1+i)).toISOString().slice(0,10),close,high:close*1.02,low:close*0.97,volume:i>=220?700000:1000000}));}
const c=hist([]);
for(let i=215;i<c.length;i++){const v=evaluateSetup("T",c.slice(0,i+1));console.log(i,v.match?"MATCH":v.rejected);}
