// Cron-triggered endpoint that automatically runs the batch-backtest →
// lesson-refresh pipeline for every user whose retrain_settings row says
// they're enabled AND due (last_run_at older than cadence_days).
// Auth via CRON_SECRET header. Safe to run daily — it self-skips users
// that aren't due yet.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/batch-retrain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:batch-retrain",
          capacity: 5,
          refillPerSec: 5/3600,
        });
        if (!verified.ok) return verified.response;
        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { acquireRunLock } = await import("@/lib/run-lock.server");
        const { runBatchBacktestAndLearn } = await import(
          "@/lib/batch-lessons.server"
        );

        // Optional { user_id, force } body to retrain one user on-demand.
        let forcedUserId: string | null = null;
        let force = false;
        try {
          const bodyText = await request.clone().text();
          if (bodyText) {
            const parsed = JSON.parse(bodyText);
            if (typeof parsed?.user_id === "string") forcedUserId = parsed.user_id;
            force = parsed?.force === true;
          }
        } catch { /* body optional */ }

        const lock = await acquireRunLock("batch-retrain", {
          owner: forcedUserId ? "manual" : "cron",
          // TTL so a terminated request cannot leave the lock behind.
          ttlMs: 5 * 60_000,
        });
        if (!lock.acquired) {
          return new Response(
            JSON.stringify({
              error: "run_in_progress",
              held_by: lock.heldBy,
              age_ms: lock.ageMs,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          const now = new Date();
          const { data: rows, error } = await supabaseAdmin
            .from("retrain_settings")
            .select("user_id, enabled, cadence_days, last_run_at");
          if (error) {
            console.error("batch-retrain: fetch settings failed", error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          const due = (rows ?? []).filter((r) => {
            if (forcedUserId) return r.user_id === forcedUserId;
            if (!r.enabled) return false;
            if (!r.last_run_at) return true;
            const last = new Date(r.last_run_at).getTime();
            const dueAt = last + r.cadence_days * 24 * 60 * 60 * 1000;
            return force || now.getTime() >= dueAt;
          });

          const results: Array<{
            user_id: string;
            ok: boolean;
            lessons_written?: number;
            regimes?: string[];
            error?: string;
          }> = [];

          for (const r of due) {
            try {
              const out = await runBatchBacktestAndLearn(r.user_id);
              await supabaseAdmin.from("retrain_settings").update({
                last_run_at: new Date().toISOString(),
                last_run_status: "ok",
                last_run_error: null,
              }).eq("user_id", r.user_id);
              results.push({
                user_id: r.user_id,
                ok: true,
                lessons_written: out.lessons_written,
                regimes: out.regimes_covered,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`batch-retrain: user ${r.user_id} failed`, msg);
              await supabaseAdmin.from("retrain_settings").update({
                last_run_at: new Date().toISOString(),
                last_run_status: "error",
                last_run_error: msg.slice(0, 500),
              }).eq("user_id", r.user_id);
              results.push({ user_id: r.user_id, ok: false, error: msg });
            }
          }

          return Response.json({
            success: true,
            ran_at: now.toISOString(),
            candidates: rows?.length ?? 0,
            processed: results.length,
            triggered_by: forcedUserId ? "manual" : "cron",
            results,
          });
        } finally {
          await lock.release();
        }
      },
    },
  },
});
