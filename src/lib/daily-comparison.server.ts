// Daily comparison: what the learned model ranks today, what the rule set
// would do with the same snapshot, and how reliable each name's signal has
// historically been.
//
// The whole point of the historical column is ordering: a top model score on
// an instrument whose score has never predicted anything for this book is not
// the same trade as a mid-table score on a name with a long, stable record.
// Rows come back strongest-signal-first.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildHeuristicBuys, buildHeuristicSells, type HeuristicFeature } from "./heuristic-decision";
import { loadLatestModel, loadScoringContext, scoreCandidates } from "./decision-model/model.server";
import { loadSymbolStrengths, strengthSymbolKey } from "./decision-model/symbol-strength.server";
import { strengthAdjustedScore, strengthLabel, NEUTRAL_STRENGTH } from "./decision-model/symbol-strength";
import { loadMarketStrengths } from "./decision-model/symbol-strength.server";
import {
  classifyMarketGroup,
  marketSessionWeight,
  sessionForTimestamp,
  MARKET_GROUPS,
  MARKET_LABELS,
  SESSION_LABELS,
  type MarketGroup,
  type SessionBucket,
} from "./decision-model/market-strength";
import { UNIVERSE } from "./universe.server";

export type ComparisonRow = {
  symbol: string;
  name: string;
  price: number | null;
  /** Learned-model score for today, and its rank (1 = best). */
  modelScore: number | null;
  modelRank: number | null;
  /** What the AI actually asked for on this name today. */
  aiSide: "buy" | "sell" | null;
  aiSize: number | null;
  aiConviction: number | null;
  /** What the deterministic rule set would do with the same snapshot. */
  ruleSide: "buy" | "sell" | null;
  /** Rule-set stake as a percentage of available cash. */
  rulePercent: number | null;
  /** Historical signal strength for this name. */
  strength: number;
  strengthLabel: "strong" | "moderate" | "weak" | "unproven";
  strengthMeasured: boolean;
  samples: number;
  hitRate: number | null;
  meanNetBps: number | null;
  ic: number | null;
  from: string | null;
  to: string | null;
  /** Coarse market this name belongs to. */
  market: MarketGroup;
  /** Score weight applied for this market at the current time of day. */
  marketWeight: number;
  /** True when the AI and the rule set disagree on this name. */
  differs: boolean;
};

export type MarketStrengthCell = {
  market: MarketGroup;
  marketLabel: string;
  /** All-day record. */
  strength: number;
  strengthLabel: "strong" | "moderate" | "weak" | "unproven";
  samples: number;
  hitRate: number | null;
  meanNetBps: number | null;
  /** Record in the session the latest decision was made in (when known). */
  session: SessionBucket | null;
  sessionLabel: string | null;
  sessionStrength: number | null;
  sessionStrengthLabel: "strong" | "moderate" | "weak" | "unproven" | null;
  sessionSamples: number | null;
  /** Blended weight the engine applies to this market's scores right now. */
  weight: number;
};

export type DailyComparison = {
  ok: boolean;
  error?: string;
  asOf: string | null;
  decisionAt: string | null;
  horizonDays: number;
  modelUsable: boolean;
  strengthsMeasured: number;
  /** Signal strength by market at the current time of day. */
  markets: MarketStrengthCell[];
  rows: ComparisonRow[];
};

