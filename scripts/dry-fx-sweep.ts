import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sweepLosingFxLegs } from "@/lib/fx-auto-close.server";
const pid = "7c825889-81a1-4c32-9087-26d3847be6b1";
const { data } = await supabaseAdmin.from("portfolios").select("user_id").eq("id", pid).maybeSingle();
console.log(JSON.stringify(await sweepLosingFxLegs({ supabase: supabaseAdmin, userId: data!.user_id, portfolioId: pid, dryRun: true }), null, 2));
