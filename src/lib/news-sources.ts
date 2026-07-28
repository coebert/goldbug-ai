// Declarative catalogue of world-event sources the news reel draws from.
// Broadening this list is the primary lever for "cover more of the world" —
// every source contributes a bounded slice (see `perFeedMax` + per-domain
// cap in `news.server.ts`) so no single wire can dominate the reel.
//
// Weights (0..1) feed the `news_cache.source_weight` column, which is used
// by the AI briefing prompt and by trade-signal blending — tier-one wires
// like Reuters/AP/BBC anchor above regional or single-topic feeds.

export type NewsSource =
  | {
      kind: "rss";
      id: string;
      label: string;
      url: string;
      weight: number;
      // Optional editorial hint recorded on ingested rows to help the AI
      // reason about geographic / sector coverage without an extra lookup.
      region?: string;
      topic?: string;
    }
  | {
      kind: "gdelt";
      id: string;
      label: string;
      query: string;
      weight: number;
      topic?: string;
    };

// Tier-one wires and diversified regional / sector RSS feeds. All are
// publicly reachable without an API key.
export const RSS_SOURCES: Extract<NewsSource, { kind: "rss" }>[] = [
  // Global wires
  { kind: "rss", id: "reuters-world",  label: "Reuters World",         url: "https://feeds.reuters.com/Reuters/worldNews",           weight: 1.0, region: "Global",   topic: "world" },
  { kind: "rss", id: "reuters-biz",    label: "Reuters Business",      url: "https://feeds.reuters.com/reuters/businessNews",        weight: 1.0, region: "Global",   topic: "business" },
  { kind: "rss", id: "ap-topnews",     label: "Associated Press",      url: "https://feeds.apnews.com/apf-topnews",                  weight: 1.0, region: "Global",   topic: "top" },
  { kind: "rss", id: "bbc-world",      label: "BBC World",             url: "https://feeds.bbci.co.uk/news/world/rss.xml",           weight: 0.95, region: "Global",  topic: "world" },
  { kind: "rss", id: "bbc-business",   label: "BBC Business",          url: "https://feeds.bbci.co.uk/news/business/rss.xml",        weight: 0.9,  region: "Global",  topic: "business" },
  { kind: "rss", id: "aljazeera",      label: "Al Jazeera English",    url: "https://www.aljazeera.com/xml/rss/all.xml",             weight: 0.85, region: "MENA",    topic: "world" },
  { kind: "rss", id: "dw-top",         label: "Deutsche Welle",        url: "https://rss.dw.com/rdf/rss-en-top",                     weight: 0.85, region: "Europe",  topic: "world" },
  { kind: "rss", id: "france24",       label: "France 24",             url: "https://www.france24.com/en/rss",                       weight: 0.8,  region: "Europe",  topic: "world" },
  { kind: "rss", id: "guardian-world", label: "The Guardian World",    url: "https://www.theguardian.com/world/rss",                 weight: 0.85, region: "Europe",  topic: "world" },
  { kind: "rss", id: "guardian-biz",   label: "The Guardian Business", url: "https://www.theguardian.com/uk/business/rss",           weight: 0.8,  region: "Europe",  topic: "business" },
  { kind: "rss", id: "nyt-world",      label: "New York Times World",  url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",weight: 0.9,  region: "Americas",topic: "world" },
  { kind: "rss", id: "nyt-biz",        label: "New York Times Biz",    url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", weight: 0.9, region: "Americas", topic: "business" },
  { kind: "rss", id: "wsj-markets",    label: "WSJ Markets",           url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",         weight: 0.95, region: "Americas",topic: "markets" },
  { kind: "rss", id: "wsj-world",      label: "WSJ World",             url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml",           weight: 0.9,  region: "Americas",topic: "world" },
  { kind: "rss", id: "cnbc-top",       label: "CNBC Top News",         url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", weight: 0.85, region: "Americas",topic: "markets" },
  { kind: "rss", id: "cnbc-econ",      label: "CNBC Economy",          url: "https://www.cnbc.com/id/20910258/device/rss/rss.html",  weight: 0.85, region: "Americas",topic: "macro" },
  { kind: "rss", id: "ft-world",       label: "Financial Times World", url: "https://www.ft.com/world?format=rss",                   weight: 0.9,  region: "Europe",  topic: "world" },
  { kind: "rss", id: "ft-companies",   label: "FT Companies",          url: "https://www.ft.com/companies?format=rss",               weight: 0.85, region: "Europe",  topic: "companies" },
  { kind: "rss", id: "nhk-world",      label: "NHK World (Japan)",     url: "https://www3.nhk.or.jp/nhkworld/en/news/feeds/",        weight: 0.75, region: "Asia",    topic: "world" },
  { kind: "rss", id: "scmp-top",       label: "South China Morning Post", url: "https://www.scmp.com/rss/91/feed",                   weight: 0.75, region: "Asia",    topic: "world" },
  { kind: "rss", id: "japan-times",    label: "The Japan Times",       url: "https://www.japantimes.co.jp/feed/",                    weight: 0.7,  region: "Asia",    topic: "world" },
  { kind: "rss", id: "reuters-tech",   label: "Reuters Technology",    url: "https://feeds.reuters.com/reuters/technologyNews",      weight: 0.85, region: "Global",  topic: "tech" },
  { kind: "rss", id: "coindesk",       label: "CoinDesk",              url: "https://www.coindesk.com/arc/outboundfeeds/rss/",       weight: 0.7,  region: "Global",  topic: "crypto" },
  { kind: "rss", id: "cointelegraph",  label: "Cointelegraph",         url: "https://cointelegraph.com/rss",                         weight: 0.6,  region: "Global",  topic: "crypto" },
  { kind: "rss", id: "oilprice",       label: "OilPrice.com",          url: "https://oilprice.com/rss/main",                         weight: 0.7,  region: "Global",  topic: "energy" },
  { kind: "rss", id: "ecb",            label: "ECB Press",             url: "https://www.ecb.europa.eu/rss/press.html",              weight: 0.9,  region: "Europe",  topic: "central-bank" },
  { kind: "rss", id: "fed-press",      label: "US Federal Reserve",    url: "https://www.federalreserve.gov/feeds/press_all.xml",    weight: 0.95, region: "Americas",topic: "central-bank" },
  { kind: "rss", id: "boe",            label: "Bank of England",       url: "https://www.bankofengland.co.uk/rss/news",              weight: 0.9,  region: "Europe",  topic: "central-bank" },
];

// GDELT topical slices — issuing several narrow queries yields far broader
// coverage than one grab-bag OR query, because GDELT's `sort=hybridrel`
// operates per query. We keep the query count modest so a single day's
// refresh stays within GDELT's per-minute rate limits.
export const GDELT_SOURCES: Extract<NewsSource, { kind: "gdelt" }>[] = [
  { kind: "gdelt", id: "gdelt-macro",     label: "GDELT · Macro",        weight: 0.7, topic: "macro",
    query: "(inflation OR \"interest rates\" OR \"central bank\" OR CPI OR GDP OR unemployment OR recession)" },
  { kind: "gdelt", id: "gdelt-markets",   label: "GDELT · Markets",      weight: 0.7, topic: "markets",
    query: "(\"stock market\" OR equities OR bonds OR yields OR \"corporate earnings\" OR guidance OR IPO)" },
  { kind: "gdelt", id: "gdelt-geopol",    label: "GDELT · Geopolitics",  weight: 0.75, topic: "geopolitics",
    query: "(geopolitics OR sanctions OR \"trade war\" OR tariffs OR NATO OR \"United Nations\" OR summit)" },
  { kind: "gdelt", id: "gdelt-energy",    label: "GDELT · Energy",       weight: 0.7, topic: "energy",
    query: "(OPEC OR crude OR \"natural gas\" OR LNG OR OPEC+ OR \"oil price\" OR pipeline)" },
  { kind: "gdelt", id: "gdelt-tech",      label: "GDELT · Tech",         weight: 0.65, topic: "tech",
    query: "(\"artificial intelligence\" OR semiconductors OR chips OR datacenter OR cloud OR \"tech regulation\")" },
  { kind: "gdelt", id: "gdelt-crypto",    label: "GDELT · Crypto",       weight: 0.6, topic: "crypto",
    query: "(bitcoin OR ethereum OR \"crypto ETF\" OR stablecoin OR blockchain OR \"digital asset\")" },
  { kind: "gdelt", id: "gdelt-fx",        label: "GDELT · FX",           weight: 0.65, topic: "fx",
    query: "(\"foreign exchange\" OR \"currency market\" OR \"dollar index\" OR yuan OR yen OR sterling OR euro)" },
];

export const ALL_SOURCES: NewsSource[] = [...RSS_SOURCES, ...GDELT_SOURCES];
