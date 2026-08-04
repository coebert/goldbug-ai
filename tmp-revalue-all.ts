import { createClient } from "@supabase/supabase-js";
import { revalueHistoricalSnapshots } from "/dev-server/src/lib/equity-snapshot-revalue.server";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data } = await sb.from("portfolios").select("id, name");
for (const p of data ?? []) {
  const r = await revalueHistoricalSnapshots(sb as any, p.id, { dryRun: false });
  console.log(p.name, "written:", r.written, "skipped:", r.skipped.length, r.error ?? "");
}
