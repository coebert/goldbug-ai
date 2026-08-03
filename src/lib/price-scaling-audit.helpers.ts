// Runtime helpers extracted from price-scaling-audit.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  auditHoldingScalings,
  type HoldingScanRow,
  type ScalingFinding,
} from "@/lib/price-scaling-audit";
import { UNIVERSE, type AssetClass } from "@/lib/universe.server";

export type ScalingAuditResponse = {
  ran_at: string;
  findings: ScalingFinding[];
  totals: {
    scanned: number;
    findings: number;
    errors: number;
    warnings: number;
  };
};

// A pre-built map from symbol → canonical asset_class for O(1) lookup.
// Kept module-scope on the server side only (this file is server-only).
export const CANONICAL_AC: Map<string, AssetClass> = new Map(
  UNIVERSE.map((u) => [u.symbol.toUpperCase(), u.asset_class]),
);

export function canonicalFor(sym: string): AssetClass | null {
  const key = sym.trim().toUpperCase().replace(/:XLON$/i, ".L");
  return CANONICAL_AC.get(key) ?? CANONICAL_AC.get(sym.trim().toUpperCase()) ?? null;
}

// Number of daily closes to use as the historical baseline for ratio-jump
// detection. 30 gives us at least a month even after weekends/holidays.
export const HISTORY_DAYS = 30;
