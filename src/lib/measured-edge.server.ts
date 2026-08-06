// Server loader for measured edge. Reads the rolling `signal_performance`
// rows the decay job already writes and folds them into the Kelly edge.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { measuredEdgeFromSignals, EDGE_PRIOR, type MeasuredEdge } from "./measured-edge";

const WINDOW_DAYS = 30;

export async function loadMeasuredEdge(portfolioId: string): Promise<MeasuredEdge> {
  try {
    const { data, error } = await supabaseAdmin
      .from("signal_performance")
      .select("signal_name, samples, hit_rate, avg_edge_bps, weight_avg")
      .eq("portfolio_id", portfolioId)
      .eq("window_days", WINDOW_DAYS);
    if (error) throw error;
    return measuredEdgeFromSignals(
      (data ?? []).map((r) => ({
        signal_name: String(r.signal_name),
        samples: r.samples == null ? null : Number(r.samples),
        hit_rate: r.hit_rate == null ? null : Number(r.hit_rate),
        avg_edge_bps: r.avg_edge_bps == null ? null : Number(r.avg_edge_bps),
        weight_avg: r.weight_avg == null ? null : Number(r.weight_avg),
      })),
    );
  } catch {
    return {
      edge: EDGE_PRIOR,
      samples: 0,
      hitRate: null,
      rawEdge: null,
      usedPrior: true,
      note: `edge=prior ${(EDGE_PRIOR * 100).toFixed(1)}% (lookup failed)`,
    };
  }
}
