/**
 * Fit, persist and apply the learned decision model.
 *
 * The fitted model is stored per user in `decision_models`; the most recent
 * active row is what the trading engine reads on every tick.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/_server/db-json";
import { buildDataset } from "./dataset.server";
import {
  BUCKETS,
  FEATURE_KEYS,
  FEATURE_SPECS,
  bucketOf,
  extractFeatureVector,
  labelOf,
  type AnyRow,
} from "./features";
import {
  bucketWeights,
  evaluate,
  fitWalkForward,
  normaliseByDate,
  refitFull,
  score as dot,
  type EvalMetrics,
} from "./fit";

export type StoredModel = {
  id: string;
  fitted_at: string;
  horizon_days: number;
  lambda: number;
  feature_keys: string[];
  coefficients: number[];
  bucket_weights: Record<string, number>;
  metrics: {
    train: EvalMetrics;
    test: EvalMetrics;
    full: EvalMetrics;
    baseline_test: EvalMetrics;
  };
  coverage: {
    samples: number;
    dates: number;
    symbols: number;
    decisions_scanned: number;
    skipped_no_forward_price: number;
    from: string | null;
    to: string | null;
    real_money_only: boolean;
  };
  /** True when out-of-sample evidence says the fit is worth trading. */
  usable: boolean;
  note: string;
};

/** Out-of-sample bars a fit must clear before the engine is allowed to use it. */
export const MIN_TEST_DATES = 8;
export const MIN_MEAN_IC = 0.02;

export async function fitAndStoreModel(args: {
  userId: string;
  horizonDays?: number;
  realMoneyOnly?: boolean;
}): Promise<StoredModel> {
  const data = await buildDataset({
    userId: args.userId,
    horizonDays: args.horizonDays ?? 5,
    realMoneyOnly: args.realMoneyOnly ?? false,
  });

  if (data.samples.length < 200) {
    throw new Error(
      `Not enough history to fit: ${data.samples.length} usable observations from ${data.decisionsScanned} recorded days (need 200).`,
    );
  }

  const n = FEATURE_KEYS.length;
  const rows = normaliseByDate(data.samples, n);
  const wf = fitWalkForward(rows, n);
  if (!wf) throw new Error("Not enough distinct trading days to validate a fit out of sample.");

  const coefficients = refitFull(rows, n, wf.best.lambda);
  const full = evaluate(rows, coefficients);

  // Baseline: the naive equal-weight composite of every feature, measured on
  // the same out-of-sample dates. A fit that cannot beat this is not a model.
  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const cutIdx = Math.max(1, Math.floor(dates.length * 0.7)) - 1;
  const testRows = rows.filter((r) => r.date > dates[cutIdx]!);
  const baselineTest = evaluate(testRows, new Array<number>(n).fill(1 / n));

  const testIc = wf.best.test.mean_ic;
  const usable =
    wf.best.test.dates >= MIN_TEST_DATES &&
    testIc !== null &&
    testIc >= MIN_MEAN_IC &&
    (wf.best.test.top_bottom_spread_pct ?? 0) > 0;

  const note = usable
    ? `Out-of-sample selection edge confirmed over ${wf.best.test.dates} days (mean IC ${(testIc ?? 0).toFixed(3)}).`
    : `Fit stored for inspection but NOT used for trading: out-of-sample edge too weak (mean IC ${
        testIc === null ? "n/a" : testIc.toFixed(3)
      } over ${wf.best.test.dates} days).`;

  const model: Omit<StoredModel, "id" | "fitted_at"> = {
    horizon_days: data.horizonDays,
    lambda: wf.best.lambda,
    feature_keys: [...FEATURE_KEYS],
    coefficients,
    bucket_weights: bucketWeights(FEATURE_KEYS, coefficients, bucketOf),
    metrics: { train: wf.best.train, test: wf.best.test, full, baseline_test: baselineTest },
    coverage: {
      samples: data.samples.length,
      dates: data.dates.length,
      symbols: data.symbols.length,
      decisions_scanned: data.decisionsScanned,
      skipped_no_forward_price: data.skippedNoForwardPrice,
      from: data.from,
      to: data.to,
      real_money_only: args.realMoneyOnly ?? false,
    },
    usable,
    note,
  };

  const { data: inserted, error } = await supabaseAdmin
    .from("decision_models")
    .insert({
      user_id: args.userId,
      horizon_days: model.horizon_days,
      lambda: model.lambda,
      feature_keys: asJson(model.feature_keys),
      coefficients: asJson(model.coefficients),
      bucket_weights: asJson(model.bucket_weights),
      metrics: asJson(model.metrics),
      coverage: asJson(model.coverage),
      usable: model.usable,
      note: model.note,
    })
    .select("id, fitted_at")
    .single();
  if (error) throw new Error(`could not store fitted model: ${error.message}`);

  return { ...model, id: inserted!.id as string, fitted_at: inserted!.fitted_at as string };
}

