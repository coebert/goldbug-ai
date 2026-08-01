import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MacroLessonSet } from "@/lib/macro-playbook";
import type { MacroHistoryStudy } from "@/lib/macro-history";

export type MacroStudyResponse = {
  study: MacroHistoryStudy | null;
  lessons: MacroLessonSet | null;
  ai_error: string | null;
};

/** Runs the 20-year news ↔ market-pattern study and stores the learned playbook. */
export const runMacroStudy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { newsWindowDays?: number } | undefined) => ({
    newsWindowDays: Math.max(7, Math.min(3650, Math.round(Number(input?.newsWindowDays ?? 365)))),
  }))
  .handler(async ({ context, data }): Promise<MacroStudyResponse> => {
    const { runMacroHistoryAnalysis } = await import("@/lib/macro-history-analysis.server");
    const result = await runMacroHistoryAnalysis({
      supabase: context.supabase as never,
      userId: context.userId,
      newsWindowDays: data.newsWindowDays,
    });
    return { study: result.study, lessons: result.lessons, ai_error: result.ai_error };
  });

/** Reads the currently active playbook without re-running the study. */
export const getMacroLessons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MacroStudyResponse> => {
    const { loadActiveMacroLessons } = await import("@/lib/macro-history-analysis.server");
    const lessons = await loadActiveMacroLessons(context.supabase as never, context.userId);
    return { study: null, lessons, ai_error: null };
  });
