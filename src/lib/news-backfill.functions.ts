// Server functions for the historical news backfill (see news-backfill.server).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { clampBackfillDays } from "./news-backfill";
import type { NewsBackfillJob, BackfillAdvanceResult } from "./news-backfill.server";

export const getNewsBackfillStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ job: NewsBackfillJob | null; new_feeds: number }> => {
    const { latestBackfillJob, countNewCatalogueFeeds } = await import("./news-backfill.server");
    const [job, newFeeds] = await Promise.all([
      latestBackfillJob(context.userId),
      countNewCatalogueFeeds(),
    ]);
    return { job, new_feeds: newFeeds };
  });

export const startNewsBackfillRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { days?: number } | undefined) => ({
    days: clampBackfillDays(input?.days ?? 30),
  }))
  .handler(async ({ context, data }): Promise<BackfillAdvanceResult & { resumed: boolean }> => {
    const { startNewsBackfill, advanceNewsBackfill } = await import("./news-backfill.server");
    const { resumed } = await startNewsBackfill(data.days, context.userId);
    // Do a first slice inline so the user sees history appear immediately.
    const advanced = await advanceNewsBackfill({ userId: context.userId, budgetMs: 35_000 });
    return { ...advanced, resumed };
  });

export const advanceNewsBackfillRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BackfillAdvanceResult> => {
    const { advanceNewsBackfill } = await import("./news-backfill.server");
    return advanceNewsBackfill({ userId: context.userId, budgetMs: 35_000 });
  });

export const cancelNewsBackfillRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ job: NewsBackfillJob | null }> => {
    const { cancelNewsBackfill } = await import("./news-backfill.server");
    return { job: await cancelNewsBackfill(context.userId) };
  });
