// Saxo Bank OpenAPI adapter. Server-only. Cash accounts only, no leverage.
// Uses 24-hour developer access token from SAXO_ACCESS_TOKEN + SAXO_ENV.
// Docs: https://www.developer.saxo/openapi/learn

import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerChargeReport,

  BrokerEnv,
  BrokerFxSpotRequest,
  BrokerFxSpotResult,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPingResult,
  BrokerPosition,
} from "./adapter";
import { asJson } from "@/lib/_server/db-json";
import {
  resolveSaxoAccountKey,
  shouldReportAccountKeyIssue,
  type SaxoAccountKeyResolution,
  type SaxoAccountSummary,
} from "./saxo-account-key";
import { redactedError } from "@/lib/_server/redact";
import { nativeQuotePrice } from "@/lib/market-price-units";
import {
  roundPriceToTick,
  tickSizeForPrice,
  type SaxoTickSizeScheme,
} from "@/lib/broker-tick-size";

import type { ZodTypeAny } from "zod";
import {
  parseSaxo,
  SaxoAccountsSchema,
  SaxoBalanceSchema,
  SaxoInstrumentDetailsSchema,
  SaxoNetPositionsSchema,
  SaxoPlaceOrderSchema,
  SaxoUserSchema,
  SaxoWorkingOrdersSchema,
} from "./saxo-schemas";

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
      request: args.request == null ? null : asJson(args.request),
      response: args.response == null ? null : asJson(args.response),
      error: args.error ?? null,
    });
  } catch (e) {
    console.warn("saxo: failed to write broker log", e);
  }
}

