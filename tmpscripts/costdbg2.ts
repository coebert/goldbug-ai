import { supabaseAdmin } from "../src/integrations/supabase/client.server";
const { data } = await supabaseAdmin.from("live_fills").select("portfolio_id, order_id, symbol, side, quantity, fill_price, filled_at").order("filled_at",{ascending:false});
const g = new Map<string, {sym:string;side:string;q:number;n:number;d:string}>();
for (const f of data??[]) { const k=String(f.order_id); const c=g.get(k)??{sym:f.symbol,side:f.side,q:0,n:0,d:String(f.filled_at).slice(0,10)}; c.q+=Number(f.quantity); c.n+=Number(f.quantity)*Number(f.fill_price); g.set(k,c); }
const rows=[...g.values()].sort((a,b)=>b.n-a.n);
console.log("orders",rows.length);
for (const r of rows) console.log(r.d, r.sym, r.side, "qty",r.q, "notional(native)", r.n.toFixed(0));