type SignalRow = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function buildDailyComparison(args: {
  userId: string;
  portfolioId: string;
  horizonDays?: number;
}): Promise<DailyComparison> {
  const horizonDays = args.horizonDays ?? 5;
  const empty: DailyComparison = {
    ok: false,
    asOf: null,
    decisionAt: null,
    horizonDays,
    modelUsable: false,
    strengthsMeasured: 0,
    rows: [],
  };

  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("id, user_id, current_cash, risk_level")
    .eq("id", args.portfolioId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!portfolio) return { ...empty, error: "Portfolio not found." };

  const { data: decision } = await supabaseAdmin
    .from("decisions")
    .select("created_at, run_date, raw")
    .eq("portfolio_id", args.portfolioId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = (decision?.raw ?? {}) as {
    signals?: SignalRow[];
    orders?: Array<Record<string, unknown>>;
    executed?: Array<Record<string, unknown>>;
  };
  const signals = Array.isArray(raw.signals) ? raw.signals : [];
  if (signals.length === 0) {
    return { ...empty, error: "No recent decision snapshot to compare yet." };
  }

  const asOf =
    (decision?.run_date as string | null) ??
    (decision?.created_at ? String(decision.created_at).slice(0, 10) : null);

  const { data: holdingRows } = await supabaseAdmin
    .from("holdings")
    .select("symbol, quantity, avg_cost, opened_at")
    .eq("portfolio_id", args.portfolioId);
  const holdings = (holdingRows ?? []).map((h) => ({
    symbol: String(h.symbol),
    quantity: Number(h.quantity) || 0,
    avg_cost: Number(h.avg_cost) || 0,
    opened_at: (h as { opened_at?: string | null }).opened_at ?? null,
  }));

  // ---- learned model ranking -------------------------------------------
  let modelScores = new Map<string, { score: number; rank: number }>();
  let modelUsable = false;
  try {
    const model = await loadLatestModel(args.userId);
    if (model && model.coefficients.length > 0) {
      modelUsable = model.usable;
      const ctx = await loadScoringContext(asOf ?? undefined);
      const cash = Number(portfolio.current_cash) || 0;
      const totalValue =
        cash +
        holdings.reduce((a, h) => {
          const s = signals.find((r) => String(r["symbol"]) === h.symbol);
          return a + h.quantity * (num(s?.["price"]) ?? h.avg_cost);
        }, 0);
      const scores = scoreCandidates(
        model,
        signals,
        { totalValue: totalValue || cash || 1, cash, holdings, ...(asOf ? { asOf } : {}) },
        ctx,
      );
      const ordered = [...scores].sort((a, b) => b.score - a.score);
      modelScores = new Map(
        ordered.map((s, i) => [s.symbol, { score: s.score, rank: i + 1 }]),
      );
    }
  } catch {
    /* the comparison still works without the model column */
  }

  // ---- rule-set ranking on the same snapshot ---------------------------
  const features: HeuristicFeature[] = signals.map((s) => ({
    symbol: String(s["symbol"] ?? ""),
    rsi14: num(s["rsi14"]),
    change5d: num(s["change5d"]),
    change30d: num(s["change30d"]),
    macd_hist: num(s["macd_hist"]),
    assetClass: (s["asset_class"] as string | null) ?? null,
  }));
  const ruleBuys = buildHeuristicBuys(holdings, features, {
    cashValue: Number(portfolio.current_cash) || 0,
    riskLevel: portfolio.risk_level,
  });
  const ruleSells = buildHeuristicSells(holdings, features);
  const ruleBySymbol = new Map<string, { side: "buy" | "sell"; percent: number | null }>();
  for (const b of ruleBuys) ruleBySymbol.set(b.symbol, { side: "buy", percent: b.percent });
  for (const s of ruleSells) ruleBySymbol.set(s.symbol, { side: "sell", percent: null });

  // ---- what the AI actually asked for today ----------------------------
  const aiBySymbol = new Map<string, { side: "buy" | "sell"; conviction: number | null; size: number | null }>();
  for (const o of raw.orders ?? []) {
    const sym = String(o["symbol"] ?? "");
    const side = o["side"] === "sell" ? "sell" : o["side"] === "buy" ? "buy" : null;
    if (!sym || !side) continue;
    aiBySymbol.set(sym, { side, conviction: num(o["conviction"]), size: null });
  }
  for (const e of raw.executed ?? []) {
    const sym = String(e["symbol"] ?? "");
    const prev = aiBySymbol.get(sym);
    if (!prev) continue;
    prev.size = num(e["value"]);
  }

  // ---- historical signal strength --------------------------------------
  const strengths = await loadSymbolStrengths(args.userId, horizonDays);

  const rows: ComparisonRow[] = signals.map((s) => {
    const symbol = String(s["symbol"] ?? "");
    const hist = strengths.get(strengthSymbolKey(symbol)) ?? null;
    const strength = hist?.strength ?? NEUTRAL_STRENGTH;
    const m = modelScores.get(symbol) ?? null;
    const rule = ruleBySymbol.get(symbol) ?? null;
    const ai = aiBySymbol.get(symbol) ?? null;
    return {
      symbol,
      name: String(s["name"] ?? symbol),
      price: num(s["price"]),
      modelScore: m?.score ?? null,
      modelRank: m?.rank ?? null,
      aiSide: ai?.side ?? null,
      aiSize: ai?.size ?? null,
      aiConviction: ai?.conviction ?? null,
      ruleSide: rule?.side ?? null,
      rulePercent: rule?.percent ?? null,
      strength,
      strengthLabel: strengthLabel(strength),
      strengthMeasured: Boolean(hist),
      samples: hist?.samples ?? 0,
      hitRate: hist?.hitRate ?? null,
      meanNetBps: hist?.meanNetBps ?? null,
      ic: hist?.ic ?? null,
      from: hist?.from ?? null,
      to: hist?.to ?? null,
      differs: (ai?.side ?? null) !== (rule?.side ?? null),
    };
  });

  // Strongest historical signal first; within that, the best model score.
  rows.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    return (
      strengthAdjustedScore(b.modelScore ?? 0, b.strength) -
      strengthAdjustedScore(a.modelScore ?? 0, a.strength)
    );
  });

  return {
    ok: true,
    asOf,
    decisionAt: decision?.created_at ? String(decision.created_at) : null,
    horizonDays,
    modelUsable,
    strengthsMeasured: [...strengths.values()].length,
    rows,
  };
}