export async function loadLatestModel(userId: string): Promise<StoredModel | null> {
  const { data, error } = await supabaseAdmin
    .from("decision_models")
    .select("*")
    .eq("user_id", userId)
    .order("fitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    fitted_at: data.fitted_at as string,
    horizon_days: Number(data.horizon_days),
    lambda: Number(data.lambda),
    feature_keys: (data.feature_keys as string[]) ?? [],
    coefficients: (data.coefficients as number[]) ?? [],
    bucket_weights: (data.bucket_weights as Record<string, number>) ?? {},
    metrics: data.metrics as StoredModel["metrics"],
    coverage: data.coverage as StoredModel["coverage"],
    usable: data.usable === true,
    note: (data.note as string) ?? "",
  };
}

// --------------------------------------------------------------------------
// Scoring today's candidates
// --------------------------------------------------------------------------

export type SymbolScore = {
  symbol: string;
  score: number;
  /** 0..1 rank within today's candidate set. */
  percentile: number;
  /** Signed contribution of each bucket to this symbol's score. */
  contributions: Record<string, number>;
};

/**
 * Apply the stored model to today's candidate rows. Normalisation matches the
 * training path exactly: z-scored across today's candidates, winsorised.
 */
export function scoreCandidates(model: StoredModel, rows: AnyRow[]): SymbolScore[] {
  if (rows.length < 3 || model.coefficients.length !== FEATURE_KEYS.length) return [];

  const vectors = rows.map((r) => extractFeatureVector(r));
  const n = FEATURE_KEYS.length;

  const stats: Array<{ m: number; sd: number }> = [];
  for (let j = 0; j < n; j++) {
    const vals = vectors.map((v) => v[j]).filter((v): v is number => v !== null && Number.isFinite(v));
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const sd =
      vals.length > 1
        ? Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (vals.length - 1))
        : 0;
    stats.push({ m, sd });
  }

  const scored = rows.map((r, i) => {
    const z = vectors[i]!.map((v, j) => {
      const { m, sd } = stats[j]!;
      if (v === null || !Number.isFinite(v) || sd <= 0) return 0;
      return Math.max(-3, Math.min(3, (v - m) / sd));
    });
    const contributions: Record<string, number> = {};
    for (const b of BUCKETS) contributions[b] = 0;
    FEATURE_SPECS.forEach((spec, j) => {
      contributions[spec.bucket] = (contributions[spec.bucket] ?? 0) + z[j]! * (model.coefficients[j] ?? 0);
    });
    return {
      symbol: String(r["symbol"] ?? ""),
      score: dot(z, model.coefficients),
      percentile: 0,
      contributions,
    };
  });

  const sorted = [...scored].sort((a, b) => a.score - b.score);
  sorted.forEach((s, i) => {
    s.percentile = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
  });
  return scored;
}

/** Prompt block handed to the AI alongside the candidate table. */
export function formatModelBlock(model: StoredModel | null, scores: SymbolScore[]): string {
  if (!model) return "";
  const bw = Object.entries(model.bucket_weights)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}%`)
    .join(", ");
  const top = [...scores].sort((a, b) => b.score - a.score);
  const table = top
    .slice(0, 12)
    .map((s) => `- ${s.symbol}: mdl ${s.score.toFixed(2)} (pct ${(s.percentile * 100).toFixed(0)})`)
    .join("\n");
  const worst = top
    .slice(-4)
    .map((s) => `${s.symbol} ${s.score.toFixed(2)}`)
    .join(", ");

  const drivers = model.feature_keys
    .map((k, i) => ({ k, c: model.coefficients[i] ?? 0 }))
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 6)
    .map((d) => `${labelOf(d.k)} ${d.c >= 0 ? "+" : ""}${d.c.toFixed(4)}`)
    .join("; ");

  const m = model.metrics.test;
  return `LEARNED MODEL — FITTED ON THIS ACCOUNT'S OWN HISTORY (${model.coverage.samples} observations, ${model.coverage.dates} trading days ${model.coverage.from ?? "?"} → ${model.coverage.to ?? "?"}):
- This is not a prior or a rule of thumb: it is a ridge regression of the exact signal snapshots you were shown on each past day against the realised ${model.horizon_days}-day forward return, demeaned within each day so it measures SELECTION skill, not market direction.
- Out-of-sample check (${m.dates} days never used in fitting): mean rank IC ${m.mean_ic?.toFixed(3) ?? "n/a"} (t ${m.ic_t_stat?.toFixed(2) ?? "n/a"}), positive on ${m.ic_hit_rate == null ? "n/a" : (m.ic_hit_rate * 100).toFixed(0)}% of days, top-minus-bottom spread ${m.top_bottom_spread_pct?.toFixed(2) ?? "n/a"}% per ${model.horizon_days}d.
- ${model.usable ? "VERDICT: the edge held out of sample — treat the mdl score as real evidence." : "VERDICT: the out-of-sample edge is WEAK. Use the mdl score only as a tie-breaker, never as a reason on its own."}
- Signal weights measured from your results (this is what has actually paid): ${bw || "n/a"}. Where your instinctive weighting differs from these, justify the difference explicitly.
- Strongest fitted drivers: ${drivers}.
${table ? `\nTODAY'S MODEL RANKING (higher = better expected ${model.horizon_days}d relative return):\n${table}\nWeakest: ${worst}.` : ""}
- A BUY on a bottom-quartile mdl score needs an explicit reason in the rationale for overriding the fitted evidence.`;
}
