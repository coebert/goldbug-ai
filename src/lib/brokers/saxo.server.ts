// Saxo Bank OpenAPI adapter. Server-only. Cash accounts only, no leverage.
// Uses 24-hour developer access token from SAXO_ACCESS_TOKEN + SAXO_ENV.
// Docs: https://www.developer.saxo/openapi/learn

import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerEnv,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPingResult,
  BrokerPosition,
} from "./adapter";

const BASE = {
  sim: "https://gateway.saxobank.com/sim/openapi",
  live: "https://gateway.saxobank.com/openapi",
} as const;

const ALLOWED_ASSET_TYPES = ["Stock", "Etf", "Etc", "Fund", "Bond"] as const;

async function log(args: {
  portfolioId: string | null;
  userId: string;
  env: BrokerEnv;
  method: string;
  path: string;
  status: number | null;
  request?: unknown;
  response?: unknown;
  error?: string;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: args.portfolioId,
      user_id: args.userId,
      broker: "saxo",
      env: args.env,
      method: args.method,
      path: args.path,
      status: args.status,
      request: (args.request as never) ?? null,
      response: (args.response as never) ?? null,
      error: args.error ?? null,
    });
  } catch (e) {
    console.warn("saxo: failed to write broker log", e);
  }
}

export class SaxoAdapter implements BrokerAdapter {
  readonly name = "saxo";
  readonly env: BrokerEnv;
  private readonly token: string;
  private readonly userId: string;
  private readonly portfolioId: string | null;
  private readonly accountKey: string | undefined;
  private readonly clientKey: string | undefined;
  private resolvedAccountKey: string | undefined;
  // Saxo throttles /trade/v2/orders at roughly 1 req/sec per app. Track the
  // last POST time so back-to-back placeOrder calls space themselves out
  // instead of racing into a 429 storm.
  private lastOrderPostAt = 0;
  // Saxo's /hist/v3/orders endpoint is not enabled on every environment
  // (notably SIM). Once we see a 404 there we stop retrying for the life of
  // this adapter — the reconciler treats "unknown" the same way and we
  // avoid flooding live_broker_log with one row per open order per pass.
  private histUnsupported = false;

