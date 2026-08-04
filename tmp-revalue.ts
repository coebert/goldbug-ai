import { createClient } from "@supabase/supabase-js";
import { revalueHistoricalSnapshots } from "/dev-server/src/lib/equity-snapshot-revalue.server";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const id = "7c825889-81a1-4c32-9087-26d3847be6b1";
const dry = await revalueHistoricalSnapshots(sb as any, id, { dryRun: true });
console.log(JSON.stringify({ rows: dry.rows, skipped: dry.skipped }, null, 1));
