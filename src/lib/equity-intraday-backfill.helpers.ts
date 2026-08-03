// Runtime helpers extracted from equity-intraday-backfill.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  backfillPortfolioIntradayEquity,
  type IntradayBackfillResult,
} from "./equity-intraday-backfill.server";

export const inputSchema = z.object({
  portfolioId: z.string().uuid().optional(),
  days: z.number().int().min(1).max(3650).default(365),
});
