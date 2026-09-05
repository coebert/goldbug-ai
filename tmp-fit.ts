import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildDataset } from "@/lib/decision-model/dataset.server";
const { data } = await supabaseAdmin.from("portfolios").select("user_id").limit(1);
const userId = data![0]!.user_id as string;
const d = await buildDataset({ userId, horizonDays: 5 });
console.log(JSON.stringify({
  samples: d.samples.length, dates: d.dates.length, symbols: d.symbols.length,
  traded: d.tradedSamples, held: d.heldSamples, cost: d.roundTripCostBps,
  calib: d.costCalibratedSymbols, meanW: d.meanWeight, trades: d.tradesScanned,
  from: d.from, to: d.to, y: d.samples.slice(0,3).map(s=>s.y),
}, null, 2));
