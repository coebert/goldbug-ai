// Runtime helpers extracted from ticker-watch.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TickerMetrics } from "@/lib/ticker-watch";

export type TickerWatchView = {
  id: string;
  symbol: string;
  label: string | null;
  thesis: string | null;
  buyAbove: number | null;
  oversoldRsi: number;
  maxVolPct: number;
  dropBelow: number | null;
  active: boolean;
  metrics: TickerMetrics | null;
  status: string;
  firedToday: Array<{ code: string; price: number | null; at: string }>;
};

export const UpsertInput = z.object({
  symbol: z.string().trim().min(1).max(16).transform((s) => s.toUpperCase()),
  label: z.string().trim().max(120).optional(),
  thesis: z.string().trim().max(2000).optional(),
  buyAbove: z.number().positive().nullable().optional(),
  oversoldRsi: z.number().min(1).max(99).default(30),
  maxVolPct: z.number().min(1).max(500).default(30),
  dropBelow: z.number().positive().nullable().optional(),
  active: z.boolean().default(true),
});

export type SecondOpinion = {
  symbol: string;
  metrics: TickerMetrics | null;
  verdict: string;
  model: string | null;
};
