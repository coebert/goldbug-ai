// Phase H — Scheduled auto-tune with shadow evaluation & safe rollback.
//
// Three server functions:
//
//   applyAlgoRegimeTuneWithShadow(portfolioId, dryRun?)
//     Runs the pure heuristic, and — when it changes anything and !dryRun —
//     writes the new config to `algo_regime_config_overrides` AND inserts a
//     `pending` row in `algo_regime_tune_history` capturing the baseline
//     calibration + previous config. The pending row is what a later
//     shadow-evaluation call inspects.
//
//   evaluateAlgoRegimeShadow(portfolioId)
//     For every `pending` history row that has aged past the shadow window,
//     recomputes calibration using only observations dated ≥ applied_at,
//     then either accepts or rolls back the tune. Rollback restores the
//     row's `prev_config` into the overrides table.
//
//   rollbackAlgoRegimeTune(portfolioId, historyId)
//     Manual override — restores prev_config of any history row and marks
//     it 'rolled_back'. Guarded by RLS (portfolio owner).
//
// All three read/write only tables owned by the caller. No admin client.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  calibrateRegime,
  type CalibrationReport,
  type EquityPoint,
  type RegimeObservation,
} from "@/lib/microstructure/algo-regime-calibration";
import { suggestConfigAdjustments, type RiskLevel } from "@/lib/microstructure/algo-regime-autotune";
import {
  evaluateShadow,
  DEFAULT_SHADOW_EVAL_OPTIONS,
} from "@/lib/microstructure/algo-regime-shadow-eval";
import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
  type AlgoRegimeSnapshot,
} from "@/lib/microstructure/algo-regime";

import { DEFAULT_SHADOW_WINDOW_DAYS, loadObservationsAndEquity, loadOverride, loadRiskLevel, persistOverride, tierMean } from "./algo-regime-scheduled-autotune.helpers";
import type { ApplyTuneResponse, ShadowEvaluationRowResult, EvaluateShadowResponse, ManualRollbackResponse, TuneHistoryRow } from "./algo-regime-scheduled-autotune.helpers";
export { DEFAULT_SHADOW_WINDOW_DAYS };
export type { ApplyTuneResponse, ShadowEvaluationRowResult, EvaluateShadowResponse, ManualRollbackResponse, TuneHistoryRow };

