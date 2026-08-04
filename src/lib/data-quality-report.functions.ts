import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DataQualityReport } from "@/lib/data-quality-report";

export type { DataQualityReport };

export const getDataQualityReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({ portfolioId: z.string().uuid().optional() }).parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<DataQualityReport> => {
    const { buildDataQualityReport } = await import("@/lib/data-quality-report.server");
    return buildDataQualityReport({
      db: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
    });
  });
