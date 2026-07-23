// F. Walk-forward hyperparam scheduler: enforces a 30d train / 7d validate
// cadence and logs each run into hyperparam_history so drift is auditable.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  tunePortfolioHyperparams,
  parseHyperparams,
  type TunedHyperparams,
} from "./hyperparam-tuning.server";

const TRAIN_DAYS = 30; // re-tune cadence
const VALIDATE_DAYS = 7; // OOS eval window (used as trailing score above)

export type WalkForwardResult = TunedHyperparams & {
  oos_score: number | null;
  train_score: number;
};

function daysBetween(a: string, b: string): number {
  return (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

export async function getOrWalkForward(
  portfolioId: string,
  asOf: string,
): Promise<WalkForwardResult> {
  const { data: row } = await supabaseAdmin
    .from("portfolios")
    .select("hyperparams")
    .eq("id", portfolioId)
    .maybeSingle();
  const current = parseHyperparams(row?.hyperparams);
  const age = current.tuned_at ? daysBetween(asOf, current.tuned_at) : Infinity;

  if (age < TRAIN_DAYS) {
    return { ...current, train_score: current.score, oos_score: null };
  }

  // Train on trailing 500d ending VALIDATE_DAYS ago (leaving OOS gap).
  const trainAsOf = new Date(asOf);
  trainAsOf.setUTCDate(trainAsOf.getUTCDate() - VALIDATE_DAYS);
  const trainDate = trainAsOf.toISOString().slice(0, 10);

  const trained = await tunePortfolioHyperparams(portfolioId, trainDate, {
    windowDays: 500,
  });

  // Re-score the winner on the trailing VALIDATE_DAYS window (approx: rerun on asOf and diff).
  const validated = await tunePortfolioHyperparams(portfolioId, asOf, {
    windowDays: VALIDATE_DAYS + 250, // ensure enough series length
  });

  const oosScore =
    validated.sma_fast === trained.sma_fast &&
    validated.sma_slow === trained.sma_slow &&
    validated.rsi_period === trained.rsi_period
      ? validated.score
      : null; // grid disagreed → treat as unreliable OOS

  await supabaseAdmin
    .from("hyperparam_history")
    .upsert(
      {
        portfolio_id: portfolioId,
        tuned_at: asOf,
        sma_fast: trained.sma_fast,
        sma_slow: trained.sma_slow,
        rsi_period: trained.rsi_period,
        kelly_cap: trained.kelly_cap,
        train_score: trained.score,
        oos_score: oosScore,
        n_symbols: trained.n_symbols,
        window_days: trained.window_days,
        notes: `train=${trained.score.toFixed(2)} oos=${oosScore == null ? "n/a" : oosScore.toFixed(2)}`,
      },
      { onConflict: "portfolio_id,tuned_at" },
    );

  return { ...trained, train_score: trained.score, oos_score: oosScore };
}
