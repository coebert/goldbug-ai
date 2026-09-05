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
  strengthAdjustedScore,
  strengthLabel,
  type SymbolStrength,
} from "./symbol-strength";
import {
  BUCKETS,
  FEATURE_KEYS,
  FEATURE_SPECS,
  NEUTRAL_PF,
  NEUTRAL_MX,
  NEUTRAL_SX,
  regimeRiskOn,
  withContext,
  bucketOf,
  extractFeatureVector,
  labelOf,
  withPf,
  type AnyRow,
  type MxContext,
  type PfContext,
  type SxContext,
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
    /** How the label was built: cost/risk-adjusted, or the raw forward return. */
    label_mode?: string;
    /** Observations on days this account actually traded the name. */
    traded_samples?: number;
    /** Observations where the name was already held. */
    held_samples?: number;
    /** Round-trip dealing cost subtracted from the label, in bps. */
    round_trip_cost_bps?: number;
    cost_calibrated_symbols?: number;
    mean_weight?: number;
    trades_scanned?: number;
    /** Rows rebuilt from bars before the engine kept records. */
    history_samples?: number;
    history_from?: string | null;
    /** Split of the measured round-trip cost. */
    cost_fee_bps?: number;
    cost_slippage_bps?: number;
    cost_fills?: number;
    cost_invoiced_fills?: number;
  };

  /** True when out-of-sample evidence says the fit is worth trading at all. */
  usable: boolean;
  /**
   * 0..1 — how strong the out-of-sample evidence is, scaling how aggressively
   * the model may be traded. 1 = full bar cleared; a small but real edge sits
   * below and is traded at proportionally reduced size. 0 = inspection-only.
   */
  edge_strength: number;
  note: string;
};

/** Out-of-sample bars a fit must clear before the engine is allowed to use it at full size. */
export const MIN_TEST_DATES = 8;
export const MIN_MEAN_IC = 0.02;
/** The out-of-sample IC must also be stable, not one lucky week, for full size. */
export const MIN_IC_T = 1.5;
/**
 * Hard floors for ANY trading use. Below these there is no evidence of edge at
 * all and the fit stays inspection-only; between the floor and the full bar the
 * edge is small but real and is traded at reduced size (edge_strength < 1).
 */
export const FLOOR_MEAN_IC = 0.005;
export const FLOOR_IC_T = 0.5;
/** Smallest traded size fraction once the floor is cleared. */
export const MIN_EDGE_STRENGTH = 0.25;


