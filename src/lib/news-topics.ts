// Topic classification for the news reel.
//
// `news_cache` rows do not persist a topic column, so the reel derives one
// deterministically from the source hint (when the headline came from a
// catalogued feed) plus keyword matching over headline + excerpt. Keeping the
// logic here means the filter UI and any tests share one source of truth.

import { RSS_SOURCES, GDELT_SOURCES } from "@/lib/news-sources";

export type NewsTopicId =
  | "markets"
  | "macro"
  | "central-bank"
  | "energy"
  | "commodities"
  | "crypto"
  | "tech"
  | "companies"
  | "exec-posts"
  | "geopolitics"
  | "other";

export const NEWS_TOPICS: Array<{ id: NewsTopicId; label: string }> = [
  { id: "markets", label: "Markets" },
  { id: "macro", label: "Macro" },
  { id: "central-bank", label: "Central banks" },
  { id: "energy", label: "Energy" },
  { id: "commodities", label: "Commodities" },
  { id: "crypto", label: "Crypto" },
  { id: "tech", label: "Tech" },
  { id: "companies", label: "Companies" },
  { id: "exec-posts", label: "CEO posts" },
  { id: "geopolitics", label: "Geopolitics" },
  { id: "other", label: "Other" },
];

export function newsTopicLabel(id: string): string {
  return NEWS_TOPICS.find((t) => t.id === id)?.label ?? id;
}

// Keyword rules are evaluated in order; the first match wins. Ordering puts
// the most specific/actionable buckets ahead of broad ones.
const RULES: Array<{ id: NewsTopicId; re: RegExp }> = [
  { id: "exec-posts", re: /\b(elon musk|jensen huang|tim cook|sam altman|mark zuckerberg|jamie dimon|warren buffett|jeff bezos|michael saylor|donald trump)\b[^.]{0,80}\b(post(ed|s)?|tweet(ed|s)?|on x\b|truth social|linkedin post)\b/i },
  { id: "central-bank", re: /\b(fed|federal reserve|fomc|ecb|bank of england|boe|boj|bank of japan|pboc|rate (cut|hike|decision)|monetary policy|quantitative (easing|tightening)|central bank)\b/i },
  { id: "crypto", re: /\b(bitcoin|btc|ethereum|eth\b|crypto|stablecoin|blockchain|defi|altcoin|coinbase|binance)\b/i },
  { id: "energy", re: /\b(oil|brent|wti|crude|opec|natural gas|lng|refinery|petrol|diesel|electricity price|power grid|renewable|solar|wind farm)\b/i },
  { id: "commodities", re: /\b(gold|silver|copper|platinum|palladium|iron ore|wheat|corn|soybean|commodit\w+|bullion)\b/i },
  { id: "macro", re: /\b(inflation|cpi|ppi|gdp|unemployment|jobs report|payrolls|recession|tariff|trade deficit|budget|fiscal|bond yield|treasur\w+|growth forecast)\b/i },
  { id: "markets", re: /\b(stocks?|shares?|equit\w+|index(es)?|s&p|nasdaq|dow jones|ftse|dax|nikkei|market(s)? (rally|slump|selloff|close|open)|volatility|vix|futures)\b/i },
  { id: "tech", re: /\b(ai\b|artificial intelligence|chip(s|maker)?|semiconductor|software|cloud computing|data cent(er|re)|smartphone|cyber ?attack|apple|microsoft|nvidia|google|meta\b)\b/i },
  { id: "companies", re: /\b(earnings|revenue|profit warning|guidance|merger|acquisition|takeover|ipo|layoffs?|ceo|buyback|dividend|bankrupt\w*)\b/i },
  { id: "geopolitics", re: /\b(war|ceasefire|sanction\w*|election|invasion|missile|conflict|protest|summit|treaty|diplomat\w*|military|coup|border)\b/i },
];

// Source-level hints from the declarative feed catalogue, keyed by lowercase label.
const SOURCE_TOPIC_HINTS: Map<string, NewsTopicId> = (() => {
  const map = new Map<string, NewsTopicId>();
  const normalize = (t: string | undefined): NewsTopicId | null => {
    switch (t) {
      case "markets": return "markets";
      case "macro": return "macro";
      case "central-bank": return "central-bank";
      case "energy": return "energy";
      case "commodities": return "commodities";
      case "crypto": return "crypto";
      case "tech": return "tech";
      case "companies":
      case "business": return "companies";
      case "exec-posts": return "exec-posts";
      default: return null;
    }
  };
  for (const s of [...RSS_SOURCES, ...GDELT_SOURCES]) {
    const id = normalize(s.topic);
    if (id) map.set(s.label.toLowerCase(), id);
  }
  return map;
})();

export function classifyNewsTopic(item: {
  headline?: string | null;
  excerpt?: string | null;
  summary?: string | null;
  source?: string | null;
}): NewsTopicId {
  const text = `${item.headline ?? ""} ${item.excerpt ?? ""} ${item.summary ?? ""}`;
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.id;
  }
  const src = (item.source ?? "").trim().toLowerCase();
  if (src) {
    const hint = SOURCE_TOPIC_HINTS.get(src);
    if (hint) return hint;
    for (const [label, id] of SOURCE_TOPIC_HINTS) {
      if (src.includes(label) || label.includes(src)) return id;
    }
  }
  return "other";
}
