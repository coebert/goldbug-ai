import { createClient } from "@supabase/supabase-js";
import { checkValuationConsistency } from "/dev-server/src/lib/valuation-consistency";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: ps } = await sb.from("portfolios").select("id,name,currency");
for (const p of ps ?? []) {
  const { data: snaps } = await sb.from("equity_snapshots").select("snapshot_date, cash, holdings_value, total_value").eq("portfolio_id", p.id).order("snapshot_date");
  const r = checkValuationConsistency({ portfolioId: p.id, snapshots: (snaps ?? []) as any, baseCcy: p.currency ?? "GBP" });
  console.log(p.name, "jumps:", r.jumps.filter((j:any)=>!j.benign).length, r.jumps.filter((j:any)=>!j.benign).map((j:any)=>`${j.date} ${j.ratio}x`).join(", "));
}
