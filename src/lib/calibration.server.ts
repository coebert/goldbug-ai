// K. Calibration loop — Brier score over a rolling 60-day window of decisions
// that have had a 5-day forward evaluation. Poor calibration shrinks a global
// sizing multiplier fed back into the buy pass.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "./market-data.server";

export type CalibrationSnapshot = {
  brier_score: number;
  samples: number;
  hit_rate: number | null;
  avg_conviction: number | null;
  global_size_mult: number;
  notes: string;
};

const DEFAULT_SNAPSHOT: CalibrationSnapshot = {
  brier_score: 0.25,
  samples: 0,
  hit_rate: null,
  avg_conviction: null,
  global_size_mult: 1,
  notes: "not enough samples yet",
};

function multFromBrier(brier: number): number {
  // Random-guess Brier = 0.25. Great = 0.15, poor = 0.35.
  // Map 0.15 → 1.10 (small boost), 0.25 → 1.00, 0.35 → 0.60.
  const raw = 1.10 - ((brier - 0.15) / 0.20) * 0.50;
  return Math.max(0.5, Math.min(1.10, Number(raw.toFixed(3))));
}

type DecisionRow = {
  id: string;
  run_date: string;
  raw: unknown;
};

export async function computeAndPersistCalibration(portfolioId: string, asOf: string): Promise<CalibrationSnapshot> {
  const from = new Date(asOf);
  from.setUTCDate(from.getUTCDate() - 60);
  const fromStr = from.toISOString().slice(0, 10);
  const cutoff = new Date(asOf);
  cutoff.setUTCDate(cutoff.getUTCDate() - 5);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: rows } = await supabaseAdmin
    .from("decisions")
    .select("id, run_date, raw")
    .eq("portfolio_id", portfolioId)
    .gte("run_date", fromStr)
    .lte("run_date", cutoffStr)
    .order("run_date", { ascending: false })
    .limit(60);

  const decisions = (rows ?? []) as DecisionRow[];
  const scored: Array<{ pred: number; outcome: 0 | 1 }> = [];

  for (const d of decisions) {
    const raw = (d.raw ?? {}) as { orders?: Array<{ symbol?: string; side?: string; conviction?: number }> };
    const orders = Array.isArray(raw.orders) ? raw.orders : [];
    for (const o of orders) {
      if (!o?.symbol || (o.side !== "buy" && o.side !== "sell")) continue;
      const conv = typeof o.conviction === "number" ? Math.max(0, Math.min(1, o.conviction)) : null;
      if (conv == null) continue;
      try {
        const price0 = await getPriceOn(o.symbol, d.run_date);
        const fwd = new Date(d.run_date);
        fwd.setUTCDate(fwd.getUTCDate() + 5);
        const price1 = await getPriceOn(o.symbol, fwd.toISOString().slice(0, 10));
        if (!price0 || !price1) continue;
        const ret = (price1 - price0) / price0;
        const positive = o.side === "buy" ? ret > 0 : ret < 0;
        scored.push({ pred: conv, outcome: positive ? 1 : 0 });
      } catch {
        /* skip */
      }
    }
    if (scored.length >= 80) break;
  }

  if (scored.length < 10) {
    const snap = { ...DEFAULT_SNAPSHOT, samples: scored.length, notes: `only ${scored.length} evaluable samples` };
    await supabaseAdmin.from("calibration_snapshots").upsert(
      {
        portfolio_id: portfolioId, as_of: asOf,
        brier_score: snap.brier_score, samples: snap.samples,
        hit_rate: null, avg_conviction: null,
        global_size_mult: snap.global_size_mult, notes: snap.notes,
      },
      { onConflict: "portfolio_id,as_of" },
    );
    return snap;
  }

  const brier = scored.reduce((s, x) => s + (x.pred - x.outcome) ** 2, 0) / scored.length;
  const hits = scored.filter((s) => s.outcome === 1).length;
  const hitRate = hits / scored.length;
  const avgConv = scored.reduce((s, x) => s + x.pred, 0) / scored.length;
  const mult = multFromBrier(brier);

  const snap: CalibrationSnapshot = {
    brier_score: Number(brier.toFixed(4)),
    samples: scored.length,
    hit_rate: Number(hitRate.toFixed(3)),
    avg_conviction: Number(avgConv.toFixed(3)),
    global_size_mult: mult,
    notes: brier < 0.20 ? "well-calibrated" : brier > 0.28 ? "over-confident — shrinking sizes" : "acceptable calibration",
  };

  await supabaseAdmin.from("calibration_snapshots").upsert(
    {
      portfolio_id: portfolioId, as_of: asOf,
      brier_score: snap.brier_score, samples: snap.samples,
      hit_rate: snap.hit_rate, avg_conviction: snap.avg_conviction,
      global_size_mult: snap.global_size_mult, notes: snap.notes,
    },
    { onConflict: "portfolio_id,as_of" },
  );

  return snap;
}

export async function getLatestCalibration(portfolioId: string): Promise<CalibrationSnapshot> {
  const { data } = await supabaseAdmin
    .from("calibration_snapshots")
    .select("brier_score, samples, hit_rate, avg_conviction, global_size_mult, notes")
    .eq("portfolio_id", portfolioId)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { ...DEFAULT_SNAPSHOT };
  return {
    brier_score: Number(data.brier_score),
    samples: Number(data.samples),
    hit_rate: data.hit_rate != null ? Number(data.hit_rate) : null,
    avg_conviction: data.avg_conviction != null ? Number(data.avg_conviction) : null,
    global_size_mult: Number(data.global_size_mult ?? 1),
    notes: (data.notes as string | null) ?? "",
  };
}

export function formatCalibrationBlock(c: CalibrationSnapshot): string {
  if (c.samples < 10) return "";
  return `CALIBRATION FEEDBACK (last ~60d, ${c.samples} evaluable orders):
- Brier score: ${c.brier_score.toFixed(3)} (0.15=excellent, 0.25=random, >0.30=over-confident)
- Directional hit rate: ${c.hit_rate == null ? "n/a" : (c.hit_rate * 100).toFixed(0) + "%"}
- Avg stated conviction: ${c.avg_conviction == null ? "n/a" : (c.avg_conviction * 100).toFixed(0) + "%"}
- Current global size multiplier from calibration: ×${c.global_size_mult.toFixed(2)}
${c.global_size_mult < 1 ? "You have been over-stating conviction relative to outcomes — be more measured on conviction values today." : "Calibration is acceptable — you may state conviction freely, backed by evidence."}`;
}