  constructor(opts: {
    env: BrokerEnv;
    token: string;
    userId: string;
    portfolioId?: string | null;
    accountKey?: string;
    clientKey?: string;
  }) {
    this.env = opts.env;
    this.token = opts.token;
    this.userId = opts.userId;
    this.portfolioId = opts.portfolioId ?? null;
    this.accountKey = opts.accountKey;
    this.clientKey = opts.clientKey;
  }


  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(BASE[this.env] + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async req<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      // When set, HTTP statuses in this list are treated as expected: the
      // request throws (so the caller can react) but no error row is written
      // to live_broker_log. Used for endpoints where "not found" is a normal
      // outcome (e.g. /hist/v3/orders on environments that don't expose it).
      silentStatuses?: number[];
      // Override the default retry budget. Order placement uses a wider
      // budget because Saxo's /trade/v2/orders is aggressively throttled.
      maxAttempts?: number;
      // Cap for Retry-After honouring, in ms. Defaults to 5s.
      retryCapMs?: number;
    },
  ): Promise<T> {
    const url = this.url(path, opts?.query);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(opts?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    };
    let status: number | null = null;
    let response: unknown = null;
    const maxAttempts = opts?.maxAttempts ?? 3;
    const retryCapMs = opts?.retryCapMs ?? 5000;
    const silentStatuses = new Set(opts?.silentStatuses ?? []);
    try {
      let res: Response | null = null;
      let text = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        res = await fetch(url, init);
        status = res.status;
        text = await res.text();
        response = text ? safeJson(text) : null;
        if (res.status !== 429 || attempt === maxAttempts) break;
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        // Exponential backoff with jitter when Saxo doesn't send Retry-After.
        const backoffMs = Math.min(retryCapMs, 1000 * 2 ** (attempt - 1))
          + Math.floor(Math.random() * 250);
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, retryCapMs)
          : backoffMs;
        await new Promise((r) => setTimeout(r, waitMs));
      }
      if (!res!.ok) {
        const msg = `Saxo ${method} ${path} failed [${res!.status}]: ${text.slice(0, 400)}`;
        if (!silentStatuses.has(res!.status)) {
          await log({
            portfolioId: this.portfolioId, userId: this.userId, env: this.env,
            method, path, status, request: opts?.body ?? opts?.query ?? null, response, error: msg,
          });
        }
        throw new Error(msg);
      }
      await log({
        portfolioId: this.portfolioId, userId: this.userId, env: this.env,
        method, path, status, request: opts?.body ?? opts?.query ?? null, response,
      });
      return response as T;
    } catch (err) {
      if (status == null) {
        await log({
          portfolioId: this.portfolioId, userId: this.userId, env: this.env,
          method, path, status: null, request: opts?.body ?? opts?.query ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }


  async ping(): Promise<BrokerPingResult> {
    const t0 = Date.now();
    try {
      const me = await this.req<{ ClientKey?: string; UserKey?: string; Name?: string }>(
        "GET",
        "/port/v1/users/me",
      );
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        accountId: me.ClientKey ?? me.UserKey,
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async getBalance(): Promise<BrokerBalance> {
    const bal = await this.req<{
      CashBalance?: number;
      TotalValue?: number;
      Currency?: string;
      CashAvailableForTrading?: number;
      SpendingPower?: number;
      TransactionsNotBooked?: number;
      UnrealizedMarginProfitLoss?: number;
      UnrealizedPositionsValue?: number;
      OpenPositionsCount?: number;
      InitialMargin?: { CollateralAvailable?: number };
    }>("GET", "/port/v1/balances/me");
    // Saxo reports several money fields. CashBalance is settled cash only, so a
    // brand-new account with a pending deposit shows 0 there even though the
    // funds are visible in SpendingPower / TotalValue / TransactionsNotBooked.
    // Treat the actual tradable amount as the max of the sources Saxo confirms
    // are usable, so the portfolio's starting pot matches what the user
    // actually deposited (e.g. £100 pending shows as £100, not £0).
    const settled = Number(bal.CashBalance ?? 0);
    const notBooked = Number(bal.TransactionsNotBooked ?? 0);
    const spending = bal.SpendingPower != null ? Number(bal.SpendingPower) : null;
    const total = bal.TotalValue != null ? Number(bal.TotalValue) : null;
    const availTrading =
      bal.CashAvailableForTrading != null ? Number(bal.CashAvailableForTrading) : null;
    // Effective cash = the largest of the fields Saxo tells us we can trade
    // with, so a pending deposit counts even before it settles.
    const cash = Math.max(
      settled,
      settled + notBooked,
      spending ?? 0,
      availTrading ?? 0,
      total ?? 0,
    );
    // Preserve availability semantics for guardrails: what's tradable *right now*.
    const cashAvailable = spending ?? availTrading ?? cash;
    const reservedCash = Math.max(0, cash - cashAvailable);
    return {
      cash,
      totalValue: Number(bal.TotalValue ?? cash),
      currency: bal.Currency ?? "GBP",
      cashAvailable,
      transactionsNotBooked: notBooked,
      reservedCash,
      unrealizedPnl:
        bal.UnrealizedMarginProfitLoss != null
          ? Number(bal.UnrealizedMarginProfitLoss)
          : undefined,
    };

  }

  async getPositions(): Promise<BrokerPosition[]> {
    // Saxo returns a very thin payload unless we opt in to field groups.
    // Without DisplayAndFormat/NetPositionBase/NetPositionView the Symbol,
    // quantity and price fields are all missing, which used to make every
    // real Saxo position silently drop out of our reconciler.
    // Valid NetPositionFieldGroup values per Saxo OpenAPI:
    // DisplayAndFormat, ExchangeInfo, Greeks, NetPositionBase, NetPositionView,
    // SingleFxPosition. "PositionIdentifier" / "InstrumentPriceDetails" belong
    // to /port/v1/positions (per-position endpoint) and Saxo rejects the whole
    // request with HTTP 400 InvalidModelState if we send them here.
    const fieldGroups = [
      "DisplayAndFormat",
      "ExchangeInfo",
      "NetPositionBase",
      "NetPositionView",
    ].join(",");
    const res = await this.req<{
      Data?: Array<{
        NetPositionBase?: {
          Amount?: number;
          AmountLong?: number;
          AmountShort?: number;
          AverageOpenPrice?: number;
          Uic?: number;
          AssetType?: string;
        };
        NetPositionView?: {
          CurrentPrice?: number;
          Exposure?: number;
          ExposureInBaseCurrency?: number;
          MarketValue?: number;
          MarketValueInBaseCurrency?: number;
          MarketValueOpen?: number;
          MarketValueOpenInBaseCurrency?: number;
          AverageOpenPrice?: number;
          AverageOpenPriceIncludingCosts?: number;
          PositionsAverageBuyPrice?: number;
          ProfitLossOnTrade?: number;
          ProfitLossOnTradeInBaseCurrency?: number;
        };
        DisplayAndFormat?: {
          Symbol?: string;
          Currency?: string;
          Description?: string;
        };
        AssetType?: string;
        Uic?: number;
      }>;
    }>("GET", `/port/v1/netpositions/me?FieldGroups=${fieldGroups}`);

    const rows = res.Data ?? [];
    const out: BrokerPosition[] = [];
    for (const p of rows) {
      const base = p.NetPositionBase ?? {};
      const view = p.NetPositionView ?? {};
      const df = p.DisplayAndFormat ?? {};
      const uic = Number(base.Uic ?? p.Uic ?? 0);
      const assetType = String(base.AssetType ?? p.AssetType ?? "Stock");
      let symbol = df.Symbol ?? "";
      let currency = df.Currency ?? "GBP";
      const quantity = firstFiniteNumber(base.Amount, base.AmountLong) ?? 0;
      const absQuantity = Math.abs(quantity);
      const perUnit = (value: number | undefined | null) => {
        if (value == null || absQuantity <= 0) return undefined;
        const n = Math.abs(Number(value));
        return Number.isFinite(n) ? n / absQuantity : undefined;
      };
      const avgPrice = firstPositiveNumber(
        base.AverageOpenPrice,
        view.AverageOpenPrice,
        view.AverageOpenPriceIncludingCosts,
        view.PositionsAverageBuyPrice,
        perUnit(view.MarketValueOpen),
        perUnit(view.MarketValueOpenInBaseCurrency),
      );
      const pnl = firstFiniteNumber(view.ProfitLossOnTrade, view.ProfitLossOnTradeInBaseCurrency) ?? 0;
      const priceFromOpenValue = avgPrice > 0 && absQuantity > 0
        ? Math.max(0, avgPrice + pnl / absQuantity)
        : 0;
      const marketPrice = firstPositiveNumber(
        view.CurrentPrice,
        perUnit(view.Exposure),
        perUnit(view.ExposureInBaseCurrency),
        perUnit(view.MarketValue),
        perUnit(view.MarketValueInBaseCurrency),
        priceFromOpenValue,
        avgPrice,
      );

      // Some Saxo responses still omit Symbol for the aggregated NetPosition
      // row (e.g. certain ETFs). Fall back to the instrument details endpoint
      // so the position isn't dropped by the reconciler.
      if (!symbol && uic > 0) {
        try {
          const det = await this.req<{
            Symbol?: string; CurrencyCode?: string; AssetType?: string;
          }>("GET", `/ref/v1/instruments/details/${uic}/${assetType}`);
          if (det.Symbol) symbol = det.Symbol;
          if (det.CurrencyCode) currency = det.CurrencyCode;
        } catch { /* leave symbol blank; row will be filtered upstream */ }
      }

      out.push({
        symbol,
        quantity,
        avgPrice,
        marketPrice,
        currency,
        assetType,
      });
    }
    return out;
  }

  async lookupUic(symbol: string): Promise<{
    uic: number; assetType: string; currency: string; exchangeId?: string; tickSize?: number;
  }> {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cached = await supabaseAdmin
      .from("saxo_instrument_cache")
      .select("uic, asset_type, currency, exchange_id, tick_size, refreshed_at")
      .eq("symbol", symbol).eq("env", this.env).maybeSingle();
    if (cached.data) {
      const age = Date.now() - new Date(cached.data.refreshed_at as string).getTime();
      if (age < 86_400_000) {
        return {
          uic: Number(cached.data.uic),
          assetType: String(cached.data.asset_type),
          currency: String(cached.data.currency ?? "GBP"),
          exchangeId: cached.data.exchange_id ?? undefined,
          tickSize: cached.data.tick_size ? Number(cached.data.tick_size) : undefined,
        };
      }
    }

    const { upper, base, suffix, preferredExchanges, searchKeywords } =
      normalizeSaxoSymbol(symbol);

    type InstrumentHit = SaxoInstrumentHit;
    const attempts: Array<{ keyword: string; count: number }> = [];
    let candidates: InstrumentHit[] = [];
    for (const searchKeyword of searchKeywords) {
      const search = await this.req<{ Data?: InstrumentHit[] }>("GET", "/ref/v1/instruments", {
        query: { Keywords: searchKeyword, AssetTypes: ALLOWED_ASSET_TYPES.join(",") },
      });
      const hits = search.Data ?? [];
      attempts.push({ keyword: searchKeyword, count: hits.length });
      if (hits.length > 0) {
        candidates = hits;
        break;
      }
    }

    const hit = selectSaxoInstrument(symbol, candidates);


    if (!hit) {
      try {
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: this.portfolioId,
          user_id: this.userId,
          broker: "saxo",
          env: this.env,
          method: "INSTRUMENT_LOOKUP_EMPTY",
          path: "/ref/v1/instruments",
          status: 404,
          request: { symbol, normalized: { upper, base, suffix, preferredExchanges }, attempts } as never,
          response: null,
          error: `Saxo instrument not found for symbol ${symbol}`,
        });
      } catch {
        // best-effort diagnostic only
      }
      throw new Error(`Saxo instrument not found for symbol ${symbol}`);
    }
    if (!(ALLOWED_ASSET_TYPES as readonly string[]).includes(hit.AssetType)) {
      throw new Error(`Saxo asset type ${hit.AssetType} not permitted (cash-only, no leverage)`);
    }
    await supabaseAdmin.from("saxo_instrument_cache").upsert({
      symbol, env: this.env, uic: hit.Identifier, asset_type: hit.AssetType,
      currency: hit.CurrencyCode ?? null, exchange_id: hit.ExchangeId ?? null,
      raw: hit as never, refreshed_at: new Date().toISOString(),
    });
    return {
      uic: hit.Identifier, assetType: hit.AssetType,
      currency: hit.CurrencyCode ?? "GBP", exchangeId: hit.ExchangeId,
    };
  }


  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const inst = await this.lookupUic(req.symbol);
    const accountKey = await this.getDefaultAccountKey();
    const body: Record<string, unknown> = {
      Uic: inst.uic,
      AssetType: inst.assetType,
      BuySell: req.side === "buy" ? "Buy" : "Sell",
      Amount: req.quantity,
      AmountType: "Quantity",
      OrderType: req.orderType === "limit" ? "Limit" : "Market",
      OrderDuration: { DurationType: "DayOrder" },
      ExternalReference: req.clientOrderId,
      // Saxo requires this on every order since 2024: "true" marks the order
      // as manually initiated by a human. We surface manual + cron runs the
      // same way — the AI decides, but a real person configured the guardrails,
      // so from the exchange's perspective this is a manual (non-algorithmic)
      // order flow, not high-frequency automated trading.
      ManualOrder: true,
    };

    if (accountKey) body.AccountKey = accountKey;
    if (req.orderType === "limit" && req.limitPrice != null) body.OrderPrice = req.limitPrice;

    try {
      const res = await this.req<{ OrderId?: string; ErrorInfo?: { Message?: string } }>(
        "POST", "/trade/v2/orders", { body },
      );
      if (res.ErrorInfo) {
        return { brokerOrderId: "", status: "rejected", reason: res.ErrorInfo.Message ?? "unknown", raw: res };
      }
      return { brokerOrderId: res.OrderId ?? "", status: "submitted", raw: res };
    } catch (e) {
      return { brokerOrderId: "", status: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * List currently working (open) orders on the account. Saxo returns filled /
   * cancelled orders here only briefly; anything not present in this list has
   * moved to history.
   */
  async listWorkingOrders(): Promise<
    Array<{
      brokerOrderId: string;
      symbol: string;
      status: string;
      amount: number;
      filledAmount: number;
    }>
  > {
    const res = await this.req<{
      Data?: Array<{
        OrderId?: string;
        Status?: string;
        Amount?: number;
        FilledAmount?: number;
        DisplayAndFormat?: { Symbol?: string };
      }>;
    }>("GET", "/port/v1/orders/me", { query: { FieldGroups: "DisplayAndFormat" } });
    return (res.Data ?? []).map((o) => ({
      brokerOrderId: String(o.OrderId ?? ""),
      symbol: o.DisplayAndFormat?.Symbol ?? "",
      status: String(o.Status ?? "Working"),
      amount: Number(o.Amount ?? 0),
      filledAmount: Number(o.FilledAmount ?? 0),
    })).filter((o) => o.brokerOrderId);
  }

  /**
   * Look up a single historical (closed) order by id. Returns null if Saxo
   * cannot find it in the given lookback window — some environments don't
   * expose the hist endpoint, so the caller must treat null as "unknown".
   */
  async getHistoricalOrder(
    brokerOrderId: string,
    sinceIso: string,
  ): Promise<
    | {
        brokerOrderId: string;
        status: string;
        amount: number;
        filledAmount: number;
        avgPrice: number | null;
        filledAt: string | null;
        reason?: string;
      }
    | null
  > {
    const clientKey = await this.getClientKey();
    if (!clientKey) return null;
    try {
      const res = await this.req<{
        Data?: Array<{
          OrderId?: string;
          Status?: string;
          Amount?: number;
          FilledAmount?: number;
          AverageOpenPrice?: number;
          Price?: number;
          ExecutionTimeClose?: string;
          LastFilledTime?: string;
          ErrorText?: string;
        }>;
      }>("GET", `/hist/v3/orders/${encodeURIComponent(clientKey)}`, {
        query: { FromDateTime: sinceIso },
      });
      const hit = (res.Data ?? []).find((o) => String(o.OrderId ?? "") === brokerOrderId);
      if (!hit) return null;
      return {
        brokerOrderId,
        status: String(hit.Status ?? "Unknown"),
        amount: Number(hit.Amount ?? 0),
        filledAmount: Number(hit.FilledAmount ?? 0),
        avgPrice:
          hit.AverageOpenPrice != null
            ? Number(hit.AverageOpenPrice)
            : hit.Price != null
              ? Number(hit.Price)
              : null,
        filledAt: hit.ExecutionTimeClose ?? hit.LastFilledTime ?? null,
        reason: hit.ErrorText ?? undefined,
      };
    } catch {
      // /hist endpoint is not universally enabled — treat as "unknown"
      return null;
    }
  }

  private cachedClientKey: string | undefined;
  private async getClientKey(): Promise<string | undefined> {
    if (this.cachedClientKey) return this.cachedClientKey;
    // Prefer discovering ClientKey from the live session — SAXO_CLIENT_KEY
    // env var historically held an AccountKey by mistake, which caused
    // /hist/v3/orders/{key} lookups to 404 and left successful orders
    // stuck on "submitted" because reconciliation could not resolve them.
    try {
      const me = await this.req<{ ClientKey?: string }>("GET", "/port/v1/users/me");
      if (me.ClientKey) {
        this.cachedClientKey = me.ClientKey;
        return this.cachedClientKey;
      }
    } catch {
      // fall through to env fallback
    }
    if (this.clientKey) {
      this.cachedClientKey = this.clientKey;
      return this.cachedClientKey;
    }
    return undefined;
  }

  async cancelOrder(brokerOrderId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.req("DELETE", `/trade/v2/orders/${encodeURIComponent(brokerOrderId)}`, {
        query: this.accountKey ? { AccountKey: this.accountKey } : undefined,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async getDefaultAccountKey(): Promise<string | undefined> {
    if (this.resolvedAccountKey) return this.resolvedAccountKey;
    try {
      const res = await this.req<{
        Data?: Array<{
          AccountKey?: string;
          Active?: boolean;
          Currency?: string;
          LegalAssetTypes?: string[];
        }>;
      }>("GET", "/port/v1/accounts/me");
      const accounts = res.Data ?? [];
      const configured = this.accountKey
        ? accounts.find((a) => a.AccountKey === this.accountKey && a.Active !== false)
        : undefined;
      const tradable = accounts.find(
        (a) => a.Active !== false && a.AccountKey && a.LegalAssetTypes?.some((t) => t === "Stock" || t === "Etf"),
      ) ?? accounts.find((a) => a.Active !== false && a.AccountKey) ?? accounts.find((a) => a.AccountKey);
      this.resolvedAccountKey = configured?.AccountKey ?? tradable?.AccountKey;
      if (this.accountKey && !configured) {
        await log({
          portfolioId: this.portfolioId,
          userId: this.userId,
          env: this.env,
          method: "ACCOUNT_KEY_DISCOVERED",
          path: "/port/v1/accounts/me",
          status: 200,
          request: { configuredProvided: true } as never,
          response: { selected: !!this.resolvedAccountKey, accountCount: accounts.length } as never,
          error: "Configured SAXO_ACCOUNT_KEY did not match this broker environment; using discovered active account.",
        });
      }
      return this.resolvedAccountKey;
    } catch (e) {
      await log({
        portfolioId: this.portfolioId,
        userId: this.userId,
        env: this.env,
        method: "ACCOUNT_LOOKUP_SKIPPED",
        path: "/port/v1/accounts/me",
        status: null,
        error: e instanceof Error ? e.message : String(e),
      });
      this.resolvedAccountKey = this.accountKey;
      return this.resolvedAccountKey;
    }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

function firstFiniteNumber(...values: Array<number | undefined | null>): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstPositiveNumber(...values: Array<number | undefined | null>): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export async function buildSaxoAdapter(opts: {
  userId: string; portfolioId?: string | null; envOverride?: BrokerEnv;
}): Promise<SaxoAdapter> {
  const env = (opts.envOverride ?? (process.env.SAXO_ENV as BrokerEnv) ?? "sim");
  if (env !== "sim" && env !== "live") throw new Error(`Invalid SAXO_ENV=${env}`);
  const { getAccessToken } = await import("./saxo-oauth.server");
  const token = await getAccessToken(env);
  return new SaxoAdapter({
    env, token, userId: opts.userId, portfolioId: opts.portfolioId ?? null,
    accountKey: process.env.SAXO_ACCOUNT_KEY, clientKey: process.env.SAXO_CLIENT_KEY,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers for Yahoo → Saxo symbol resolution. Exported for unit tests.
// ---------------------------------------------------------------------------

export type SaxoInstrumentHit = {
  Identifier: number;
  AssetType: string;
  CurrencyCode?: string;
  ExchangeId?: string;
  Symbol: string;
  Description?: string;
};

// Yahoo Finance suffix → preferred Saxo ExchangeId(s), in priority order.
export const YAHOO_SUFFIX_TO_EXCHANGE: Record<string, string[]> = {
  L: ["LSE", "LSE_INTL", "LSE_ETF", "LSE_SETSMM"],
  DE: ["XETR", "FRA"],
  PA: ["PAR"],
  AS: ["AMS"],
  MI: ["MIL"],
  MC: ["MCE"],
  SW: ["SWX", "VIRT_X"],
  TO: ["TSE"],
  HK: ["HKEX"],
  T: ["TSE_JP"],
  AX: ["ASX"],
  ST: ["OMX"],
  CO: ["CSE"],
  HE: ["HEX"],
  OL: ["OSE"],
};

/**
 * Normalize a Yahoo-style ticker (VUKE.L, SAP.DE) into the pieces the Saxo
 * instrument search needs: bare keyword, base ticker, suffix, preferred
 * exchange list, and the ordered fallback keyword list to try.
 *
 * Saxo's /ref/v1/instruments does NOT understand Yahoo suffixes: "VUKE.L"
 * returns zero hits while "VUKE" returns the LSE-listed ETF we want.
 */
export function normalizeSaxoSymbol(symbol: string): {
  upper: string;
  base: string;
  suffix: string;
  preferredExchanges: string[];
  keyword: string;
  searchKeywords: string[];
} {
  const upper = symbol.toUpperCase();
  const dotIdx = upper.lastIndexOf(".");
  const suffix = dotIdx > 0 ? upper.slice(dotIdx + 1) : "";
  const base = dotIdx > 0 ? upper.slice(0, dotIdx) : upper;
  const preferredExchanges = suffix ? YAHOO_SUFFIX_TO_EXCHANGE[suffix] ?? [] : [];
  const keyword = suffix && preferredExchanges.length ? base : upper;
  const searchKeywords = Array.from(new Set([keyword, base, upper].filter(Boolean)));
  return { upper, base, suffix, preferredExchanges, keyword, searchKeywords };
}

/**
 * Pick the best Saxo instrument hit for a Yahoo-style symbol.
 *
 * Match priority:
 *   1. Exact Symbol on a preferred exchange for the Yahoo suffix
 *   2. Symbol starts with base ticker on a preferred exchange (Saxo often
 *      appends ":xlon" style)
 *   3. Any hit on a preferred exchange
 *   4. Exact Symbol match (any exchange)
 *   5. Any symMatches hit
 *   6. First hit
 *
 * Returns undefined when the candidate list is empty.
 */
export function selectSaxoInstrument(
  symbol: string,
  candidates: SaxoInstrumentHit[],
): SaxoInstrumentHit | undefined {
  if (!candidates.length) return undefined;
  const { upper, base, preferredExchanges } = normalizeSaxoSymbol(symbol);

  const symMatches = (s: string) => {
    const su = s.toUpperCase();
    return su === base || su.startsWith(`${base}:`) || su === upper;
  };
  const onPreferred = (ex?: string) =>
    !!ex && preferredExchanges.some((e) => ex.toUpperCase().includes(e));

  return (
    candidates.find((d) => symMatches(d.Symbol) && onPreferred(d.ExchangeId)) ??
    candidates.find((d) => d.Symbol.toUpperCase().startsWith(base) && onPreferred(d.ExchangeId)) ??
    (preferredExchanges.length ? candidates.find((d) => onPreferred(d.ExchangeId)) : undefined) ??
    candidates.find((d) => d.Symbol.toUpperCase() === upper) ??
    candidates.find((d) => symMatches(d.Symbol)) ??
    candidates[0]
  );
}

