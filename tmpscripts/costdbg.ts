import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { estimateTradeCosts } from "../src/lib/trade-viability-gate";
const { data } = await supabaseAdmin.from("live_fills").select("symbol, side, quantity, fill_price, filled_at").order("filled_at",{ascending:false}).limit(12);
for (const f of data ?? []) {
  const px = Number(f.fill_price), q = Number(f.quantity);
  const c = estimateTradeCosts({ symbol: f.symbol, side: f.side as "buy", quantity: q, price: px/100, assetClass: null });
  console.log(f.symbol, f.side, "qty", q, "px", px, "notGBP", (q*px/100).toFixed(0), "bps", c.oneWayBps.toFixed(1), "comm", c.commission.toFixed(2), "stamp", c.stampDuty.toFixed(2), "half", c.halfSpread.toFixed(2));
}
