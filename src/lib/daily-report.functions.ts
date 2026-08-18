import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DailyReport, DailyReportItem, DailyReportPortfolio } from "./daily-report.server";

export type { DailyReport, DailyReportItem, DailyReportPortfolio };

export const getDailyAiReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        portfolioId: z.string().uuid().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<DailyReport> => {
    const { buildDailyReport } = await import("./daily-report.server");
    const date = data.date ?? new Date().toISOString().slice(0, 10);
    return buildDailyReport({
      db: context.supabase,
      userId: context.userId,
      date,
      portfolioId: data.portfolioId,
    });
  });
