// Declarative catalogue of world-event sources the news reel draws from.
// Broadening this list is the primary lever for "cover more of the world" —
// every source contributes a bounded slice (see `perFeedMax` + per-domain
// cap in `news.server.ts`) so no single wire can dominate the reel.
//
// Weights (0..1) feed the `news_cache.source_weight` column, which is used
// by the AI briefing prompt and by trade-signal blending — tier-one wires
// like Reuters/AP/BBC anchor above regional or single-topic feeds.

import { TRACKED_EXECUTIVES, execPostFeedQuery } from "@/lib/exec-posts";
import { TRACKED_POLICY_MAKERS, policyFeedQuery } from "@/lib/policy-makers";

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
  // --- Additional global wires & aggregators ---
  { kind: "rss", id: "reuters-google",  label: "Reuters (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+site:reuters.com&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.95, region: "Global", topic: "world" },
  { kind: "rss", id: "bloomberg-google",label: "Bloomberg (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+site:bloomberg.com&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.95, region: "Global", topic: "markets" },
  { kind: "rss", id: "gnews-markets",   label: "Google News · Markets",  url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-GB&gl=GB&ceid=GB:en", weight: 0.7, region: "Global", topic: "markets" },
  { kind: "rss", id: "yahoo-finance",   label: "Yahoo Finance",          url: "https://finance.yahoo.com/news/rssindex",                weight: 0.7,  region: "Global",  topic: "markets" },
  { kind: "rss", id: "marketwatch-top", label: "MarketWatch",            url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", weight: 0.8, region: "Americas", topic: "markets" },
  { kind: "rss", id: "investing-news",  label: "Investing.com",          url: "https://www.investing.com/rss/news.rss",                 weight: 0.6,  region: "Global",  topic: "markets" },
  { kind: "rss", id: "seeking-alpha",   label: "Seeking Alpha Market News", url: "https://seekingalpha.com/market_currents.xml",        weight: 0.6,  region: "Americas",topic: "markets" },
  { kind: "rss", id: "economist-fin",   label: "The Economist Finance",  url: "https://www.economist.com/finance-and-economics/rss.xml",weight: 0.9,  region: "Global",  topic: "macro" },
  { kind: "rss", id: "economist-biz",   label: "The Economist Business", url: "https://www.economist.com/business/rss.xml",             weight: 0.9,  region: "Global",  topic: "companies" },
  { kind: "rss", id: "npr-business",    label: "NPR Business",           url: "https://feeds.npr.org/1006/rss.xml",                     weight: 0.8,  region: "Americas",topic: "business" },
  { kind: "rss", id: "cbs-moneywatch",  label: "CBS MoneyWatch",         url: "https://www.cbsnews.com/latest/rss/moneywatch",          weight: 0.75, region: "Americas",topic: "business" },
  { kind: "rss", id: "abc-au-business", label: "ABC News Australia Business", url: "https://www.abc.net.au/news/feed/51892/rss.xml",    weight: 0.75, region: "Oceania", topic: "business" },
  { kind: "rss", id: "afr-google",      label: "AFR (via Google News)",  url: "https://news.google.com/rss/search?q=when:1d+site:afr.com&hl=en-AU&gl=AU&ceid=AU:en", weight: 0.7, region: "Oceania", topic: "markets" },
  { kind: "rss", id: "rte-business",    label: "RTÉ Business",           url: "https://www.rte.ie/feeds/rss/?index=/news/business/",    weight: 0.7,  region: "Europe",  topic: "business" },
  { kind: "rss", id: "sky-business",    label: "Sky News Business",      url: "https://feeds.skynews.com/feeds/rss/business.xml",       weight: 0.75, region: "Europe",  topic: "business" },
  { kind: "rss", id: "telegraph-biz",   label: "The Telegraph Business", url: "https://www.telegraph.co.uk/business/rss.xml",           weight: 0.75, region: "Europe",  topic: "business" },
  { kind: "rss", id: "independent-biz", label: "The Independent Business", url: "https://www.independent.co.uk/news/business/rss",      weight: 0.7,  region: "Europe",  topic: "business" },
  { kind: "rss", id: "cityam",          label: "City A.M.",              url: "https://www.cityam.com/feed/",                           weight: 0.65, region: "Europe",  topic: "markets" },
  { kind: "rss", id: "euronews-biz",    label: "Euronews Business",      url: "https://www.euronews.com/rss?level=theme&name=next",     weight: 0.7,  region: "Europe",  topic: "business" },
  { kind: "rss", id: "spiegel-intl",    label: "Der Spiegel International", url: "https://www.spiegel.de/international/index.rss",      weight: 0.8,  region: "Europe",  topic: "world" },
  { kind: "rss", id: "lemonde-en",      label: "Le Monde English",       url: "https://www.lemonde.fr/en/rss/une.xml",                  weight: 0.8,  region: "Europe",  topic: "world" },
  { kind: "rss", id: "swissinfo-biz",   label: "SWI swissinfo Business", url: "https://www.swissinfo.ch/service/rss/business/45359564", weight: 0.7,  region: "Europe",  topic: "business" },
  { kind: "rss", id: "moscow-times",    label: "The Moscow Times",       url: "https://www.themoscowtimes.com/rss/news",                weight: 0.6,  region: "Europe",  topic: "world" },
  // --- Asia / EM coverage ---
  { kind: "rss", id: "nikkei-google",   label: "Nikkei Asia (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+site:asia.nikkei.com&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.8, region: "Asia", topic: "markets" },
  { kind: "rss", id: "cna-business",    label: "Channel NewsAsia Business", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936", weight: 0.75, region: "Asia", topic: "business" },
  { kind: "rss", id: "straits-times",   label: "The Straits Times Business", url: "https://www.straitstimes.com/news/business/rss.xml", weight: 0.7,  region: "Asia",    topic: "business" },
  { kind: "rss", id: "economic-times",  label: "The Economic Times (India)", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", weight: 0.7, region: "Asia", topic: "markets" },
  { kind: "rss", id: "livemint",        label: "Mint (India)",           url: "https://www.livemint.com/rss/markets",                   weight: 0.65, region: "Asia",    topic: "markets" },
  { kind: "rss", id: "korea-herald",    label: "The Korea Herald Business", url: "https://www.koreaherald.com/rss/020000000000.xml",    weight: 0.65, region: "Asia",    topic: "business" },
  { kind: "rss", id: "taipei-times",    label: "Taipei Times Business",  url: "https://www.taipeitimes.com/xml/biz.rss",                weight: 0.6,  region: "Asia",    topic: "business" },
  { kind: "rss", id: "arab-news-biz",   label: "Arab News Business",     url: "https://www.arabnews.com/rss.xml",                       weight: 0.65, region: "MENA",    topic: "business" },
  { kind: "rss", id: "gulf-news-google",label: "Gulf markets (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+(Saudi+OR+UAE+OR+Qatar)+markets+OR+economy&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.6, region: "MENA", topic: "markets" },
  { kind: "rss", id: "allafrica-biz",   label: "AllAfrica Business",     url: "https://allafrica.com/tools/headlines/rdf/business/headlines.rdf", weight: 0.6, region: "Africa", topic: "business" },
  { kind: "rss", id: "buenosaires-econ",label: "Buenos Aires Times Economy", url: "https://www.batimes.com.ar/feed/economy",            weight: 0.55, region: "Americas",topic: "business" },
  { kind: "rss", id: "riotimes",        label: "The Rio Times Business", url: "https://www.riotimesonline.com/feed/",                   weight: 0.55, region: "Americas",topic: "business" },
  // --- Central banks, statistics & policy primary sources ---
  { kind: "rss", id: "imf-news",        label: "IMF News",               url: "https://www.imf.org/en/News/RSS?language=eng",           weight: 0.9,  region: "Global",  topic: "macro" },
  { kind: "rss", id: "worldbank",       label: "World Bank News",        url: "https://www.worldbank.org/en/news/all?format=rss",       weight: 0.85, region: "Global",  topic: "macro" },
  { kind: "rss", id: "bis-press",       label: "BIS Press",              url: "https://www.bis.org/doclist/press.rss",                  weight: 0.9,  region: "Global",  topic: "central-bank" },
  { kind: "rss", id: "oecd-newsroom",   label: "OECD Newsroom",          url: "https://www.oecd.org/newsroom/index.xml",                weight: 0.8,  region: "Global",  topic: "macro" },
  { kind: "rss", id: "boj-google",      label: "Bank of Japan (via Google News)", url: "https://news.google.com/rss/search?q=when:2d+%22Bank+of+Japan%22&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.8, region: "Asia", topic: "central-bank" },
  { kind: "rss", id: "snb-google",      label: "SNB / RBA / BoC (via Google News)", url: "https://news.google.com/rss/search?q=when:2d+(%22Swiss+National+Bank%22+OR+%22Reserve+Bank+of+Australia%22+OR+%22Bank+of+Canada%22)&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.75, region: "Global", topic: "central-bank" },
  { kind: "rss", id: "sec-press",       label: "US SEC Press",           url: "https://www.sec.gov/news/pressreleases.rss",             weight: 0.9,  region: "Americas",topic: "companies" },
  { kind: "rss", id: "ustreasury",      label: "US Treasury Press",      url: "https://home.treasury.gov/system/files/126/ofac.xml",     weight: 0.8,  region: "Americas",topic: "macro" },
  { kind: "rss", id: "eu-commission",   label: "European Commission",    url: "https://ec.europa.eu/commission/presscorner/api/rss?language=en", weight: 0.8, region: "Europe", topic: "macro" },
  { kind: "rss", id: "ons-uk",          label: "UK ONS Statistics",      url: "https://www.ons.gov.uk/releasecalendar?rss",             weight: 0.8,  region: "Europe",  topic: "macro" },
  // --- Commodities, energy & shipping ---
  { kind: "rss", id: "eia-today",       label: "US EIA Today in Energy", url: "https://www.eia.gov/rss/todayinenergy.xml",              weight: 0.85, region: "Americas",topic: "energy" },
  { kind: "rss", id: "iea-news",        label: "IEA News",               url: "https://www.iea.org/rss/news",                           weight: 0.85, region: "Global",  topic: "energy" },
  { kind: "rss", id: "mining-com",      label: "Mining.com",             url: "https://www.mining.com/feed/",                           weight: 0.65, region: "Global",  topic: "commodities" },
  { kind: "rss", id: "kitco-google",    label: "Gold & metals (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+(gold+price+OR+silver+price+OR+copper+price)&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.6, region: "Global", topic: "commodities" },
  { kind: "rss", id: "agri-google",     label: "Agriculture markets (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+(wheat+OR+corn+OR+soybean)+prices&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.55, region: "Global", topic: "commodities" },
  { kind: "rss", id: "splash247",       label: "Splash 247 (Shipping)",  url: "https://splash247.com/feed/",                            weight: 0.6,  region: "Global",  topic: "commodities" },
  // --- Tech & crypto depth ---
  { kind: "rss", id: "techcrunch",      label: "TechCrunch",             url: "https://techcrunch.com/feed/",                           weight: 0.65, region: "Global",  topic: "tech" },
  { kind: "rss", id: "theverge",        label: "The Verge",              url: "https://www.theverge.com/rss/index.xml",                 weight: 0.6,  region: "Global",  topic: "tech" },
  { kind: "rss", id: "arstechnica",     label: "Ars Technica",           url: "https://feeds.arstechnica.com/arstechnica/index",        weight: 0.6,  region: "Global",  topic: "tech" },
  { kind: "rss", id: "semianalysis-g",  label: "Semiconductors (via Google News)", url: "https://news.google.com/rss/search?q=when:1d+(semiconductor+OR+TSMC+OR+ASML+OR+Nvidia)&hl=en-GB&gl=GB&ceid=GB:en", weight: 0.7, region: "Global", topic: "tech" },
  { kind: "rss", id: "theblock",        label: "The Block",              url: "https://www.theblock.co/rss.xml",                        weight: 0.6,  region: "Global",  topic: "crypto" },
  { kind: "rss", id: "decrypt",         label: "Decrypt",                url: "https://decrypt.co/feed",                                weight: 0.55, region: "Global",  topic: "crypto" },
  { kind: "rss", id: "bitcoinmag",      label: "Bitcoin Magazine",       url: "https://bitcoinmagazine.com/feed",                       weight: 0.5,  region: "Global",  topic: "crypto" },
  // --- Executive social posts (reported by wires; see src/lib/exec-posts.ts) ---
  ...TRACKED_EXECUTIVES.map((exec) => ({
    kind: "rss" as const,
    id: `execpost-${exec.id}`,
    label: `${exec.name} posts (via Google News)`,
    url: execPostFeedQuery(exec),
    weight: Number((0.55 + 0.25 * exec.weight).toFixed(2)),
    region: "Global",
    topic: "exec-posts",
  })),
  // --- Policy-maker remarks (central bankers, finance ministers; see src/lib/policy-makers.ts) ---
  ...TRACKED_POLICY_MAKERS.map((maker) => ({
    kind: "rss" as const,
    id: `policy-${maker.id}`,
    label: `${maker.name} remarks (via Google News)`,
    url: policyFeedQuery(maker),
    weight: Number((0.6 + 0.3 * maker.weight).toFixed(2)),
    region: maker.region,
    topic: "policy-makers",
  })),
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
  { kind: "gdelt", id: "gdelt-commods",   label: "GDELT · Commodities",  weight: 0.65, topic: "commodities",
    query: "(gold OR copper OR \"iron ore\" OR wheat OR \"commodity prices\" OR lithium OR uranium)" },
  { kind: "gdelt", id: "gdelt-banks",     label: "GDELT · Banking & credit", weight: 0.7, topic: "companies",
    query: "(bank OR lender OR \"credit market\" OR default OR \"bond issuance\" OR \"private credit\" OR liquidity)" },
  { kind: "gdelt", id: "gdelt-supply",    label: "GDELT · Supply chains", weight: 0.65, topic: "macro",
    query: "(\"supply chain\" OR shipping OR freight OR \"port strike\" OR \"Red Sea\" OR logistics)" },
  { kind: "gdelt", id: "gdelt-defence",   label: "GDELT · Defence",      weight: 0.6, topic: "geopolitics",
    query: "(defence spending OR \"defense budget\" OR arms OR missile OR \"military exercise\")" },
  { kind: "gdelt", id: "gdelt-climate",   label: "GDELT · Climate & disruption", weight: 0.55, topic: "macro",
    query: "(hurricane OR drought OR flooding OR \"extreme weather\" OR \"climate policy\" OR \"carbon price\")" },
  { kind: "gdelt", id: "gdelt-em",        label: "GDELT · Emerging markets", weight: 0.6, topic: "macro",
    query: "(\"emerging markets\" OR India economy OR China economy OR Brazil economy OR \"currency crisis\" OR IMF bailout)" },
  { kind: "gdelt", id: "gdelt-policy",    label: "GDELT · Policy makers", weight: 0.8, topic: "policy-makers",
    query: "((Powell OR FOMC OR Lagarde OR Bailey OR Ueda OR \"Treasury Secretary\" OR Chancellor) AND (speech OR remarks OR testimony OR \"rate decision\" OR statement))" },
  { kind: "gdelt", id: "gdelt-execposts", label: "GDELT · CEO posts",    weight: 0.7, topic: "exec-posts",
    query: "((\"Elon Musk\" OR \"Jensen Huang\" OR \"Tim Cook\" OR \"Sam Altman\" OR \"Michael Saylor\" OR \"Jamie Dimon\") AND (post OR posted OR tweet OR \"on X\" OR \"Truth Social\"))" },
];



export const ALL_SOURCES: NewsSource[] = [...RSS_SOURCES, ...GDELT_SOURCES];
