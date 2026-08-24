// Client-callable entry points for the fill-unit backfill.
//
// The driver in `fill-unit-backfill.server.ts` existed but was never wired to
// anything, so mixed-unit fills (BP.L booked at 550.19 pence next to HSBA.L at
// 15.52 pounds) stayed in `live_fills` and quietly corrupted realised P&L,
// execution quality and the friction KPI. These two functions make it
// inspectable (dry run) and repairable (apply) from the admin page.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { FillUnitBackfillResult } from "@/lib/fill-unit-backfill.server";

export type { FillUnitBackfillResult };

const input = z
  .object({ portfolioId: z.string().uuid().optional() })
  .default({});

/** Plan only: reports what would be rewritten, changes nothing. */
export const previewFillUnitBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => input.parse(raw ?? {}))
  .handler(async ({ data, context }): Promise<FillUnitBackfillResult> => {
    const { runFillUnitBackfill } = await import("@/lib/fill-unit-backfill.server");
    return runFillUnitBackfill({
      db: context.supabase,
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      dryRun: true,
    });
  });

/** Applies the plan and recomputes trades + historical equity snapshots. */
export const applyFillUnitBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => input.parse(raw ?? {}))
  .handler(async ({ data, context }): Promise<FillUnitBackfillResult> => {
    const { runFillUnitBackfill } = await import("@/lib/fill-unit-backfill.server");
    return runFillUnitBackfill({
      db: context.supabase,
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      dryRun: false,
    });
  });
