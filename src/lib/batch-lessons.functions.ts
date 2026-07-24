import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const runBatchBacktestLessons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runBatchBacktestAndLearn } = await import("./batch-lessons.server");
    return runBatchBacktestAndLearn(context.userId);
  });
