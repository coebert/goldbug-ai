import { createClient } from "@supabase/supabase-js";
import { revalueHistoricalSnapshots } from "./src/lib/equity-snapshot-revalue.server";
const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });
const ids = ["d7567038-0241-42f2-83ea-95925a4073ed","7c825889-81a1-4c32-9087-26d3847be6b1","3c72a9a3-4adf-4d61-aa91-dff5f94e37c6","bed4656f-e501-4252-8d92-9f607ccfe203"];
for (const id of ids) { const r = await revalueHistoricalSnapshots(sb as never, id, {}); console.log(id, r.written, r.error ?? "", JSON.stringify(r.skipped)); }
