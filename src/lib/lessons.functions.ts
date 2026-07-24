// Portfolio-learning and lesson-override server functions. Split out of
// trading.functions.ts during Phase 3. The legacy "@/lib/trading.functions"
// barrel re-exports these for backwards compatibility.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getPortfolioLearning = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolio_id: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id, last_run_date")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const asOf = owned.last_run_date ?? new Date().toISOString().slice(0, 10);
    const { buildLearningContext } = await import("./learning.server");
    const ctx = await buildLearningContext(data.portfolio_id, asOf);
    return { as_of: asOf, ...ctx };
  });

// ============================================================================
// Lesson overrides: mark AI-authored lessons as unhelpful (disable) or edit
// them so the trading engine uses the user-approved wording.
// ============================================================================

export const listLessonOverrides = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("lesson_overrides")
      .select(
        "id, original_text, action, replacement_text, reason, helpful_count, unhelpful_count, feedback_score, updated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { overrides: data ?? [] };
  });

export const setLessonOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      original_text: z.string().min(1).max(2000),
      action: z.enum(["disabled", "edited"]),
      replacement_text: z.string().max(2000).optional().nullable(),
      reason: z.string().max(500).optional().nullable(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    if (data.action === "edited" && !(data.replacement_text && data.replacement_text.trim())) {
      throw new Error("Replacement text is required when editing a lesson.");
    }
    const { error } = await context.supabase.from("lesson_overrides").upsert(
      {
        user_id: context.userId,
        original_text: data.original_text,
        action: data.action,
        replacement_text:
          data.action === "edited" ? (data.replacement_text ?? "").trim() : null,
        reason: data.reason?.trim() || null,
      },
      { onConflict: "user_id,original_text" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearLessonOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ original_text: z.string().min(1).max(2000) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    // Preserve helpful/unhelpful feedback if any exists — only strip the
    // edit/disable action so the AI stops applying the override, while the
    // rating still influences lesson priority.
    const { data: row } = await context.supabase
      .from("lesson_overrides")
      .select("id, helpful_count, unhelpful_count")
      .eq("user_id", context.userId)
      .eq("original_text", data.original_text)
      .maybeSingle();
    if (!row) return { ok: true };
    const hasFeedback = (row.helpful_count ?? 0) > 0 || (row.unhelpful_count ?? 0) > 0;
    if (hasFeedback) {
      const { error } = await context.supabase
        .from("lesson_overrides")
        .update({ action: "neutral", replacement_text: null, reason: null })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("lesson_overrides")
        .delete()
        .eq("id", row.id);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

// Thumbs-up / thumbs-down feedback on a lesson. Ratings accumulate into
// helpful_count / unhelpful_count and the generated feedback_score is used
// by the learning layer to reorder and (below a threshold) auto-suppress
// lessons before they reach the AI prompt.
export const rateLessonFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      original_text: z.string().min(1).max(2000),
      vote: z.enum(["helpful", "unhelpful", "clear"]),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: existing } = await context.supabase
      .from("lesson_overrides")
      .select("id, action, helpful_count, unhelpful_count")
      .eq("user_id", context.userId)
      .eq("original_text", data.original_text)
      .maybeSingle();

    let helpful = existing?.helpful_count ?? 0;
    let unhelpful = existing?.unhelpful_count ?? 0;
    if (data.vote === "helpful") helpful += 1;
    else if (data.vote === "unhelpful") unhelpful += 1;
    else {
      helpful = 0;
      unhelpful = 0;
    }

    if (!existing) {
      const { error } = await context.supabase.from("lesson_overrides").insert({
        user_id: context.userId,
        original_text: data.original_text,
        action: "neutral",
        helpful_count: helpful,
        unhelpful_count: unhelpful,
      });
      if (error) throw new Error(error.message);
    } else if (data.vote === "clear" && existing.action === "neutral") {
      const { error } = await context.supabase
        .from("lesson_overrides")
        .delete()
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("lesson_overrides")
        .update({ helpful_count: helpful, unhelpful_count: unhelpful })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    }
    return {
      ok: true,
      helpful_count: helpful,
      unhelpful_count: unhelpful,
      feedback_score: helpful - unhelpful,
    };
  });