// Saxo rejects the whole order when ExternalReference exceeds 50 characters.
// Clamp defensively here so a long caller-supplied idempotency key degrades
// to a truncated reference instead of an InvalidModelState rejection.
function externalReference(clientOrderId: string): string {
  const s = String(clientOrderId ?? "");
  return s.length <= 50 ? s : s.slice(0, 50);
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
  private accountKeyResolution: SaxoAccountKeyResolution | undefined;
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
      // Zod schema validating the response body at the broker boundary.
      // Mismatches are logged, never thrown (see `parseSaxo`).
      schema?: ZodTypeAny;
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
    let retries429 = 0;
    const { bumpSaxo } = await import("@/lib/run-metrics.server");
    try {
      let res: Response | null = null;
      let text = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        res = await fetch(url, init);
        status = res.status;
        text = await res.text();
        response = text ? safeJson(text) : null;
        if (res.status !== 429 || attempt === maxAttempts) break;
        retries429 += 1;
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
        // Redact the provider body before it reaches the broker log table:
        // Saxo echoes request payloads (and occasionally credentials) back.
        const msg = `Saxo ${method} ${path} failed [${res!.status}]: ${redactedError(text.slice(0, 400)).message}`;
        if (!silentStatuses.has(res!.status)) {
          await log({
            portfolioId: this.portfolioId, userId: this.userId, env: this.env,
            method, path, status, request: opts?.body ?? opts?.query ?? null, response, error: msg,
          });
        }
        bumpSaxo("error", retries429);
        throw new Error(msg);
      }
      await log({
        portfolioId: this.portfolioId, userId: this.userId, env: this.env,
        method, path, status, request: opts?.body ?? opts?.query ?? null, response,
      });
      bumpSaxo("ok", retries429);
      if (opts?.schema) return parseSaxo(opts.schema, response, { method, path }) as T;
      return response as T;
    } catch (err) {
      if (status == null) {
        await log({
          portfolioId: this.portfolioId, userId: this.userId, env: this.env,
          method, path, status: null, request: opts?.body ?? opts?.query ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        bumpSaxo("error", retries429);
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
        { schema: SaxoUserSchema },
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
    type SaxoBalance = {
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
    };

    // Balance scoping: match what the user sees in the Saxo app for THEIR
    // trading account, not an aggregate that folds in unrelated sub-accounts
    // (a separate cash wallet, a legacy ISA, a joint account). Preference is:
    //   1. AccountKey-scoped   — matches the specific tradable account this
    //      integration was configured for (SAXO_ACCOUNT_KEY or the account
    //      we auto-discovered via /port/v1/accounts/me).
    //   2. ClientKey-aggregate — catches deposits landing in any sub-account
    //      when we can't resolve a specific AccountKey.
    //   3. /balances/me        — final fallback (caller's default context).
    // Without step 1 an aggregated cash figure over-reports vs the Saxo app
    // and pre-trade affordability rejects orders the user *thinks* they can
    // afford from the balance they see.
    let bal: SaxoBalance | null = null;
    let source: "account" | "client" | "me" = "me";
    let clientLookupError: string | null = null;
    try {
      const ak = await this.getDefaultAccountKey();
      if (ak) {
        // Saxo rejects an AccountKey-scoped balance read unless ClientKey is
        // sent alongside it ("The ClientKey field is required"), which used to
        // 400 on every tick and silently fall back to the client aggregate.
        const ckForAccount = await this.getClientKey().catch(() => null);
        bal = await this.req<SaxoBalance>("GET", "/port/v1/balances", {
          query: ckForAccount
            ? { AccountKey: ak, ClientKey: ckForAccount }
            : { AccountKey: ak },
          schema: SaxoBalanceSchema,
        });
        source = "account";
      }
    } catch (e) {
      clientLookupError = `account-scope: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (bal == null) {
      try {
        const ck = await this.getClientKey();
        if (ck) {
          bal = await this.req<SaxoBalance>("GET", "/port/v1/balances", {
            query: { ClientKey: ck },
            schema: SaxoBalanceSchema,
          });
          source = "client";
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        clientLookupError = clientLookupError ? `${clientLookupError}; client-scope: ${msg}` : `client-scope: ${msg}`;
      }
    }
    if (bal == null) {
      bal = await this.req<SaxoBalance>("GET", "/port/v1/balances/me", { schema: SaxoBalanceSchema });
      source = "me";
    }

    // Saxo's app-visible cash is CashBalance adjusted by TransactionsNotBooked.
    // A negative TransactionsNotBooked means recent buys have executed but have
    // not settled/booked yet; showing raw CashBalance makes Aegis report too
    // much cash and too little invested value. A positive value captures a
    // pending deposit before settlement.
    //
    // SpendingPower is intentionally NOT used as cash: it can include margin /
    // collateral effects and would inflate the cash tile. Keep it only for
    // pre-trade guardrails via `cashAvailable` / `spendingPower`.
    //
    // IMPORTANT: do NOT fold `TotalValue` into the cash figure — TotalValue is
    // cash + open positions valued at market, so including it double-counts
    // holdings once the account owns anything and inflates the reported cash.
    const settledRaw = bal.CashBalance == null ? null : Number(bal.CashBalance);
    const settled = Number.isFinite(settledRaw) ? settledRaw : null;
    const notBookedRaw = bal.TransactionsNotBooked == null
      ? null
      : Number(bal.TransactionsNotBooked);
    const notBooked = Number.isFinite(notBookedRaw) ? notBookedRaw : null;
    const spending = bal.SpendingPower != null ? Number(bal.SpendingPower) : null;
    const availTrading =
      bal.CashAvailableForTrading != null ? Number(bal.CashAvailableForTrading) : null;
    const cash = settled != null
      ? settled + (notBooked ?? 0)
      : (availTrading ?? spending ?? 0);
    // Preserve availability semantics for guardrails: what's tradable *right now*.
    const cashAvailable = spending ?? availTrading ?? cash;
    const reservedCash = Math.max(0, cash - cashAvailable);

    // Structured log so the trade-error dashboard shows which balance endpoint
    // we used and what raw figures Saxo returned — makes deposit-not-detected
    // reports diagnosable without server access.
    await log({
      portfolioId: this.portfolioId,
      userId: this.userId,
      env: this.env,
      method: "BALANCE_FETCH",
      path: source === "account"
        ? "/port/v1/balances?AccountKey"
        : source === "client"
          ? "/port/v1/balances?ClientKey"
          : "/port/v1/balances/me",
      status: 200,
      request: asJson({ source, clientLookupError }),
      response: asJson({
        cash, cashAvailable, notBooked: notBooked ?? null,
        settled: settled ?? null, spending, availTrading,
        totalValue: bal.TotalValue ?? null,
        currency: bal.Currency ?? null,
      }),
      error: undefined,
    });

    return {
      cash,
      totalValue: Number(bal.TotalValue ?? cash),
      currency: bal.Currency ?? "GBP",
      cashAvailable,
      spendingPower: spending ?? undefined,
      transactionsNotBooked: notBooked ?? undefined,
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
    }>("GET", `/port/v1/netpositions/me?FieldGroups=${fieldGroups}`, { schema: SaxoNetPositionsSchema });

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
          }>("GET", `/ref/v1/instruments/details/${uic}/${assetType}`, { schema: SaxoInstrumentDetailsSchema });
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

  // In-flight drift-retry lookups deduped per (env, symbol) so parallel
  // callers hitting the same drift don't stampede the Saxo /ref/v1 search.
  private static readonly driftRetryInFlight = new Map<string, Promise<unknown>>();

  async lookupUic(
    symbol: string,
    opts?: { forceRefresh?: boolean; skipDriftRetry?: boolean },
  ): Promise<{
    uic: number; assetType: string; currency: string; exchangeId?: string; tickSize?: number;
  }> {
    // Yahoo-style pseudo-tickers Saxo will never resolve: FX pairs
    // ("GBPEUR=X"), indices ("^FTSE"), futures ("=F"). Fail fast with a
    // clear reason instead of firing three fruitless instrument searches
    // and writing a misleading "instrument not found" row per attempt.
    if (/[=^]/.test(symbol) || symbol.endsWith("=X") || symbol.endsWith("=F")) {
      throw new Error(
        `Saxo cannot trade pseudo-symbol ${symbol} (FX/index/futures ticker not routable to a cash-equity instrument)`,
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (!opts?.forceRefresh) {
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
          request: asJson({ symbol, normalized: { upper, base, suffix, preferredExchanges }, attempts }),
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
      raw: asJson(hit), refreshed_at: new Date().toISOString(),
    });
    // Whenever a cache row for an approved crypto ETP changes, verify the
    // crypto universe is still fully covered / correctly typed / fresh.
    // Drift is logged (not thrown) so a single symbol refresh never
    // blocks order placement — the tick loop already fails-closed on a
    // missing / wrong / stale row via `crypto-validation.server.ts`.
    try {
      const { isApprovedCryptoEtp, validateCryptoCacheSync } = await import(
        "@/lib/crypto-cache-sync"
      );
      if (isApprovedCryptoEtp(symbol)) {
        const snap = await supabaseAdmin
          .from("saxo_instrument_cache")
          .select("symbol, env, asset_type, refreshed_at")
          .eq("env", this.env);
        const report = validateCryptoCacheSync({
          env: this.env,
          cacheRows: (snap.data ?? []) as Array<{
            symbol: string; env: string; asset_type: string | null; refreshed_at: string | null;
          }>,
        });
        if (!report.ok) {
          await log({
            portfolioId: this.portfolioId,
            userId: this.userId,
            env: this.env,
            method: "CRYPTO_CACHE_SYNC_WARN",
            path: "/saxo_instrument_cache",
            status: 200,
            request: { triggeredBy: symbol },
            response: report,
            error: report.summary,
          });

          // Auto-heal drift by re-fetching the drifted approved ETPs from
          // Saxo. Only runs on the *initial* lookup (skipDriftRetry gates
          // recursion) and dedupes concurrent retries per (env, symbol) via
          // the static in-flight map so parallel cache refreshes don't
          // stampede /ref/v1/instruments.
          if (!opts?.skipDriftRetry) {
            const drifted = new Set<string>([
              ...report.drift.missing,
              ...report.drift.stale.map((s) => s.symbol),
              ...report.drift.wrongAssetType.map((w) => w.symbol),
            ]);
            drifted.delete(symbol); // just refreshed
            const retryTargets = [...drifted];
            const retryResults: Array<{
              symbol: string; ok: boolean; error?: string;
            }> = [];
            await Promise.all(
              retryTargets.map(async (sym) => {
                const key = `${this.env}::${sym}`;
                const inflight = SaxoAdapter.driftRetryInFlight.get(key);
                if (inflight) {
                  try { await inflight; retryResults.push({ symbol: sym, ok: true }); }
                  catch (e) { retryResults.push({ symbol: sym, ok: false, error: (e as Error).message }); }
                  return;
                }
                const p = this.lookupUic(sym, { forceRefresh: true, skipDriftRetry: true });
                SaxoAdapter.driftRetryInFlight.set(key, p);
                try {
                  await p;
                  retryResults.push({ symbol: sym, ok: true });
                } catch (e) {
                  retryResults.push({ symbol: sym, ok: false, error: (e as Error).message });
                } finally {
                  SaxoAdapter.driftRetryInFlight.delete(key);
                }
              }),
            );

            // Re-validate and log the outcome so the audit trail shows
            // whether the auto-heal actually cleared the drift.
            const postSnap = await supabaseAdmin
              .from("saxo_instrument_cache")
              .select("symbol, env, asset_type, refreshed_at")
              .eq("env", this.env);
            const postReport = validateCryptoCacheSync({
              env: this.env,
              cacheRows: (postSnap.data ?? []) as Array<{
                symbol: string; env: string; asset_type: string | null; refreshed_at: string | null;
              }>,
            });
            await log({
              portfolioId: this.portfolioId,
              userId: this.userId,
              env: this.env,
              method: postReport.ok
                ? "CRYPTO_CACHE_DRIFT_RETRY_OK"
                : "CRYPTO_CACHE_DRIFT_RETRY_PARTIAL",
              path: "/saxo_instrument_cache",
              status: 200,
              request: { triggeredBy: symbol, targets: retryTargets },
              response: { retryResults, postReport },
              error: postReport.ok ? undefined : postReport.summary,
            });
          }
        }
      }
    } catch {
      // Sync check + retry are best-effort — never let them prevent a valid order.
    }

    return {
      uic: hit.Identifier, assetType: hit.AssetType,
      currency: hit.CurrencyCode ?? "GBP", exchangeId: hit.ExchangeId,
    };
  }

  /**
   * Instrument tick-size scheme, memoised per adapter instance. Best-effort:
   * a failed lookup falls back to the LSE pence ladder rather than blocking
   * the order.
   */
  private tickSchemeCache = new Map<string, SaxoTickSizeScheme | null>();

  private async fetchTickScheme(
    uic: number,
    assetType: string,
  ): Promise<SaxoTickSizeScheme | null> {
    const key = `${uic}:${assetType}`;
    const cached = this.tickSchemeCache.get(key);
    if (cached !== undefined) return cached;
    let scheme: SaxoTickSizeScheme | null = null;
    try {
      const det = await this.req<{
        TickSizeScheme?: SaxoTickSizeScheme;
        TickSize?: number;
      }>("GET", `/ref/v1/instruments/details/${uic}/${assetType}`);
      scheme =
        det.TickSizeScheme ??
        (Number.isFinite(det.TickSize) ? { DefaultTickSize: det.TickSize } : null);
    } catch {
      scheme = null;
    }
    this.tickSchemeCache.set(key, scheme);
    return scheme;
  }


  /**
   * Dry-run an order against Saxo's precheck endpoint WITHOUT placing it.
   * Used by the "re-check blocks" flow to test whether an account-level
   * refusal (suitability / permission / tradability) still applies.
   */
  async precheckSymbol(
    symbol: string,
    opts?: { quantity?: number; side?: "buy" | "sell" },
  ): Promise<{
    ok: boolean;
    errorCode: string | null;
    message: string | null;
    preCheckResult: string | null;
    estimatedMessages: string[];
  }> {
    const inst = await this.lookupUic(symbol);
    const accountKey = await this.getDefaultAccountKey();
    const body: Record<string, unknown> = {
      Uic: inst.uic,
      AssetType: inst.assetType,
      BuySell: opts?.side === "sell" ? "Sell" : "Buy",
      Amount: Math.max(1, Math.round(opts?.quantity ?? 1)),
      AmountType: "Quantity",
      OrderType: "Market",
      OrderDuration: { DurationType: "DayOrder" },
      ManualOrder: true,
    };
    if (accountKey) body.AccountKey = accountKey;

    const pre = await this.req<{
      PreCheckResult?: string;
      ErrorInfo?: { ErrorCode?: string; Message?: string };
      PreCheckDetails?: Array<{ ErrorCode?: string; Message?: string }>;
      EstimatedCashRequired?: number;
    }>("POST", "/trade/v2/orders/precheck", { body, maxAttempts: 2 });

    const outcome = String(pre.PreCheckResult ?? "").toLowerCase();
    const errorCode = pre.ErrorInfo?.ErrorCode ?? null;
    const message = pre.ErrorInfo?.Message ?? null;
    const ok = !errorCode && (!outcome || outcome === "ok");
    // Saxo returns per-check detail rows alongside the top-level ErrorInfo.
    // Surface them verbatim so the user sees exactly what the broker objected
    // to (e.g. "Appropriateness test for Leveraged ETFs not passed").
    const estimatedMessages = (pre.PreCheckDetails ?? [])
      .map((d) => [d.ErrorCode, d.Message].filter(Boolean).join(": "))
      .filter((t) => t.length > 0);
    return {
      ok,
      errorCode,
      message,
      preCheckResult: pre.PreCheckResult ?? null,
      estimatedMessages,
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
      OrderType:
        req.orderType === "limit"
          ? "Limit"
          : req.orderType === "stop"
            ? "StopIfTraded"
            : "Market",
      OrderDuration: {
        DurationType: req.duration === "gtc" ? "GoodTillCancel" : "DayOrder",
      },
      ExternalReference: externalReference(req.clientOrderId),
      // Saxo requires this on every order since 2024: "true" marks the order
      // as manually initiated by a human. We surface manual + cron runs the
      // same way — the AI decides, but a real person configured the guardrails,
      // so from the exchange's perspective this is a manual (non-algorithmic)
      // order flow, not high-frequency automated trading.
      ManualOrder: true,
    };

    if (accountKey) body.AccountKey = accountKey;
    // Prices upstream are normalised into the portfolio's base currency
    // (GBP). Saxo expects the instrument's NATIVE quote units — pence for
    // LSE common stocks — so a GBP-scaled limit or stop is ~100x below the
    // market and the venue rejects it with "Price exceeds aggressive
    // tolerance". Convert back, then round to the 2dp Saxo accepts.
    //
    // Two independent signals decide "this instrument quotes in pence":
    //  1. the symbol rule (`MKS.L` / `MKS:xlon`, minus the GBP allowlist),
    //  2. the broker's own CurrencyCode, which is literally `GBX` for many
    //     LSE listings — including ones whose ticker we'd never guess (bare
    //     `MKS` with no venue suffix, depositary lines, secondary listings).
    // Either one is enough; a symbol we can't classify is still routed in
    // pence when Saxo says the instrument is pence-quoted.
    //
    // The native price must ALSO sit exactly on the instrument's tick grid,
    // or Saxo rejects with "The order price is not in tick size increments."
    // (404.75p on a 0.20p tick — the second MKS rejection). Fetch the tick
    // scheme from instrument details, snapping sells down / buys up so the
    // rounding can only make the order more marketable.
    const tickScheme = await this.fetchTickScheme(inst.uic, inst.assetType);
    const toQuote = (p: number) => {
      const native = nativeQuotePrice(req.symbol, p, inst.currency);
      const penceQuoted = native !== p || String(inst.currency).toUpperCase() === "GBX";
      const tick =
        (Number.isFinite(inst.tickSize) && (inst.tickSize ?? 0) > 0 && !tickScheme
          ? inst.tickSize!
          : null) ?? tickSizeForPrice(native, tickScheme, { penceQuoted });
      return roundPriceToTick(native, tick, req.side);
    };
    if (req.orderType === "limit" && req.limitPrice != null) {
      body.OrderPrice = toQuote(req.limitPrice);
    }
    if (req.orderType === "stop" && req.stopPrice != null) {
      body.OrderPrice = toQuote(req.stopPrice);
    }


    // Pre-flight against Saxo's precheck endpoint. This validates the order
    // against the *broker's* cash balance and position rules without actually
    // submitting it. Historically we skipped this step and let InsufficientCash
    // 400s from /trade/v2/orders spam the error log — the app's simulated cash
    // is often much larger than the real Saxo SIM account, so buys that look
    // fine to our engine get rejected downstream. Precheck lets us surface the
    // rejection cleanly (status: "rejected", no error row) before the POST.
    try {
      const pre = await this.req<{
        PreCheckResult?: string;
        ErrorInfo?: { ErrorCode?: string; Message?: string };
      }>("POST", "/trade/v2/orders/precheck", { body, maxAttempts: 2 });
      const outcome = String(pre.PreCheckResult ?? "").toLowerCase();
      const errCode = pre.ErrorInfo?.ErrorCode;
      const errMsg = pre.ErrorInfo?.Message;
      if (errCode || (outcome && outcome !== "ok")) {
        // Persist a structured PRECHECK_REJECT row so the UI can count
        // repeated cash-side rejections (InsufficientCash / InsufficientBuyingPower)
        // and surface a banner prompting the user to correct cash or risk
        // settings. Keyed by ErrorCode to make aggregation trivial.
        await log({
          portfolioId: this.portfolioId,
          userId: this.userId,
          env: this.env,
          method: "PRECHECK_REJECT",
          path: "/trade/v2/orders/precheck",
          status: 200,
          request: { symbol: req.symbol, side: req.side, quantity: req.quantity },
          response: {
            PreCheckResult: pre.PreCheckResult ?? null,
            ErrorCode: errCode ?? null,
            Message: errMsg ?? null,
          },
          error: errCode ?? errMsg ?? "precheck-failed",
        });
        // Fire an out-of-UI alert (in-app notification row + optional
        // webhook) once cash-side rejects cross the same threshold the
        // banner uses. Fire-and-forget; safe to run for non-cash rejects
        // — the helper filters by code/message itself.
        const { maybeNotifyPrecheckCashReject } = await import("@/lib/precheck-notify.server");
        maybeNotifyPrecheckCashReject({
          portfolioId: this.portfolioId,
          userId: this.userId,
          code: errCode ?? null,
          message: errMsg ?? null,
        });
        return {
          brokerOrderId: "",
          status: "rejected",
          reason: errMsg ?? errCode ?? `Precheck ${pre.PreCheckResult ?? "failed"}`,
          raw: pre,
        };
      }
    } catch {
      // Precheck itself failed (network, auth, endpoint variance). Fall through
      // to the real POST so we don't drop otherwise-valid orders on the floor.
    }


    // Load the operator-configurable 400-code policy once per placement.
    // Business rejections stay silent; codes flagged as "error" bubble up
    // as red banners. See src/lib/brokers/saxo-error-policy.ts.
    const { getSaxoErrorPolicy, classifySaxoError, extractSaxoErrorInfo } = await import(
      "./saxo-error-policy"
    );
    const policy = getSaxoErrorPolicy();

    try {
      // Saxo throttles /trade/v2/orders at ~1 req/sec. Space consecutive
      // placeOrder calls on the same adapter to at least 1.1s apart so a
      // burst of two orders doesn't waste retries fighting rate limits.
      const MIN_ORDER_GAP_MS = 1100;
      const wait = Math.max(0, this.lastOrderPostAt + MIN_ORDER_GAP_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastOrderPostAt = Date.now();
      const res = await this.req<{ OrderId?: string; ErrorInfo?: { Message?: string; ErrorCode?: string } }>(
        "POST",
        "/trade/v2/orders",
        {
          body,
          maxAttempts: 5,
          retryCapMs: 10_000,
          schema: SaxoPlaceOrderSchema,
          // 400 from /trade/v2/orders is almost always a business-rule
          // rejection (InsufficientCash, PositionLimit, MarketClosed). The
          // policy above lets an operator promote specific codes to loud
          // errors without touching this code path.
          silentStatuses: [400],
        },
      );
      this.lastOrderPostAt = Date.now();
      if (res.ErrorInfo) {
        const outcome = classifySaxoError(policy, res.ErrorInfo.ErrorCode, res.ErrorInfo.Message);
        const reason = res.ErrorInfo.Message ?? res.ErrorInfo.ErrorCode ?? "unknown";
        if (outcome === "error") {
          return { brokerOrderId: "", status: "error", reason, raw: res };
        }
        // "retry" collapses to rejected here — req()'s retry policy already
        // handles transient network/HTTP conditions; a 400 body that Saxo
        // labels transient is rare and safest treated as a rejection so we
        // don't spin against the broker.
        return { brokerOrderId: "", status: "rejected", reason, raw: res };
      }
      return { brokerOrderId: res.OrderId ?? "", status: "submitted", raw: res };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Extract Saxo's business-rule rejection from the thrown error text
      // so the caller sees a clean `rejected` outcome (or a promoted
      // `error`, per policy) rather than a raw stack trace.
      if (/\[400\]/.test(msg)) {
        const { code, message } = extractSaxoErrorInfo(msg);
        const outcome = classifySaxoError(policy, code, message);
        const reason = message ?? code ?? msg;
        if (outcome === "error") {
          return { brokerOrderId: "", status: "error", reason };
        }
        return { brokerOrderId: "", status: "rejected", reason };
      }
      return { brokerOrderId: "", status: "error", reason: msg };
    }


  }

  /**
   * Look up an FX pair (AssetType=FxSpot). Tries `${a}${b}` first, then
   * `${b}${a}`, since Saxo lists each pair under only one canonical ordering
   * (e.g. GBPUSD exists, USDGBP does not). Returns { uic, pairFirstCcy }
   * where `pairFirstCcy` is the currency you must express Amount in.
   */
  private async lookupFxPair(
    a: string,
    b: string,
  ): Promise<{ uic: number; pair: string; pairFirstCcy: string; pairSecondCcy: string } | null> {
    const candidates = [`${a}${b}`, `${b}${a}`];
    for (const pair of candidates) {
      const search = await this.req<{
        Data?: Array<{ Identifier: number; Symbol?: string; AssetType?: string; CurrencyCode?: string }>;
      }>("GET", "/ref/v1/instruments", {
        query: { Keywords: pair, AssetTypes: "FxSpot" },
      });
      const hit = (search.Data ?? []).find(
        (h) => h.AssetType === "FxSpot" && (h.Symbol ?? "").toUpperCase() === pair,
      );
      if (hit) {
        return {
          uic: hit.Identifier,
          pair,
          pairFirstCcy: pair.slice(0, 3),
          pairSecondCcy: pair.slice(3, 6),
        };
      }
    }
    return null;
  }

  /** Cached per-UIC FX spot amount rules (decimals + minimum ticket). */
  private static readonly fxRulesCache = new Map<number, { decimals: number; minAmount: number }>();

  /**
   * Amount rules for an FX spot pair. Saxo enforces both a decimal precision
   * and a minimum ticket size; posting a raw float (e.g. 812.3456789) is
   * rejected with "Number of decimals for fractional amount exceeds the
   * configured value". Falls back to whole currency units and a 1,000-unit
   * minimum, which every major pair accepts.
   */
  private async fxSpotAmountRules(uic: number): Promise<{ decimals: number; minAmount: number }> {
    const hit = SaxoAdapter.fxRulesCache.get(uic);
    if (hit) return hit;
    let rules = { decimals: 0, minAmount: 1_000 };
    try {
      const det = await this.req<{
        AmountDecimals?: number;
        OrderDecimals?: number;
        MinimumTradeSize?: number;
        MinimumOrderValue?: number;
        LotSize?: number;
      }>("GET", `/ref/v1/instruments/details/${uic}/FxSpot`);
      const dec = Number(det.AmountDecimals ?? det.OrderDecimals);
      const min = Number(det.MinimumTradeSize ?? det.LotSize ?? det.MinimumOrderValue);
      rules = {
        decimals: Number.isFinite(dec) && dec >= 0 && dec <= 6 ? Math.floor(dec) : 0,
        minAmount: Number.isFinite(min) && min > 0 ? min : 1_000,
      };
    } catch {
      /* keep the conservative defaults */
    }
    SaxoAdapter.fxRulesCache.set(uic, rules);
    return rules;
  }

  /**
   * Place a real spot FX conversion. `amountFrom` is expressed in `fromCcy`.
   * We choose Buy/Sell so the net effect debits `fromCcy` and credits `toCcy`
   * regardless of which currency happens to be the "first" side of the pair.
   *
   * Amount semantics (Saxo): for an FxSpot order on pair XXXYYY,
   *   Buy  Amount=N ⇒ receive N XXX, pay N * rate YYY
   *   Sell Amount=N ⇒ pay N XXX, receive N * rate YYY
   * So to convert FROM → TO:
   *   if FROM is the first ccy of the pair → Sell Amount=amountFrom
   *   else                                  → Buy  Amount=amountFrom / rate ≈ amountTo
   * Because we do not know the pre-trade rate, when `toCcy` is the first ccy
   * we skip the trade rather than send an under-sized order — the executor
   * treats that as a leg failure and drops the dependent buy.
   */
  async placeFxSpot(req: BrokerFxSpotRequest): Promise<BrokerFxSpotResult> {
    const from = req.fromCcy.toUpperCase();
    const to = req.toCcy.toUpperCase();
    if (from === to) {
      return { brokerOrderId: "", status: "filled", amountTo: req.amountFrom, fillRate: 1, pairSymbol: `${from}${to}` };
    }
    if (!(req.amountFrom > 0) || !Number.isFinite(req.amountFrom)) {
      return { brokerOrderId: "", status: "rejected", reason: "amountFrom must be positive" };
    }
    const pair = await this.lookupFxPair(from, to);
    if (!pair) {
      return { brokerOrderId: "", status: "rejected", reason: `FX pair ${from}/${to} not tradable on Saxo` };
    }
    // Only support the case where FROM is the first-ccy side of the pair,
    // because Saxo Amount is denominated in the first ccy and we don't have
    // a trusted pre-trade rate to size the reverse case safely.
    if (pair.pairFirstCcy !== from) {
      return {
        brokerOrderId: "",
        status: "rejected",
        reason: `FX pair only tradable as ${pair.pairFirstCcy}${pair.pairSecondCcy}; cannot size a ${from}->${to} spot order safely without pre-trade rate`,
      };
    }
    // Saxo rejects FX spot amounts that carry more decimals than the pair
    // allows ("Number of decimals for fractional amount exceeds the
    // configured value") and anything under the pair's minimum ticket. Both
    // were silently killing every USD buy, because a failed FX leg drops the
    // dependent order. Normalise the amount to the pair's own rules instead
    // of posting the raw float.
    const rules = await this.fxSpotAmountRules(pair.uic);
    const factor = 10 ** rules.decimals;
    const amount = Math.floor(req.amountFrom * factor + 1e-9) / factor;
    if (!(amount > 0)) {
      return {
        brokerOrderId: "",
        status: "rejected",
        reason: `FX ${from}->${to}: amount ${req.amountFrom} rounds to zero at ${rules.decimals} decimals`,
        pairSymbol: pair.pair,
      };
    }
    if (amount < rules.minAmount) {
      return {
        brokerOrderId: "",
        status: "rejected",
        reason:
          `FX ${from}->${to}: ${amount} is below the ${rules.minAmount} ${from} minimum ` +
          `ticket for ${pair.pair}; size the buy up or fund ${to} directly`,
        pairSymbol: pair.pair,
      };
    }

    const accountKey = await this.getDefaultAccountKey();
    const body: Record<string, unknown> = {
      Uic: pair.uic,
      AssetType: "FxSpot",
      BuySell: "Sell",
      Amount: amount,
      AmountType: "Quantity",
      OrderType: "Market",
      OrderDuration: { DurationType: "DayOrder" },
      ExternalReference: externalReference(req.clientOrderId),
      ManualOrder: true,
    };
    if (accountKey) body.AccountKey = accountKey;


    const { getSaxoErrorPolicy, classifySaxoError, extractSaxoErrorInfo } = await import(
      "./saxo-error-policy"
    );
    const policy = getSaxoErrorPolicy();
    try {
      const MIN_ORDER_GAP_MS = 1100;
      const wait = Math.max(0, this.lastOrderPostAt + MIN_ORDER_GAP_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastOrderPostAt = Date.now();
      const res = await this.req<{
        OrderId?: string;
        Price?: number;
        ErrorInfo?: { Message?: string; ErrorCode?: string };
      }>("POST", "/trade/v2/orders", {
        body,
        maxAttempts: 5,
        retryCapMs: 10_000,
        silentStatuses: [400],
        schema: SaxoPlaceOrderSchema,
      });
      this.lastOrderPostAt = Date.now();
      if (res.ErrorInfo) {
        const outcome = classifySaxoError(policy, res.ErrorInfo.ErrorCode, res.ErrorInfo.Message);
        const reason = res.ErrorInfo.Message ?? res.ErrorInfo.ErrorCode ?? "unknown";
        return { brokerOrderId: "", status: outcome === "error" ? "error" : "rejected", reason, raw: res, pairSymbol: pair.pair };
      }
      const fillRate = Number(res.Price ?? 0);
      const amountTo = fillRate > 0 ? amount * fillRate : undefined;
      return {
        brokerOrderId: res.OrderId ?? "",
        status: "submitted",
        raw: res,
        pairSymbol: pair.pair,
        fillRate: fillRate > 0 ? fillRate : undefined,
        amountTo,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\[400\]/.test(msg)) {
        const { code, message } = extractSaxoErrorInfo(msg);
        const outcome = classifySaxoError(policy, code, message);
        const reason = message ?? code ?? msg;
        return { brokerOrderId: "", status: outcome === "error" ? "error" : "rejected", reason, pairSymbol: pair.pair };
      }
      return { brokerOrderId: "", status: "error", reason: msg, pairSymbol: pair.pair };
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
      buySell?: "Buy" | "Sell";
      price?: number;
      currency?: string;
      assetType?: string;
      orderTime?: string;
    }>
  > {
    const res = await this.req<{
      Data?: Array<{
        OrderId?: string;
        Status?: string;
        Amount?: number;
        FilledAmount?: number;
        BuySell?: string;
        Price?: number;
        OrderPrice?: number;
        AssetType?: string;
        OrderTime?: string;
        DisplayAndFormat?: { Symbol?: string; Currency?: string };
      }>;
    }>("GET", "/port/v1/orders/me", { query: { FieldGroups: "DisplayAndFormat" }, schema: SaxoWorkingOrdersSchema });
    return (res.Data ?? []).map((o) => {
      const bs = String(o.BuySell ?? "");
      const p = Number(o.Price ?? o.OrderPrice ?? 0);
      return {
        brokerOrderId: String(o.OrderId ?? ""),
        symbol: o.DisplayAndFormat?.Symbol ?? "",
        status: String(o.Status ?? "Working"),
        amount: Number(o.Amount ?? 0),
        filledAmount: Number(o.FilledAmount ?? 0),
        buySell: bs === "Buy" || bs === "Sell" ? (bs as "Buy" | "Sell") : undefined,
        price: Number.isFinite(p) && p > 0 ? p : undefined,
        currency: o.DisplayAndFormat?.Currency ?? undefined,
        assetType: o.AssetType ?? undefined,
        orderTime: o.OrderTime ?? undefined,
      };
    }).filter((o) => o.brokerOrderId);
  }

  /**
   * List pending corporate action events for this account (dividends,
   * reinvestment elections, rights issues, mergers…).
   *
   * READ-ONLY: this adapter never submits an election. Saxo exposes the
   * corporate-actions service group under slightly different paths across
   * environments and API versions, and it is not enabled at all on some
   * SIM accounts — so we probe the known paths in order and report which
   * one answered. 403/404 are expected outcomes, not errors, and are kept
   * out of live_broker_log.
   */
  async listCorporateActions(): Promise<{
    endpoint: string | null;
    supported: boolean;
    events: unknown[];
    attempts: Array<{ path: string; error: string }>;
  }> {
    const candidates = [
      "/ca/v2/events",
      "/ca/v1/events",
      "/port/v1/corporateactions",
    ];
    const attempts: Array<{ path: string; error: string }> = [];
    for (const path of candidates) {
      try {
        const res = await this.req<{ Data?: unknown[] } | unknown[]>("GET", path, {
          query: { $top: 200 },
          silentStatuses: [400, 403, 404],
          maxAttempts: 2,
        });
        const events = Array.isArray(res) ? res : (res?.Data ?? []);
        return { endpoint: path, supported: true, events, attempts };
      } catch (e) {
        attempts.push({ path, error: redactedError(e).message });
      }
    }
    return { endpoint: null, supported: false, events: [], attempts };
  }


  /**
   * Booked trade charges for a date range — the broker's invoice, which is
   * what the friction KPI needs in order to stop grading our own cost model.
   *
   * Saxo exposes this under several service groups depending on environment
   * and entitlement, and SIM commonly exposes none of them. We probe in
   * descending order of fidelity and report which one answered; 400/403/404
   * are expected outcomes here, not errors, so they stay out of the broker
   * log rather than filling it with one row per hourly tick.
   */
  async getTradeCharges(args: { fromIso: string; toIso: string }): Promise<BrokerChargeReport> {
    const fromDate = args.fromIso.slice(0, 10);
    const toDate = args.toIso.slice(0, 10);
    const clientKey = await this.getClientKey();

    const candidates: Array<{ path: string; query: Record<string, string | number> }> = [
      ...(clientKey
        ? [{
            path: `/cs/v1/reports/trades/${encodeURIComponent(clientKey)}`,
            query: { FromDate: fromDate, ToDate: toDate, $top: 1000 },
          }]
        : []),
      { path: "/cs/v1/reports/trades/me", query: { FromDate: fromDate, ToDate: toDate, $top: 1000 } },
      {
        path: "/cs/v1/audit/activities",
        query: {
          FromDateTime: args.fromIso,
          ToDateTime: args.toIso,
          ActivityTypes: "Trades",
          $top: 1000,
        },
      },
    ];

    const attempts: string[] = [];
    for (const c of candidates) {
      try {
        const res = await this.req<{ Data?: unknown[] } | unknown[]>("GET", c.path, {
          query: c.query,
          silentStatuses: [400, 403, 404],
          maxAttempts: 2,
        });
        const rows = Array.isArray(res) ? res : (res?.Data ?? []);
        const { mapSaxoChargeRows } = await import("./saxo-charges");
        return { supported: true, endpoint: c.path, charges: mapSaxoChargeRows(rows) };
      } catch (e) {
        attempts.push(`${c.path}: ${redactedError(e).message}`);
      }
    }

    return {
      supported: false,
      endpoint: null,
      charges: [],
      reason: `no Saxo cost report available on ${this.env} (${attempts.join(" | ")})`,
    };
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
    if (this.histUnsupported) return null;
    const clientKey = await this.getClientKey();
    if (!clientKey) return null;
    try {
      // Saxo accepts the raw ClientKey (including trailing `==`) in the path;
      // URL-encoding it to `%3D%3D` trips IIS routing and returns an HTML 404
      // before the request ever reaches the OpenAPI layer.
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
      }>("GET", `/hist/v3/orders/${clientKey}`, {
        query: { FromDateTime: sinceIso },
        // Suppress noisy per-order 404s: reconciler polls this on every
        // open order every pass; when the env doesn't expose /hist we'd
        // otherwise write one error row per (order × pass).
        silentStatuses: [404],
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
    } catch (e) {
      // /hist endpoint is not universally enabled — treat as "unknown" and
      // stop trying for the life of this adapter to avoid log spam. Record
      // the disablement once so operators can still see why reconciliation
      // is degraded on this environment.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("failed [404]") && !this.histUnsupported) {
        this.histUnsupported = true;
        await log({
          portfolioId: this.portfolioId, userId: this.userId, env: this.env,
          method: "HIST_ORDERS_UNSUPPORTED",
          path: `/hist/v3/orders/${clientKey}`,
          status: 404,
          error: "Saxo /hist/v3/orders returned 404; further reconciliation calls to this endpoint will be skipped for this session.",
        });
      }
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
      const me = await this.req<{ ClientKey?: string }>("GET", "/port/v1/users/me", { schema: SaxoUserSchema });
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
      const accountKey = await this.getDefaultAccountKey();
      await this.req("DELETE", `/trade/v2/orders/${encodeURIComponent(brokerOrderId)}`, {
        query: accountKey ? { AccountKey: accountKey } : undefined,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async getDefaultAccountKey(): Promise<string | undefined> {
    if (this.resolvedAccountKey) return this.resolvedAccountKey;
    try {
      const res = await this.req<{ Data?: SaxoAccountSummary[] }>("GET", "/port/v1/accounts/me", {
        schema: SaxoAccountsSchema,
      });
      // Validate the configured key against THIS environment before trusting it.
      const resolution = resolveSaxoAccountKey({
        env: this.env,
        configured: this.accountKey,
        accounts: res.Data ?? [],
      });
      this.resolvedAccountKey = resolution.accountKey;
      this.accountKeyResolution = resolution;
      if (shouldReportAccountKeyIssue(this.env, resolution)) {
        await log({
          portfolioId: this.portfolioId,
          userId: this.userId,
          env: this.env,
          method: "ACCOUNT_KEY_VALIDATION",
          path: "/port/v1/accounts/me",
          status: 200,
          request: asJson({ configuredProvided: !!this.accountKey }),
          response: asJson({
            status: resolution.status,
            selected: !!resolution.accountKey,
            accountCount: resolution.accountCount,
          }),
          error: resolution.message,
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
      // Account list unavailable: fall back to the configured key unvalidated
      // rather than blocking the run, but do not cache it as validated.
      return this.accountKey;
    }
  }

  /** Last validation outcome for the configured account key (undefined until resolved). */
  async validateAccountKey(): Promise<SaxoAccountKeyResolution | undefined> {
    await this.getDefaultAccountKey();
    return this.accountKeyResolution;
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
  userId: string;
  portfolioId?: string | null;
  envOverride?: BrokerEnv;
  /**
   * Account this adapter is scoped to. Callers acting on behalf of a
   * portfolio MUST pass that portfolio's `broker_account_id`; otherwise
   * every portfolio shares the process-wide default account and their
   * holdings/cash converge onto one another. Only account-agnostic admin
   * probes may omit it.
   */
  accountKey?: string | null;
}): Promise<SaxoAdapter> {
  const env = (opts.envOverride ?? (process.env.SAXO_ENV as BrokerEnv) ?? "sim");
  if (env !== "sim" && env !== "live") throw new Error(`Invalid SAXO_ENV=${env}`);
  const { getAccessToken } = await import("./saxo-oauth.server");
  const token = await getAccessToken(env);
  return new SaxoAdapter({
    env, token, userId: opts.userId, portfolioId: opts.portfolioId ?? null,
    accountKey: opts.accountKey ?? process.env.SAXO_ACCOUNT_KEY,
    clientKey: process.env.SAXO_CLIENT_KEY,
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

