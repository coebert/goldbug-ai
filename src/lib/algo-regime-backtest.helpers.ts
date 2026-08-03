// Runtime helpers extracted from algo-regime-backtest.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

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

export const DEFAULT_LOOKBACK_DAYS = 60;

export const MAX_OBSERVATION_DAYS = 120;

export const MAX_CROSS_SECTION_SYMBOLS = 4;

export type BarRow = { price_date: string; close: number; volume: number | null };

export function sliceBarsBefore(rows: readonly BarRow[], asOf: string, n: number) {
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

export function sliceReturnsBefore(rows: readonly BarRow[], asOf: string, n: number): number[] {
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
