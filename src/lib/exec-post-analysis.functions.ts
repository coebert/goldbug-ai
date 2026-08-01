import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ExecPostLessonSet } from "@/lib/exec-post-learning";
import type { ExecPostStudySummary } from "@/lib/exec-post-study";

export type ExecPostStudyResponse = {
  summary: ExecPostStudySummary | null;
  lessons: ExecPostLessonSet | null;
  ai_error: string | null;
};

/** Runs the full CEO-post ↔ market-pattern study and stores the lessons. */
export const runExecPostStudy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { windowDays?: number } | undefined) => ({
    windowDays: Math.max(14, Math.min(365, Math.round(Number(input?.windowDays ?? 90)))),
  }))
  .handler(async ({ context, data }): Promise<ExecPostStudyResponse> => {
    const { runExecPostAnalysis } = await import("@/lib/exec-post-analysis.server");
    const result = await runExecPostAnalysis({
      supabase: context.supabase as never,
      userId: context.userId,
      windowDays: data.windowDays,
    });
    return { summary: result.summary, lessons: result.lessons, ai_error: result.ai_error };
  });

/** Reads the currently active lesson set without re-running the study. */
export const getExecPostLessons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExecPostStudyResponse> => {
    const { loadActiveExecPostLessons } = await import("@/lib/exec-post-analysis.server");
    const lessons = await loadActiveExecPostLessons(
      context.supabase as never,
      context.userId,
    );
    return { summary: null, lessons, ai_error: null };
  });
