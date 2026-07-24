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
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown },
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
    try {
      const res = await fetch(url, init);
      status = res.status;
      const text = await res.text();
      response = text ? safeJson(text) : null;
      if (!res.ok) {
        const msg = `Saxo ${method} ${path} failed [${res.status}]: ${text.slice(0, 400)}`;
        await log({
          portfolioId: this.portfolioId, userId: this.userId, env: this.env,
          method, path, status, request: opts?.body ?? opts?.query ?? null, response, error: msg,
        });
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
    const res = await this.req<{
      Data?: Array<{
        NetPositionBase?: { Amount?: number; AverageOpenPrice?: number };
        NetPositionView?: { CurrentPrice?: number };
        DisplayAndFormat?: { Symbol?: string; Currency?: string };
        AssetType?: string;
      }>;
    }>("GET", "/port/v1/netpositions/me");
    return (res.Data ?? []).map((p) => ({
      symbol: p.DisplayAndFormat?.Symbol ?? "",
      quantity: Number(p.NetPositionBase?.Amount ?? 0),
      avgPrice: Number(p.NetPositionBase?.AverageOpenPrice ?? 0),
      marketPrice: Number(p.NetPositionView?.CurrentPrice ?? 0),
      currency: p.DisplayAndFormat?.Currency ?? "GBP",
      assetType: p.AssetType ?? "Stock",
    }));
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

    // Normalize Yahoo-style suffixes (e.g. VUKE.L, SAP.DE) into a bare keyword
    // plus a preferred Saxo ExchangeId. Saxo's /ref/v1/instruments search does
    // NOT recognise Yahoo suffixes, so "VUKE.L" returns zero hits while "VUKE"
    // returns the LSE-listed ETF we actually want.
    const YAHOO_SUFFIX_TO_EXCHANGE: Record<string, string[]> = {
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
    const upper = symbol.toUpperCase();
    const dotIdx = upper.lastIndexOf(".");
    const suffix = dotIdx > 0 ? upper.slice(dotIdx + 1) : "";
    const base = dotIdx > 0 ? upper.slice(0, dotIdx) : upper;
    const preferredExchanges = suffix ? YAHOO_SUFFIX_TO_EXCHANGE[suffix] ?? [] : [];
    const keyword = suffix && preferredExchanges.length ? base : upper;

    const search = await this.req<{
      Data?: Array<{
        Identifier: number; AssetType: string; CurrencyCode?: string;
        ExchangeId?: string; Symbol: string;
      }>;
    }>("GET", "/ref/v1/instruments", {
      query: { Keywords: keyword, AssetTypes: ALLOWED_ASSET_TYPES.join(",") },
    });
    const candidates = search.Data ?? [];

    // Match order:
    //   1. Exact Symbol on a preferred exchange for the Yahoo suffix
    //   2. Symbol starts with base ticker on a preferred exchange (Saxo often
    //      appends ":xlon" style)
    //   3. Any hit on a preferred exchange
    //   4. Exact Symbol match (any exchange)
    //   5. First hit
    const symMatches = (s: string) => {
      const su = s.toUpperCase();
      return su === base || su.startsWith(`${base}:`) || su === upper;
    };
    const onPreferred = (ex?: string) =>
      !!ex && preferredExchanges.some((e) => ex.toUpperCase().includes(e));

    const hit =
      candidates.find((d) => symMatches(d.Symbol) && onPreferred(d.ExchangeId)) ??
      candidates.find((d) => d.Symbol.toUpperCase().startsWith(base) && onPreferred(d.ExchangeId)) ??
      (preferredExchanges.length ? candidates.find((d) => onPreferred(d.ExchangeId)) : undefined) ??
      candidates.find((d) => d.Symbol.toUpperCase() === upper) ??
      candidates.find((d) => symMatches(d.Symbol)) ??
      candidates[0];

    if (!hit) throw new Error(`Saxo instrument not found for symbol ${symbol}`);
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
    const body: Record<string, unknown> = {
      Uic: inst.uic,
      AssetType: inst.assetType,
      BuySell: req.side === "buy" ? "Buy" : "Sell",
      Amount: req.quantity,
      AmountType: "Quantity",
      OrderType: req.orderType === "limit" ? "Limit" : "Market",
      OrderDuration: { DurationType: "DayOrder" },
      ExternalReference: req.clientOrderId,
    };
    if (this.accountKey) body.AccountKey = this.accountKey;
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
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
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
