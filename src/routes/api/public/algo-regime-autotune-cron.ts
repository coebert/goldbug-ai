// Phase H — Scheduled cron endpoint. Iterates over every portfolio that has
// an algo-regime override AND at least one pending shadow evaluation, and
// runs `evaluateAlgoRegimeShadow` for each. Intended to be called once per
// day by pg_cron (or any external scheduler).
//
// Security: HMAC-verified via `x-cron-signature` against
// `ALGO_REGIME_CRON_SECRET`. Uses the admin client (bypasses RLS) because
// cron has no user session; every table update is scoped by portfolio_id
// looked up from a table this endpoint owns end-to-end.

import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import {
  calibrateRegime,
  type CalibrationReport,
  type EquityPoint,
  type RegimeObservation,
} from "@/lib/microstructure/algo-regime-calibration";
import {
  evaluateShadow,
  DEFAULT_SHADOW_EVAL_OPTIONS,
} from "@/lib/microstructure/algo-regime-shadow-eval";
import type {
  AlgoRegimeConfig,
  AlgoRegimeSnapshot,
} from "@/lib/microstructure/algo-regime";

export const Route = createFileRoute("/api/public/algo-regime-autotune-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.ALGO_REGIME_CRON_SECRET;
        if (!secret) {
          return new Response("Cron secret not configured", { status: 503 });
        }

        const body = await request.text();
        const signature = request.headers.get("x-cron-signature") ?? "";
        const expected = createHmac("sha256", secret).update(body).digest("hex");

        const sigBuf = Buffer.from(signature, "utf8");
        const expBuf = Buffer.from(expected, "utf8");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          return new Response("Invalid signature", { status: 401 });
        }

        const parsed = body.length > 0 ? JSON.parse(body) : {};
        const windowDays = Number.isFinite(parsed?.windowDays)
          ? Math.min(60, Math.max(1, Math.floor(parsed.windowDays)))
          : 7;
        const cutoff = new Date(
          Date.now() - windowDays * 24 * 3600 * 1000,
        ).toISOString();

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        const { data: pending, error } = await supabaseAdmin
          .from("algo_regime_tune_history")
          .select(
            "id, portfolio_id, applied_at, prev_config, baseline_monotone, baseline_matched, baseline_normal_mean, baseline_extreme_mean",
          )
          .eq("status", "pending")
          .lte("applied_at", cutoff);
        if (error) return new Response(error.message, { status: 500 });

        const results: Array<{
          historyId: string;
          portfolioId: string;
          action: "keep" | "rollback" | "wait";
          reason: string;
        }> = [];

        for (const row of pending ?? []) {
          const portfolioId = row.portfolio_id as string;
          const appliedAt = row.applied_at as string;
          const sinceDate = appliedAt.slice(0, 10);

          const { data: decisions } = await supabaseAdmin
            .from("decisions")
            .select("run_date, raw")
            .eq("portfolio_id", portfolioId)
            .gte("run_date", sinceDate)
            .order("run_date", { ascending: true })
            .limit(400);
          const observations: RegimeObservation[] = [];
          for (const d of decisions ?? []) {
            const raw = d.raw as Record<string, unknown> | null;
            const snap = raw?.algo_regime as AlgoRegimeSnapshot | null | undefined;
            if (!snap || typeof snap.tier !== "string") continue;
            observations.push({
              date: d.run_date as string,
              tier: snap.tier,
            });
          }

          const { data: eqRows } = await supabaseAdmin
            .from("equity_snapshots")
            .select("snapshot_date, total_value")
            .eq("portfolio_id", portfolioId)
            .gte("snapshot_date", sinceDate)
            .order("snapshot_date", { ascending: true });
          const equity: EquityPoint[] = (eqRows ?? []).map(
            (r: { snapshot_date: string; total_value: number | string }) => ({
              date: r.snapshot_date,
              totalValue: Number(r.total_value),
            }),
          );

          const post = calibrateRegime(observations, equity);
          const baseline: CalibrationReport = {
            matched: (row.baseline_matched as number) ?? 0,
            unmatched: 0,
            monotone: (row.baseline_monotone as boolean) ?? false,
            perTier: [
              { tier: "normal",   count: 1, meanReturn: Number(row.baseline_normal_mean  ?? 0), stdReturn: 0, hitRate: 0, worstReturn: 0 },
              { tier: "elevated", count: 1, meanReturn: 0, stdReturn: 0, hitRate: 0, worstReturn: 0 },
              { tier: "extreme",  count: 1, meanReturn: Number(row.baseline_extreme_mean ?? 0), stdReturn: 0, hitRate: 0, worstReturn: 0 },
            ],
          };

          const decision = evaluateShadow(baseline, post, DEFAULT_SHADOW_EVAL_OPTIONS);

          type HistoryUpdate = {
            post_matched: number;
            post_monotone: boolean;
            post_normal_mean: number | null;
            post_extreme_mean: number | null;
            decision_reason: string;
            status?: "accepted" | "rolled_back";
            evaluated_at?: string;
          };
          const update: HistoryUpdate = {
            post_matched: post.matched,
            post_monotone: post.monotone,
            post_normal_mean:
              post.perTier.find((t) => t.tier === "normal")?.meanReturn ?? null,
            post_extreme_mean:
              post.perTier.find((t) => t.tier === "extreme")?.meanReturn ?? null,
            decision_reason: decision.reason,
          };


          if (decision.action === "wait") {
            // stay pending; do not touch evaluated_at.
          } else if (decision.action === "rollback") {
            const prev = row.prev_config as AlgoRegimeConfig;
            const { error: upErr } = await supabaseAdmin
              .from("algo_regime_config_overrides")
              .upsert(
                {
                  portfolio_id: portfolioId,
                  config: prev,
                  tuned_at: new Date().toISOString(),
                  notes: `cron auto-rollback: ${decision.reason}`,
                },
                { onConflict: "portfolio_id" },
              );
            if (upErr) return new Response(upErr.message, { status: 500 });
            update.status = "rolled_back";
            update.evaluated_at = new Date().toISOString();
          } else {
            update.status = "accepted";
            update.evaluated_at = new Date().toISOString();
          }

          await supabaseAdmin
            .from("algo_regime_tune_history")
            .update(update)
            .eq("id", row.id as string);

          results.push({
            historyId: row.id as string,
            portfolioId,
            action: decision.action,
            reason: decision.reason,
          });
        }

        return new Response(
          JSON.stringify({ processed: results.length, results }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
