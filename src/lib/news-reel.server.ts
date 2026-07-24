// Server-only helpers/types for the news reel. Split out per the
// tanstack-serverfn-splitting rule so `news.functions.ts` stays a thin
// wrapper.

export type NewsReelInfluence = {
  decision_id: string;
  portfolio_id: string;
  portfolio_name: string;
  run_date: string;
  sentiment: number | null;
  source_weight: number | null;
  impact: number | null;
  impact_pct: number | null;
  rationale: string | null;
  actions: Array<{ action: string; symbol: string; qty?: number | null }>;
};

export type NewsReelItem = {
  id: string;
  date: string;
  source: string | null;
  headline: string;
  url: string | null;
  original_headline: string | null;
  original_language: string | null;
  translation_confidence: number | null;

  avg_sentiment: number | null;
  decisions_count: number;
  influences: NewsReelInfluence[];
  note: string;
  excerpt: string | null;
  asset_classes: string[];
  risk_levels: string[];
  symbols: string[];
};

export type DecisionNewsItem = {
  headline: string;
  source: string | null;
  url: string | null;
  sentiment: number | null;
};

export type DecisionAction = { action: string; symbol: string; qty?: number | null };

export type DecisionBreakdownItem = {
  decision_id: string;
  portfolio_id: string;
  portfolio_name: string;
  run_date: string;
  rationale: string | null;
  actions: DecisionAction[];
  top_news: DecisionNewsItem[];
  total_news_considered: number;
};

// Trim a source summary to a short quotable citation snippet.
export function toExcerpt(raw: string | null | undefined, maxChars = 240): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
  const cut = lastStop > 120 ? lastStop + 1 : slice.lastIndexOf(" ");
  return (cut > 80 ? slice.slice(0, cut) : slice).trim() + "…";
}
