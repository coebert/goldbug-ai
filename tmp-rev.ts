import { createClient } from "@supabase/supabase-js";
import { revalueHistoricalSnapshots } from "./src/lib/equity-snapshot-revalue.server";
const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });
const id = "be68327c-e2fd-43b6-a7d1-e3c6862ea1b7";
const r = await revalueHistoricalSnapshots(sb as never, id, {});
console.log(JSON.stringify({ written: r.written, error: r.error, skipped: r.skipped, rows: r.rows }, null, 1));
