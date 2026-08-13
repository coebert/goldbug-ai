// History of the market-regime read the engine attached to each decision run,
// so the portfolio page can plot how posture, volatility band and the applied
// policy-nudge multiplier moved over time.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  POLICY_SCALE_MAX,
  POLICY_SCALE_MIN,
  type RegimePosture,
  type VolRegime,
} from "@/lib/policy-regime-scaling";

export type PolicyRegimePoint = {
  /** Run date (YYYY-MM-DD) when known, otherwise the decision timestamp's day. */
  date: string;
  decidedAt: string | null;
  posture: RegimePosture;
  vol: VolRegime;
  /** Multiplier the run applied to the policy nudge. */
  scale: number;
  reason: string;
};

export type PolicyRegimeTimeline = {
  portfolio_id: string;
  points: PolicyRegimePoint[];
  scaleMin: number;
  scaleMax: number;
  /** Runs inspected that carried no regime read (older runs predate the feature). */
  missing: number;
};

export const getPolicyRegimeTimeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        limit: z.number().int().min(5).max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<PolicyRegimeTimeline> => {
    const { supabase, userId } = context;
    const POSTURES: RegimePosture[] = ["risk_on", "neutral", "risk_off"];
    const VOLS: VolRegime[] = ["calm", "normal", "elevated", "stressed"];

    const p = await supabase
      .from("portfolios")
      .select("id, user_id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const { data: rows } = await supabase
      .from("decisions")
      .select("run_date, created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 120);

    const points: PolicyRegimePoint[] = [];
    let missing = 0;

    for (const row of rows ?? []) {
      const raw = (row.raw ?? {}) as {
        policy_regime?: {
          posture?: string;
          vol?: string;
          scale?: number;
          reason?: string;
        } | null;
      };
      const r = raw.policy_regime;
      const scale = Number(r?.scale);
      if (!r || !Number.isFinite(scale)) {
        missing += 1;
        continue;
      }
      const decidedAt = (row.created_at as string | null) ?? null;
      const date =
        (row.run_date as string | null) ?? (decidedAt ? decidedAt.slice(0, 10) : null);
      if (!date) continue;
      const posture = POSTURES.includes(r.posture as RegimePosture)
        ? (r.posture as RegimePosture)
        : "neutral";
      const vol = VOLS.includes(r.vol as VolRegime) ? (r.vol as VolRegime) : "normal";
      points.push({
        date,
        decidedAt,
        posture,
        vol,
        scale: Math.min(POLICY_SCALE_MAX, Math.max(POLICY_SCALE_MIN, scale)),
        reason: String(r.reason ?? ""),
      });
    }

    // Oldest first so the chart reads left-to-right; keep one point per run.
    points.sort((a, b) => (a.decidedAt ?? a.date).localeCompare(b.decidedAt ?? b.date));

    return {
      portfolio_id: data.portfolioId,
      points,
      scaleMin: POLICY_SCALE_MIN,
      scaleMax: POLICY_SCALE_MAX,
      missing,
    };
  });