export const applyAlgoRegimeTuneWithShadow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      dryRun: z.boolean().default(false),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<ApplyTuneResponse> => {
    const { observations, equity } = await loadObservationsAndEquity(
      context.supabase,
      data.portfolioId,
    );
    const baselineReport = calibrateRegime(observations, equity);
    const previous = await loadOverride(context.supabase, data.portfolioId);
    const riskLevel = await loadRiskLevel(context.supabase, data.portfolioId);
    const tuned = suggestConfigAdjustments(baselineReport, previous, riskLevel);

    const baseline = {
      matched: baselineReport.matched,
      monotone: baselineReport.monotone,
      normalMean: tierMean(baselineReport, "normal"),
      extremeMean: tierMean(baselineReport, "extreme"),
    };

    if (!tuned.changed || data.dryRun) {
      return {
        changed: tuned.changed,
        persisted: false,
        historyId: null,
        previous,
        suggested: tuned.suggested,
        notes: tuned.notes,
        baseline,
      };
    }

    // Supersede any still-pending row so we don't leave dangling shadow
    // evaluations pointing at a config that's already been replaced.
    await context.supabase
      .from("algo_regime_tune_history")
      .update({
        status: "superseded",
        evaluated_at: new Date().toISOString(),
        decision_reason: "replaced by a newer tune before shadow window closed",
      })
      .eq("portfolio_id", data.portfolioId)
      .eq("status", "pending");

    await persistOverride(
      context.supabase,
      data.portfolioId,
      tuned.suggested,
      tuned.notes.join(" | "),
    );

    const { data: inserted, error: insErr } = await context.supabase
      .from("algo_regime_tune_history")
      .insert({
        portfolio_id: data.portfolioId,
        prev_config: previous,
        new_config: tuned.suggested,
        baseline_matched: baseline.matched,
        baseline_monotone: baseline.monotone,
        baseline_normal_mean: baseline.normalMean,
        baseline_extreme_mean: baseline.extremeMean,
        notes: tuned.notes.join(" | "),
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    return {
      changed: true,
      persisted: true,
      historyId: (inserted?.id as string) ?? null,
      previous,
      suggested: tuned.suggested,
      notes: tuned.notes,
      baseline,
    };
  });

export const evaluateAlgoRegimeShadow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      windowDays: z.number().int().min(1).max(60).default(DEFAULT_SHADOW_WINDOW_DAYS),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<EvaluateShadowResponse> => {
    const cutoff = new Date(Date.now() - data.windowDays * 24 * 3600 * 1000).toISOString();

    const { data: pending, error } = await context.supabase
      .from("algo_regime_tune_history")
      .select(
        "id, applied_at, prev_config, new_config, baseline_monotone, baseline_matched, baseline_normal_mean, baseline_extreme_mean",
      )
      .eq("portfolio_id", data.portfolioId)
      .eq("status", "pending")
      .lte("applied_at", cutoff)
      .order("applied_at", { ascending: true });
    if (error) throw new Error(error.message);

    const results: ShadowEvaluationRowResult[] = [];
    for (const row of pending ?? []) {
      const appliedAt = row.applied_at as string;
      const sinceDate = appliedAt.slice(0, 10);
      const { observations, equity } = await loadObservationsAndEquity(
        context.supabase,
        data.portfolioId,
        sinceDate,
      );
      const postReport = calibrateRegime(observations, equity);

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

      const decision = evaluateShadow(baseline, postReport, DEFAULT_SHADOW_EVAL_OPTIONS);

      type HistoryUpdate = {
        evaluated_at?: string;
        post_matched: number;
        post_monotone: boolean;
        post_normal_mean: number | null;
        post_extreme_mean: number | null;
        decision_reason: string;
        status?: "accepted" | "rolled_back";
      };
      const update: HistoryUpdate = {
        evaluated_at: new Date().toISOString(),
        post_matched: postReport.matched,
        post_monotone: postReport.monotone,
        post_normal_mean: tierMean(postReport, "normal"),
        post_extreme_mean: tierMean(postReport, "extreme"),
        decision_reason: decision.reason,
      };

      if (decision.action === "wait") {
        // Do not mark evaluated_at when waiting — keep row pending for a
        // future re-run with more samples.
        delete update.evaluated_at;
      } else if (decision.action === "rollback") {
        await persistOverride(
          context.supabase,
          data.portfolioId,
          row.prev_config as AlgoRegimeConfig,
          `auto-rollback: ${decision.reason}`,
        );
        update.status = "rolled_back";
      } else {
        update.status = "accepted";
      }

      const { error: upErr } = await context.supabase
        .from("algo_regime_tune_history")
        .update(update)
        .eq("id", row.id as string);
      if (upErr) throw new Error(upErr.message);


      results.push({
        historyId: row.id as string,
        action: decision.action,
        reason: decision.reason,
        postMatched: postReport.matched,
        postMonotone: postReport.monotone,
      });
    }

    return { processed: results.length, results };
  });

export const rollbackAlgoRegimeTune = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      historyId: z.string().uuid(),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<ManualRollbackResponse> => {
    const { data: row, error } = await context.supabase
      .from("algo_regime_tune_history")
      .select("prev_config, portfolio_id")
      .eq("id", data.historyId)
      .eq("portfolio_id", data.portfolioId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Tune history row not found");

    const prev = row.prev_config as AlgoRegimeConfig;
    await persistOverride(context.supabase, data.portfolioId, prev, "manual rollback");

    const { error: upErr } = await context.supabase
      .from("algo_regime_tune_history")
      .update({
        status: "rolled_back",
        evaluated_at: new Date().toISOString(),
        decision_reason: "manual rollback",
      })
      .eq("id", data.historyId);
    if (upErr) throw new Error(upErr.message);

    return { restored: prev };
  });

export const listAlgoRegimeTuneHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(20),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<TuneHistoryRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("algo_regime_tune_history")
      .select(
        "id, applied_at, evaluated_at, status, decision_reason, notes, baseline_matched, baseline_monotone, post_matched, post_monotone",
      )
      .eq("portfolio_id", data.portfolioId)
      .order("applied_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    return (rows ?? []).map((r): TuneHistoryRow => ({
      id: r.id as string,
      appliedAt: r.applied_at as string,
      evaluatedAt: (r.evaluated_at as string | null) ?? null,
      status: r.status as TuneHistoryRow["status"],
      decisionReason: (r.decision_reason as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      baseline: {
        matched: (r.baseline_matched as number) ?? 0,
        monotone: (r.baseline_monotone as boolean) ?? false,
      },
      post: {
        matched: (r.post_matched as number | null) ?? null,
        monotone: (r.post_monotone as boolean | null) ?? null,
      },
    }));
  });
