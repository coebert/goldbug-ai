// Server function backing the algo-regime historical backtest panel.
//
// Reads price_cache in bulk to reconstruct per-day microstructure inputs,
// then reclassifies each historical decision date under both the currently
// active config and the auto-tuner's candidate config so an operator can
// preview forward-return + drawdown before scheduling a shadow-evaluated
// apply. Wrapped in requireSupabaseAuth: the caller can only backtest a
// portfolio they own (verified via RLS on `decisions`).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
} from "@/lib/microstructure/algo-regime";
import { calibrateRegime } from "@/lib/microstructure/algo-regime-calibration";
import { suggestConfigAdjustments, type RiskLevel } from "@/lib/microstructure/algo-regime-autotune";
import {
  compareAlgoRegimeConfigs,
  type BacktestComparison,
  type DailyRegimeInput,
} from "@/lib/microstructure/algo-regime-backtest";

const DEFAULT_LOOKBACK_DAYS = 60;
const MAX_OBSERVATION_DAYS = 120;
const MAX_CROSS_SECTION_SYMBOLS = 4;

type BarRow = { price_date: string; close: number; volume: number | null };

function sliceBarsBefore(rows: readonly BarRow[], asOf: string, n: number) {
  const cutIdx = (() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].price_date <= asOf) return i;
    }
    return -1;
  })();
  if (cutIdx < 0) return { closes: [] as number[], volumes: [] as number[] };
  const start = Math.max(0, cutIdx - n + 1);
  const slice = rows.slice(start, cutIdx + 1);
  return {
    closes: slice.map((r) => Number(r.close)).filter((v) => Number.isFinite(v)),
    volumes: slice.map((r) => (r.volume == null ? 0 : Number(r.volume))),
  };
}

function sliceReturnsBefore(rows: readonly BarRow[], asOf: string, n: number): number[] {
  const { closes } = sliceBarsBefore(rows, asOf, n + 1);
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i - 1];
    if (p > 0) out.push((closes[i] - p) / p);
  }
  return out;
}

export type AlgoRegimeBacktestResponse = BacktestComparison & {
  benchSymbol: string;
  crossSectionSymbols: string[];
  observationDates: string[];
  lookbackDays: number;
  activeConfig: AlgoRegimeConfig;
  candidateConfig: AlgoRegimeConfig;
  tuneNotes: string[];
  candidateChanged: boolean;
};

