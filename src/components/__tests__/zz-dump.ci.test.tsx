import { it, vi } from "vitest";
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => ({ items: [] }) }));
vi.mock("@/lib/trading.functions", () => ({ getGlobalNewsReel: {}, refreshGlobalNews: {} }));
vi.mock("@/lib/news-backfill.functions", () => ({ getNewsBackfillStatus:{}, startNewsBackfillRun:{}, advanceNewsBackfillRun:{}, cancelNewsBackfillRun:{} }));
vi.mock("@/lib/news-relevance-telemetry.functions", () => ({ getRelevanceScoringTelemetry: {} }));
const { NewsReel } = await import("@/components/news-reel");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { renderToStaticMarkup } = await import("react-dom/server");
import fs from "node:fs";
it("dump", () => {
  const c = new QueryClient();
  c.setQueryData(["global-news-reel",5,40], { items: [
   { id:"latin-1", date:"2026-07-30", fetched_at:"2026-07-30T09:00:00Z", source:"Reuters", headline:"Bank of England holds rates at 4.25%", url:"https://example.com/boe", original_headline:null, original_language:null, translation_confidence:null, relevance_score:70, relevance_reason:"r", relevance_tags:[], avg_sentiment:0.25, decisions_count:0, influences:[], note:"", excerpt:null, asset_classes:["equity"], risk_levels:["balanced"], symbols:[] },
   { id:"cjk-zh", date:"2026-07-30", fetched_at:"2026-07-30T11:30:00Z", source:"Reuters", headline:"China's central bank cuts the RRR", url:"https://example.com/z", original_headline:"中国央行下调存款准备金率", original_language:"zh", translation_confidence:0.94, relevance_score:88, relevance_reason:"r", relevance_tags:[], avg_sentiment:0.1, decisions_count:0, influences:[], note:"", excerpt:null, asset_classes:["equity"], risk_levels:["balanced"], symbols:[] },
  ], as_of:"2026-07-30T14:00:00Z", has_more:false, since_days:5, limit:40 });
  const html = renderToStaticMarkup(<QueryClientProvider client={c}><NewsReel /></QueryClientProvider>);
  fs.writeFileSync("/tmp/reel.html", html);
});
