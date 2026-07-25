// Reconstruct a per-symbol confidence timeline from persisted `decisions` rows.
//
// Each decision row stores the AI's proposed orders (with conviction and
// signal weights), the news set fed to the model, and the market regime in
// force. We re-run `computeOrderConfidence` for every order to produce a
// chronological series per symbol — the same score users see on the order
// pill, laid out over time so regime shifts and news swings are visible.
//
// Pure, no I/O — safe to unit-test and import anywhere.

import {
  computeOrderConfidence,
  type ConfidenceNews,
  type ConfidenceRegime,
  type ConfidenceResult,
} from "./order-confidence";

export type ConfidencePoint = {
  decisionId: string;
  runDate: string;
  side: "buy" | "sell";
  score: number;
  base: number;
  regimeFactor: number;
  newsFactor: number;
  regimeLabel: string | null;
  regimeTransitioned: boolean;
  newsAligned: number;
  newsOpposing: number;
  status: "executed" | "rejected" | "proposed";
  rejectedReason: string | null;
};

export type ConfidenceSeries = {
  symbol: string;
  points: ConfidencePoint[];
};

type LooseOrder = {
  symbol?: string;
  side?: "buy" | "sell";
  conviction?: number | null;
  rejected?: string;
};

type LooseNews = {
  headline?: string;
  source?: string | null;
  sentiment?: number | null;
  source_weight?: number | null;
};

type LooseRegime = {
  regime?: string | null;
  confidence?: number | null;
  transitioned?: boolean | null;
  previous_regime?: string | null;
};

type LooseDecision = {
  id: string;
  run_date: string;
  raw: unknown;
};

function relatedNewsFor(symbol: string, news: LooseNews[]): ConfidenceNews[] {
  const sym = symbol.toLowerCase();
  const out: ConfidenceNews[] = [];
  for (const n of news) {
    if (!n?.headline) continue;
    if (!n.headline.toLowerCase().includes(sym)) continue;
    out.push({
      headline: n.headline,
      sentiment: n.sentiment ?? null,
      source_weight: n.source_weight ?? null,
    });
  }
  return out;
}

function countAlignment(
  side: "buy" | "sell",
  related: ConfidenceNews[],
): { aligned: number; opposing: number } {
  const sign = side === "buy" ? 1 : -1;
  let aligned = 0;
  let opposing = 0;
  for (const n of related) {
    const s = Number(n.sentiment ?? 0) * sign;
    if (s > 0.1) aligned++;
    else if (s < -0.1) opposing++;
  }
  return { aligned, opposing };
}

export function buildConfidenceTimeline(
  decisions: LooseDecision[],
): ConfidenceSeries[] {
  const bySymbol = new Map<string, ConfidencePoint[]>();

  // Iterate oldest -> newest so points come out chronological.
  const ordered = [...decisions].sort((a, b) =>
    a.run_date < b.run_date ? -1 : a.run_date > b.run_date ? 1 : 0,
  );

  for (const d of ordered) {
    const raw = (d.raw ?? {}) as {
      orders?: LooseOrder[];
      executed?: LooseOrder[];
      news?: LooseNews[];
      regime?: LooseRegime | null;
    };
    const orders = raw.orders ?? [];
    const executed = raw.executed ?? [];
    const news = raw.news ?? [];
    const regime: ConfidenceRegime = raw.regime
      ? {
          regime: raw.regime.regime ?? null,
          confidence: raw.regime.confidence ?? null,
          transitioned: raw.regime.transitioned ?? null,
          previous_regime: raw.regime.previous_regime ?? null,
        }
      : null;

    // Match executed outcome back to the proposed order so we can show
    // whether the point ended up filled or rejected.
    const outcomeByKey = new Map<string, LooseOrder>();
    for (const o of executed) {
      if (!o?.symbol || !o?.side) continue;
      outcomeByKey.set(`${o.symbol.toUpperCase()}:${o.side}`, o);
    }

    for (const o of orders) {
      if (!o?.symbol || !o?.side) continue;
      const symbol = o.symbol.toUpperCase();
      const side = o.side;
      const related = relatedNewsFor(symbol, news);
      const result: ConfidenceResult = computeOrderConfidence({
        side,
        conviction: o.conviction ?? null,
        regime,
        relatedNews: related,
      });
      const align = countAlignment(side, related);
      const outcome = outcomeByKey.get(`${symbol}:${side}`);
      const status: ConfidencePoint["status"] = outcome
        ? outcome.rejected
          ? "rejected"
          : "executed"
        : "proposed";
      const bucket = bySymbol.get(symbol) ?? [];
      bucket.push({
        decisionId: d.id,
        runDate: d.run_date,
        side,
        score: result.score,
        base: result.base,
        regimeFactor: result.regimeFactor,
        newsFactor: result.newsFactor,
        regimeLabel: regime?.regime ?? null,
        regimeTransitioned: Boolean(regime?.transitioned),
        newsAligned: align.aligned,
        newsOpposing: align.opposing,
        status,
        rejectedReason: outcome?.rejected ? String(outcome.rejected) : null,
      });
      bySymbol.set(symbol, bucket);
    }
  }

  return Array.from(bySymbol.entries())
    .map(([symbol, points]) => ({ symbol, points }))
    .sort((a, b) => {
      // Most-decided symbols first so the default selection is meaningful.
      if (a.points.length !== b.points.length) return b.points.length - a.points.length;
      return a.symbol.localeCompare(b.symbol);
    });
}