export async function fitAndStoreModel(args: {
  userId: string;
  horizonDays?: number;
  realMoneyOnly?: boolean;
  /** `risk_net` (default): forward return net of this account's dealing costs, per unit of risk. */
  labelMode?: "risk_net" | "price";
  /** Years of bar history rebuilt behind the first recorded decision (0 = off). */
  historyYears?: number;
}): Promise<StoredModel> {
  const data = await buildDataset({
    userId: args.userId,
    horizonDays: args.horizonDays ?? 5,
    realMoneyOnly: args.realMoneyOnly ?? false,
    labelMode: args.labelMode ?? "risk_net",
    ...(args.historyYears === undefined ? {} : { historyYears: args.historyYears }),
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
  const testT = wf.best.test.ic_t_stat;
  // A positive mean IC on its own is not evidence: with a couple of dozen test
  // days it is routinely noise. The fit must also show some stability and beat
  // the naive equal-weight composite on the same days. But the bar is graded,
  // not binary: a small edge that clears the hard floors is tradeable at
  // reduced size — only a fit with no real evidence stays inspection-only.
  const beatsBaseline = testIc !== null && testIc > (baselineTest.mean_ic ?? -Infinity);
  const usable =
    wf.best.test.dates >= MIN_TEST_DATES &&
    testIc !== null &&
    testIc >= FLOOR_MEAN_IC &&
    testT !== null &&
    testT >= FLOOR_IC_T &&
    beatsBaseline &&
    (wf.best.test.top_bottom_spread_pct ?? 0) > 0;

  // Evidence strength scales toward 1 as the out-of-sample IC and its t-stat
  // reach the full bars; a fit that only just clears the floor trades at
  // MIN_EDGE_STRENGTH of normal size.
  const edge_strength = usable
    ? Math.max(
        MIN_EDGE_STRENGTH,
        Math.min(
          1,
          0.5 * Math.min(1, (testIc ?? 0) / MIN_MEAN_IC) +
            0.5 * Math.min(1, (testT ?? 0) / MIN_IC_T),
        ),
      )
    : 0;

  const note = usable
    ? edge_strength >= 1
      ? `Out-of-sample selection edge confirmed over ${wf.best.test.dates} days (mean IC ${(testIc ?? 0).toFixed(3)}, t ${(testT ?? 0).toFixed(2)}) — full-size trading evidence.`
      : `Small but real out-of-sample edge over ${wf.best.test.dates} days (mean IC ${(testIc ?? 0).toFixed(3)}, t ${(testT ?? 0).toFixed(2)}) — tradeable at ${(edge_strength * 100).toFixed(0)}% of normal size, not full conviction.`
    : `Fit stored for inspection but NOT used for trading: no real out-of-sample edge (mean IC ${
        testIc === null ? "n/a" : testIc.toFixed(3)
      }, t ${testT === null ? "n/a" : testT.toFixed(2)} over ${wf.best.test.dates} days).`;


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
      label_mode: data.labelMode,
      traded_samples: data.tradedSamples,
      held_samples: data.heldSamples,
      round_trip_cost_bps: data.roundTripCostBps,
      cost_calibrated_symbols: data.costCalibratedSymbols,
      mean_weight: data.meanWeight,
      trades_scanned: data.tradesScanned,
      history_samples: data.historySamples,
      history_from: data.historyFrom,
      cost_fee_bps: data.costFeeBps,
      cost_slippage_bps: data.costSlippageBps,
      cost_fills: data.costFills,
      cost_invoiced_fills: data.costInvoicedFills,
    },

    usable,
    edge_strength,
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
      // edge_strength rides inside the metrics JSON so no schema change is needed.
      metrics: asJson({ ...model.metrics, edge_strength: model.edge_strength }),
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
    // Older rows predate the graded gate: a usable fit was full-strength.
    edge_strength: (() => {
      const v = Number((data.metrics as Record<string, unknown> | null)?.["edge_strength"]);
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
      return data.usable === true ? 1 : 0;
    })(),
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
 * Today's book, so the portfolio features see the same shape at scoring time
 * as the dataset builder gave them during the fit.
 */
export type BookSnapshot = {
  totalValue: number;
  cash: number;
  /** Highest total value the book has reached; enables the drawdown feature. */
  peakValue?: number | null;
  holdings: Array<{
    symbol: string;
    quantity: number;
    avg_cost?: number | null;
    opened_at?: string | null;
  }>;
  /** Decayed realised loss per symbol as a fraction of the book (<= 0). */
  lossMemory?: Record<string, number>;
  asOf?: string;
};

function baseSymbol(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase();
}

/** Account-state block for one candidate row, from today's book. */
export function pfFor(book: BookSnapshot | null | undefined, row: AnyRow): PfContext {
  if (!book || !(book.totalValue > 0)) return NEUTRAL_PF;
  const symbol = String(row["symbol"] ?? "");
  const key = baseSymbol(symbol);
  const h = book.holdings.find((x) => baseSymbol(x.symbol) === key);
  const price = Number(row["price"]) || 0;
  const qty = Number(h?.quantity) || 0;
  const avgCost = Number(h?.avg_cost) || 0;
  const held = qty > 0;
  const asOf = book.asOf ?? new Date().toISOString().slice(0, 10);
  const openedAt = h?.opened_at ? String(h.opened_at).slice(0, 10) : null;
  const holdDays =
    held && openedAt ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(openedAt)) / 86_400_000)) : 0;
  const peak = Number(book.peakValue) || book.totalValue;

  return {
    position_weight: held && price > 0 ? Math.min(1, (qty * price) / book.totalValue) : 0,
    unrealised_pct: held && avgCost > 0 && price > 0 ? Math.max(-0.9, Math.min(3, price / avgCost - 1)) : 0,
    hold_days: holdDays,
    loss_memory: Math.max(-1, Math.min(0, Number(book.lossMemory?.[key]) || 0)),
    cash_weight: Math.max(0, Math.min(1, book.cash / book.totalValue)),
    book_drawdown: peak > 0 ? Math.max(-0.9, Math.min(0, book.totalValue / peak - 1)) : 0,
  };
}

/**
 * Apply the stored model to today's candidate rows. Normalisation matches the
 * training path exactly: z-scored across today's candidates, winsorised. Pass
 * `book` so the portfolio-state features are populated as they were in training.
 */