export const backtestAlgoRegimeCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      benchSymbol: z.string().min(1).max(24).default("SPY"),
      lookbackDays: z.number().int().min(20).max(120).default(DEFAULT_LOOKBACK_DAYS),
      maxObservations: z
        .number().int().min(10).max(MAX_OBSERVATION_DAYS)
        .default(MAX_OBSERVATION_DAYS),
      candidate: z
        .object({
          volBurstRatio: z.number().optional(),
          liquidityVacuumRatio: z.number().optional(),
          whipsawFlipsThreshold: z.number().optional(),
          correlationSpikeThreshold: z.number().optional(),
        })
        .optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }): Promise<AlgoRegimeBacktestResponse> => {
    // 1. RLS-scoped: decision run_dates (proves the caller owns portfolio).
    const { data: decisions, error: decErr } = await context.supabase
      .from("decisions")
      .select("run_date, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("run_date", { ascending: false })
      .limit(data.maxObservations);
    if (decErr) throw new Error(decErr.message);

    const runDates = Array.from(
      new Set((decisions ?? []).map((d) => d.run_date as string)),
    ).sort();
    if (runDates.length < 5) {
      throw new Error("Not enough decision history to backtest (need ≥ 5 runs).");
    }

    // 2. Holdings symbols for cross-section (RLS-scoped).
    const { data: holdRows } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", data.portfolioId)
      .order("quantity", { ascending: false })
      .limit(MAX_CROSS_SECTION_SYMBOLS);
    const holdingSymbols = (holdRows ?? [])
      .map((r) => String(r.symbol))
      .filter((s) => s && s !== data.benchSymbol);

    // 3. Active override (RLS-scoped).
    const { data: overrideRow } = await context.supabase
      .from("algo_regime_config_overrides")
      .select("config")
      .eq("portfolio_id", data.portfolioId)
      .maybeSingle();
    const activeConfig: AlgoRegimeConfig = {
      ...DEFAULT_ALGO_REGIME_CONFIG,
      ...((overrideRow?.config as Partial<AlgoRegimeConfig> | undefined) ?? {}),
    };

    // 4. Equity snapshots for forward returns (RLS-scoped).
    const { data: eqRows, error: eqErr } = await context.supabase
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", data.portfolioId)
      .order("snapshot_date", { ascending: true });
    if (eqErr) throw new Error(eqErr.message);
    const equity = (eqRows ?? []).map((r) => ({
      date: r.snapshot_date as string,
      totalValue: Number(r.total_value),
    }));

    // 5. Bulk price_cache load — needs admin (global reference data). Verified
    //    the caller owns the portfolio via the RLS reads above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const earliest = runDates[0];
    const earliestMinusBuffer = (() => {
      const d = new Date(earliest + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - (data.lookbackDays + 5));
      return d.toISOString().slice(0, 10);
    })();
    const latest = runDates[runDates.length - 1];

    async function loadSymbol(sym: string): Promise<BarRow[]> {
      const { data: rows } = await supabaseAdmin
        .from("price_cache")
        .select("price_date, close, volume")
        .eq("symbol", sym)
        .gte("price_date", earliestMinusBuffer)
        .lte("price_date", latest)
        .order("price_date", { ascending: true });
      return (rows ?? []) as BarRow[];
    }

    const benchBars = await loadSymbol(data.benchSymbol);
    if (benchBars.length < data.lookbackDays) {
      throw new Error(
        `Not enough price_cache history for ${data.benchSymbol} to backtest.`,
      );
    }

    const holdingBars = new Map<string, BarRow[]>();
    for (const sym of holdingSymbols) {
      try {
        const rows = await loadSymbol(sym);
        if (rows.length >= 30) holdingBars.set(sym, rows);
      } catch {
        // best-effort — skip missing symbols
      }
    }
    const crossSectionSymbols = Array.from(holdingBars.keys());

    // 6. Build the per-day input once; both configs consume it.
    const perDay: DailyRegimeInput[] = [];
    for (const date of runDates) {
      const primary = sliceBarsBefore(benchBars, date, data.lookbackDays);
      if (primary.closes.length < 30) continue;
      const crossSection: Record<string, number[]> = {};
      for (const [sym, rows] of holdingBars) {
        const rs = sliceReturnsBefore(rows, date, 30);
        if (rs.length >= 10) crossSection[sym] = rs;
      }
      perDay.push({
        date,
        primary,
        crossSection: Object.keys(crossSection).length >= 2 ? crossSection : undefined,
      });
    }
    if (perDay.length < 5) {
      throw new Error("Insufficient overlapping price history for backtest.");
    }

    // 7. Candidate config: caller-supplied override wins, otherwise fall back
    //    to whatever suggestConfigAdjustments recommends against calibration.
    const baselineReport = calibrateRegime(
      perDay.map((d) => ({ date: d.date, tier: "normal" })), // placeholder — unused, real tiers come from simulate
      equity,
    );
    const tuned = suggestConfigAdjustments(baselineReport, activeConfig);
    const candidateConfig: AlgoRegimeConfig = data.candidate
      ? {
          ...activeConfig,
          ...Object.fromEntries(
            Object.entries(data.candidate).filter(([, v]) => v != null),
          ),
        }
      : tuned.suggested;

    const comparison = compareAlgoRegimeConfigs(
      perDay,
      equity,
      activeConfig,
      candidateConfig,
    );

    return {
      ...comparison,
      benchSymbol: data.benchSymbol,
      crossSectionSymbols,
      observationDates: perDay.map((d) => d.date),
      lookbackDays: data.lookbackDays,
      activeConfig,
      candidateConfig,
      tuneNotes: tuned.notes,
      candidateChanged: tuned.changed || !!data.candidate,
    };
  });
