// Public company-financials fetcher (Yahoo Finance quoteSummary).
//
// Only publicly disclosed information: reported accounts and the ratios derived
// from them, the company's published results calendar, and consensus sell-side
// estimates. No key required, but the endpoint needs a cookie + crumb pair, so
// a short-lived session is cached in module scope and re-minted on 401.

import type { Fundamentals } from "./types";

const MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "calendarEvents",
  "earningsTrend",
  "recommendationTrend",
].join(",");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type Session = { cookie: string; crumb: string; mintedAt: number };
let session: Session | null = null;
const SESSION_TTL_MS = 30 * 60 * 1000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function mintSession(): Promise<Session | null> {
  try {
    const seed = await fetchWithTimeout(
      "https://fc.yahoo.com",
      { headers: { "User-Agent": UA } },
      6_000,
    ).catch(() => null);
    const setCookie = seed?.headers.get("set-cookie") ?? "";
    await seed?.body?.cancel().catch(() => undefined);
    const cookie = setCookie.split(";")[0] ?? "";
    const res = await fetchWithTimeout(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) } },
      6_000,
    );
    if (!res.ok) return null;
    const crumb = (await res.text()).trim();
    if (!crumb || crumb.length > 32) return null;
    return { cookie, crumb, mintedAt: Date.now() };
  } catch {
    return null;
  }
}

export async function getYahooSession(force = false): Promise<Session | null> {
  return getSession(force);
}

async function getSession(force = false): Promise<Session | null> {
  if (!force && session && Date.now() - session.mintedAt < SESSION_TTL_MS) return session;
  session = await mintSession();
  return session;
}

/** Yahoo wraps most numbers as `{ raw, fmt }`; some come through bare. */
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }
  return null;
}

function isoDate(v: unknown): string | null {
  const n = num(v);
  if (n == null) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

type Bag = Record<string, unknown>;
const bag = (o: Bag, k: string): Bag => (o[k] as Bag | undefined) ?? {};

export function parseQuoteSummary(symbol: string, result: Bag): Fundamentals {
  const price = bag(result, "price");
  const sd = bag(result, "summaryDetail");
  const ks = bag(result, "defaultKeyStatistics");
  const fd = bag(result, "financialData");
  const cal = bag(result, "calendarEvents");

  const trend = (bag(result, "earningsTrend")["trend"] as Bag[] | undefined) ?? [];
  const growthFor = (period: string): number | null => {
    const row = trend.find((t) => t["period"] === period);
    return row ? num(row["growth"]) : null;
  };

  const recs = (bag(result, "recommendationTrend")["trend"] as Bag[] | undefined) ?? [];
  const rec = recs[0] ?? {};

  const earningsDates = bag(cal, "earnings")["earningsDate"] as unknown[] | undefined;

  return {
    symbol: symbol.toUpperCase(),
    currency: (price["currency"] as string | undefined) ?? null,
    financial_currency: (fd["financialCurrency"] as string | undefined) ?? null,

    market_cap: num(price["marketCap"]) ?? num(sd["marketCap"]),
    trailing_pe: num(sd["trailingPE"]),
    forward_pe: num(sd["forwardPE"]),
    peg: num(ks["pegRatio"]),
    price_to_book: num(ks["priceToBook"]),
    ev_ebitda: num(ks["enterpriseToEbitda"]),
    ev_revenue: num(ks["enterpriseToRevenue"]),

    gross_margin: num(fd["grossMargins"]),
    operating_margin: num(fd["operatingMargins"]),
    profit_margin: num(fd["profitMargins"]) ?? num(ks["profitMargins"]),
    return_on_equity: num(fd["returnOnEquity"]),
    return_on_assets: num(fd["returnOnAssets"]),

    revenue: num(fd["totalRevenue"]),
    revenue_growth: num(fd["revenueGrowth"]),
    earnings_growth: num(fd["earningsGrowth"]),
    eps_growth_next_q: growthFor("+1q"),
    eps_growth_next_y: growthFor("+1y"),
    trailing_eps: num(ks["trailingEps"]),
    forward_eps: num(ks["forwardEps"]),

    total_cash: num(fd["totalCash"]),
    total_debt: num(fd["totalDebt"]),
    debt_to_equity: num(fd["debtToEquity"]),
    current_ratio: num(fd["currentRatio"]),
    quick_ratio: num(fd["quickRatio"]),
    free_cashflow: num(fd["freeCashflow"]),
    operating_cashflow: num(fd["operatingCashflow"]),

    dividend_yield: num(sd["dividendYield"]),
    payout_ratio: num(sd["payoutRatio"]),
    beta: num(sd["beta"]),
    short_percent_float: num(ks["shortPercentOfFloat"]),

    analyst_mean: num(fd["recommendationMean"]),
    analyst_count: num(fd["numberOfAnalystOpinions"]),
    target_mean_price: num(fd["targetMeanPrice"]),
    current_price: num(fd["currentPrice"]),
    rec_strong_buy: num(rec["strongBuy"]),
    rec_buy: num(rec["buy"]),
    rec_hold: num(rec["hold"]),
    rec_sell: num(rec["sell"]),
    rec_strong_sell: num(rec["strongSell"]),

    next_earnings_date: isoDate(earningsDates?.[0]),

    source: "yahoo_quote_summary",
    fetched_at: new Date().toISOString(),
  };
}

/** Fetch one symbol's published financials. Returns null when unavailable. */
export async function fetchFundamentals(symbol: string): Promise<Fundamentals | null> {
  const { runWithBreaker } = await import("@/lib/_server/provider-circuit");

  const attempt = async (force: boolean): Promise<Fundamentals | null | "retry"> => {
    const s = await getSession(force);
    if (!s) return null;
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol,
    )}?modules=${MODULES}&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await runWithBreaker("yahoo", () =>
      fetchWithTimeout(
        url,
        { headers: { "User-Agent": UA, ...(s.cookie ? { Cookie: s.cookie } : {}) } },
        8_000,
      ).then(async (r) => {
        if (!r.ok && (r.status >= 500 || r.status === 429)) {
          await r.body?.cancel().catch(() => undefined);
          throw new Error(`Yahoo fundamentals transient ${r.status} for ${symbol}`);
        }
        return r;
      }),
    );
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return force ? null : "retry"; // stale crumb — mint once and try again
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const json = (await res.json()) as {
      quoteSummary?: { result?: Bag[] | null };
    };
    const result = json.quoteSummary?.result?.[0];
    if (!result) return null;
    return parseQuoteSummary(symbol, result);
  };

  try {
    const first = await attempt(false);
    if (first !== "retry") return first;
    const second = await attempt(true);
    return second === "retry" ? null : second;
  } catch {
    return null;
  }
}

/** Reset the cached crumb session — test hook. */
export function __resetYahooFundamentalsSession(): void {
  session = null;
}