export function scoreCandidates(
  model: StoredModel,
  rows: AnyRow[],
  book?: BookSnapshot | null,
  ctx?: ScoringContext | null,
): SymbolScore[] {
  if (rows.length < 3 || model.coefficients.length !== FEATURE_KEYS.length) return [];

  const vectors = rows.map((r) => {
    const withBook = book ? withPf(r, pfFor(book, r)) : r;
    return extractFeatureVector(
      withContext(withBook, {
        date: ctx?.date ?? book?.asOf ?? null,
        mx: ctx?.mx ?? NEUTRAL_MX,
        sx: ctx?.sectorFor?.(String(r["symbol"] ?? ""), book ?? null) ?? NEUTRAL_SX,
      }),
    );
  });

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

/**
 * Day-level market/sector context for live scoring. `loadScoringContext` builds
 * it from the same tables the training set reads, so the fitted coefficients
 * see the same inputs live as they did in the fit.
 */
export type ScoringContext = {
  date: string;
  mx: MxContext;
  sectorFor: (symbol: string, book: BookSnapshot | null) => SxContext;
};

export async function loadScoringContext(asOf?: string): Promise<ScoringContext> {
  const date = asOf ?? new Date().toISOString().slice(0, 10);
  const { symbolSector } = await import("../sector-rotation.server");

  const { data: reg } = await supabaseAdmin
    .from("market_regimes")
    .select("regime, signals")
    .lte("as_of", date)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sig = (reg?.signals ?? {}) as Record<string, unknown>;
  const n = (k: string): number | null => {
    const v = Number(sig[k]);
    return Number.isFinite(v) ? v : null;
  };
  const mx: MxContext = reg
    ? {
        vix_level: n("vix_level"),
        spy_drawdown_pct: n("spy_drawdown_pct"),
        spy_price: n("spy_price"),
        spy_sma200: n("spy_sma200"),
        spy_return_30d: n("spy_return_30d"),
        tlt_return_30d: n("tlt_return_30d"),
        gld_return_30d: n("gld_return_30d"),
        risk_on: regimeRiskOn(reg.regime as string | null),
      }
    : NEUTRAL_MX;

  const { data: secRows } = await supabaseAdmin
    .from("sector_scores")
    .select("as_of, sector, momentum_30d, momentum_90d, rank")
    .lte("as_of", date)
    .order("as_of", { ascending: false })
    .limit(40);
  const latest = secRows?.[0]?.as_of ?? null;
  const standings = new Map<string, { m30: number | null; m90: number | null; rank: number | null }>();
  let maxRank = 0;
  for (const r of secRows ?? []) {
    if (r.as_of !== latest) continue;
    const rank = Number(r.rank);
    if (Number.isFinite(rank)) maxRank = Math.max(maxRank, rank);
    standings.set(String(r.sector), {
      m30: Number.isFinite(Number(r.momentum_30d)) ? Number(r.momentum_30d) : null,
      m90: Number.isFinite(Number(r.momentum_90d)) ? Number(r.momentum_90d) : null,
      rank: Number.isFinite(rank) ? rank : null,
    });
  }

  return {
    date,
    mx,
    sectorFor: (symbol, book) => {
      const sector = symbolSector(baseSymbol(symbol));
      if (!sector) return NEUTRAL_SX;
      const st = standings.get(sector);
      let bookWeight = 0;
      if (book && book.totalValue > 0) {
        let value = 0;
        for (const h of book.holdings) {
          if (symbolSector(baseSymbol(h.symbol)) !== sector) continue;
          const qty = Number(h.quantity) || 0;
          const cost = Number(h.avg_cost) || 0;
          if (qty > 0 && cost > 0) value += qty * cost;
        }
        bookWeight = Math.min(1, value / book.totalValue);
      }
      return {
        momentum_30d: st?.m30 ?? null,
        momentum_90d: st?.m90 ?? null,
        rank_norm: st?.rank != null && maxRank > 1 ? 1 - (2 * (st.rank - 1)) / (maxRank - 1) : null,
        book_weight: bookWeight,
      };
    },
  };
}

/** Prompt block handed to the AI alongside the candidate table. */
export function formatModelBlock(
  model: StoredModel | null,
  scores: SymbolScore[],
  /**
   * Per-symbol historical signal strength, keyed by base symbol. When present
   * the ranking is ordered by the strength-adjusted score, so names whose
   * signals have actually predicted this book's results come first and the AI
   * spends its risk budget on the strongest evidence rather than on whichever
   * noisy instrument happened to top today's raw score.
   */
  strengths?: Map<string, SymbolStrength> | null,
  /**
   * Market × time-of-day track record plus the session this decision is
   * being made in. When present, the ranking also scales each candidate by
   * how reliable that market's signals have been at this time of day.
   */
  market?: {
    rows: import("./market-strength").MarketStrength[];
    session: import("./market-strength").SessionBucket | null;
    assetClassBySymbol?: Map<string, string>;
  } | null,
): string {
  if (!model) return "";
  const bw = Object.entries(model.bucket_weights)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}%`)
    .join(", ");
  const strengthFor = (symbol: string): SymbolStrength | null =>
    strengths?.get(baseSymbol(symbol).replace(/\.L$/, "")) ?? null;
  const marketWeightFor = (symbol: string): number => {
    if (!market || market.rows.length === 0) return 1;
    const base = baseSymbol(symbol);
    return marketSessionWeight({
      market: classifyMarketGroup(base, market.assetClassBySymbol?.get(base)),
      session: market.session,
      rows: market.rows,
    });
  };
  const adjustedScore = (s: SymbolScore): number =>
    strengthAdjustedScore(s.score, strengthFor(s.symbol)?.strength) * marketWeightFor(s.symbol);
  const top = [...scores].sort((a, b) => adjustedScore(b) - adjustedScore(a));
  const table = top
    .slice(0, 12)
    .map((s) => {
      const h = strengthFor(s.symbol);
      const hist = h
        ? ` | track record ${strengthLabel(h.strength)} (${h.samples} obs, right ${h.hitRate == null ? "n/a" : (h.hitRate * 100).toFixed(0)}%, avg ${h.meanNetBps == null ? "n/a" : `${h.meanNetBps >= 0 ? "+" : ""}${h.meanNetBps.toFixed(0)}bps`} net)`
        : " | track record unmeasured";
      return `- ${s.symbol}: mdl ${s.score.toFixed(2)} (pct ${(s.percentile * 100).toFixed(0)})${hist}`;
    })
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
  const cov = model.coverage;

  const labelLine =
    cov.label_mode === "price"
      ? `the realised ${model.horizon_days}-day forward return`
      : `the realised ${model.horizon_days}-day forward return NET of the round-trip dealing cost this account actually pays (${cov.round_trip_cost_bps ?? "?"}bps, priced ticket by ticket from ${cov.cost_fills ?? 0} real fills across ${cov.cost_calibrated_symbols ?? 0} symbols), divided by the risk the name was carrying — i.e. what this book could actually have banked per unit of risk`;
  return `LEARNED MODEL — FITTED ON THIS ACCOUNT'S OWN HISTORY (${cov.samples} observations, ${cov.dates} trading days ${cov.from ?? "?"} → ${cov.to ?? "?"}; ${cov.traded_samples ?? 0} of them days you actually dealt the name, ${cov.held_samples ?? 0} where you already held it):
- This is not a prior or a rule of thumb: it is a ridge regression of the exact signal snapshots you were shown on each past day — plus the state of THIS book that day (position size, unrealised P&L, holding age, cash share, drawdown, recent realised loss on the name) — against ${labelLine}, demeaned within each day so it measures SELECTION skill, not market direction. Days where real money went in are weighted more heavily than days the name was merely screened.

- Out-of-sample check (${m.dates} days never used in fitting): mean rank IC ${m.mean_ic?.toFixed(3) ?? "n/a"} (t ${m.ic_t_stat?.toFixed(2) ?? "n/a"}), positive on ${m.ic_hit_rate == null ? "n/a" : (m.ic_hit_rate * 100).toFixed(0)}% of days, top-minus-bottom spread ${m.top_bottom_spread_pct?.toFixed(2) ?? "n/a"}% per ${model.horizon_days}d.
- ${model.usable ? (model.edge_strength >= 1 ? "VERDICT: the edge held out of sample — treat the mdl score as real evidence at full size." : `VERDICT: the out-of-sample edge is SMALL but real (strength ${(model.edge_strength * 100).toFixed(0)}%). You MAY trade on the mdl score, but scale any mdl-driven position to about ${(model.edge_strength * 100).toFixed(0)}% of the size the same conviction would normally get — a small edge earns a small stake, never a full one.`) : "VERDICT: no real out-of-sample edge. Use the mdl score only as a tie-breaker, never as a reason on its own."}
- Signal weights measured from your results (this is what has actually paid): ${bw || "n/a"}. Where your instinctive weighting differs from these, justify the difference explicitly.
- Strongest fitted drivers: ${drivers}.
${table ? `\nTODAY'S MODEL RANKING (higher = better expected ${model.horizon_days}d relative return):\n${table}\nWeakest: ${worst}.` : ""}
${strengths && strengths.size > 0 ? "- The ranking above is ordered by TRACK RECORD FIRST: each name's mdl score is discounted by how reliably that instrument's signals have predicted this account's own cost-adjusted outcomes. Trade the strongest track records first; a high mdl score on an 'unproven' name is a weaker reason than a moderate score on a 'strong' one, and deserves a smaller stake." : ""}
- A BUY on a bottom-quartile mdl score needs an explicit reason in the rationale for overriding the fitted evidence.`;
}
