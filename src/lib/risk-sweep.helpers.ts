// Runtime helpers extracted from risk-sweep.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RiskSweepResult } from "./risk-sweep.server";

export const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  years: z.number().int().min(1).max(20).default(5),
});
