// Runtime helpers extracted from corporate-actions.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { CorporateAction } from "./corporate-actions";
import type { ImpactPreview } from "./corporate-action-impact";

/** Wire shape: the raw Saxo row is dropped (not serializable / not needed). */
export type CorporateActionView = Omit<CorporateAction, "raw"> & {
  /** Cash-vs-scrip estimate for the position we actually hold. */
  impact: ImpactPreview;
};

export type CorporateActionsResult = {
  portfolioId: string;
  /** false when the portfolio is not linked to a broker account. */
  brokerBacked: boolean;
  /** false when Saxo does not expose corporate actions on this environment. */
  supported: boolean;
  env: string | null;
  endpoint: string | null;
  fetchedAt: string;
  events: CorporateActionView[];
  /** Human-readable reason when nothing could be fetched. */
  reason: string | null;
};

/** "ULVR:xlon" / "ULVR.L" → "ULVR" for cross-source symbol matching. */
export function baseTicker(symbol: string): string {
  return symbol.split(/[:.]/)[0]!.trim().toUpperCase();
}
