// Runtime helpers extracted from order-reconciliation-backfill.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { OrderReconcileSummary } from "@/lib/order-reconciliation.server";

export interface BackfillPortfolioResult {
  portfolioId: string;
  portfolioName: string | null;
  ok: boolean;
  error?: string;
  summary?: {
    scanned: number;
    filled: number;
    partial: number;
    rejected: number;
    cancelled: number;
    stillWorking: number;
    unknown: number;
  };
}

export interface BackfillResult {
  lookbackHours: number;
  totals: {
    scanned: number;
    filled: number;
    partial: number;
    rejected: number;
    cancelled: number;
    stillWorking: number;
    unknown: number;
  };
  portfolios: BackfillPortfolioResult[];
}

export const Input = z
  .object({
    // 60 days default — captures anything since live routing began.
    lookbackHours: z.number().int().min(1).max(24 * 365).default(24 * 60),
    // Also include 'error' — orders that failed pre-broker won't reconcile,
    // but historically some in-flight failures were stored as 'error' when
    // the follow-up status update was lost.
    includeError: z.boolean().default(true),
    portfolioId: z.string().uuid().optional(),
  })
  .default({ lookbackHours: 24 * 60, includeError: true });
