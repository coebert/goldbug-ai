// Crypto-specific pre-execution validation.
//
// The AI can propose buys against the crypto ETP sleeve (physically-backed
// Bitcoin / Ethereum / basket ETPs listed on XETRA, SIX and LSE). Before any
// such proposal is allowed into the sizing / broker pipeline we confirm the
// symbol is actually routable via Saxo *and* that we have the market data
// the sizer needs.
//
// Structure mirrors `commodity-validation.server.ts` — cache-only lookup
// against `saxo_instrument_cache` so the tick loop never fires a fresh
// /ref/v1/instruments request per proposal. Sells of existing crypto
// holdings always pass so a stale cache row can't trap a position.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { findSymbol, type UniverseSymbol } from "./universe.server";

// Saxo asset types accepted for cash-only crypto exposure. Physically-backed
// crypto products list as Etn (Exchange Traded Note) or Etp (Exchange Traded
// Product); a few basket products list as Etf. CFDs / futures / leveraged
// tokens are explicitly excluded — the crypto sleeve is spot-equivalent only.
export const CRYPTO_ALLOWED_SAXO_ASSET_TYPES = ["Etn", "Etp", "Etc", "Etf"] as const;

// Non-ETP crypto tickers (e.g. Yahoo spot pairs `BTC-USD`) are not routable
// via Saxo retail cash accounts. Reject at classification so the AI never
// sees them accepted for live trading.
const NON_ROUTABLE_SUFFIXES = ["-USD"];

const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type CryptoValidationOutcome = {
  ok: boolean;
  reason?: string;
  meta?: UniverseSymbol;
};

export type CryptoValidationInput = {
  symbol: string;
  side: "buy" | "sell";
  price: number | null | undefined;
  hasFeatureRow: boolean;
};

export function classifyCryptoProposal(
  input: CryptoValidationInput,
): { needsValidation: boolean; meta: UniverseSymbol | null; failFast: string | null } {
  const meta = findSymbol(input.symbol) ?? null;
  if (!meta || meta.asset_class !== "crypto") {
    return { needsValidation: false, meta, failFast: null };
  }
  if (input.side === "sell") {
    return { needsValidation: false, meta, failFast: null };
  }
  const upper = meta.symbol.toUpperCase();
  if (NON_ROUTABLE_SUFFIXES.some((s) => upper.endsWith(s))) {
    return {
      needsValidation: true,
      meta,
      failFast: `crypto ${meta.symbol} blocked: spot pair not routable via Saxo (use a physically-backed ETP e.g. BTCE.DE / VBTC.L / ABTC.SW)`,
    };
  }
  if (!Number.isFinite(input.price ?? NaN) || (input.price ?? 0) <= 0) {
    return {
      needsValidation: true,
      meta,
      failFast: `crypto ${meta.symbol} blocked: no live price available`,
    };
  }
  if (!input.hasFeatureRow) {
    return {
      needsValidation: true,
      meta,
      failFast: `crypto ${meta.symbol} blocked: missing technical feature row (vol/ATR/ADV) for sizing`,
    };
  }
  return { needsValidation: true, meta, failFast: null };
}

export type CryptoValidator = (
  input: CryptoValidationInput,
) => Promise<CryptoValidationOutcome>;

export function makeCryptoValidator(args: {
  supabaseAdmin: SupabaseClient<Database>;
  env: string; // "live" | "sim"
}): CryptoValidator {
  const { supabaseAdmin, env } = args;
  const cacheHits = new Map<string, CryptoValidationOutcome>();

  return async (input) => {
    const { needsValidation, meta, failFast } = classifyCryptoProposal(input);
    if (!needsValidation || !meta) return { ok: true, meta: meta ?? undefined };
    if (failFast) return { ok: false, reason: failFast, meta };

    const cacheKey = `${meta.symbol}::${env}`;
    const cached = cacheHits.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabaseAdmin
      .from("saxo_instrument_cache")
      .select("asset_type, refreshed_at, currency")
      .eq("symbol", meta.symbol)
      .eq("env", env)
      .maybeSingle();

    let outcome: CryptoValidationOutcome;
    if (error) {
      // DB errors are fail-open — broker precheck remains authoritative.
      outcome = {
        ok: true,
        meta,
        reason: `crypto ${meta.symbol}: instrument cache lookup failed (${error.message}); relying on broker validation`,
      };
    } else if (!data) {
      outcome = {
        ok: false,
        meta,
        reason: `crypto ${meta.symbol} blocked: not yet verified as Saxo-tradable (no instrument cache row for env=${env}). Trigger a live-broker refresh or place a manual smoke order to populate.`,
      };
    } else {
      const assetType = String(data.asset_type ?? "");
      if (!(CRYPTO_ALLOWED_SAXO_ASSET_TYPES as readonly string[]).includes(assetType)) {
        outcome = {
          ok: false,
          meta,
          reason: `crypto ${meta.symbol} blocked: Saxo asset type '${assetType}' not permitted (must be Etn/Etp/Etc/Etf; no CFDs/futures/leveraged tokens)`,
        };
      } else {
        const age = Date.now() - new Date(String(data.refreshed_at)).getTime();
        if (!Number.isFinite(age) || age > MAX_CACHE_AGE_MS) {
          outcome = {
            ok: false,
            meta,
            reason: `crypto ${meta.symbol} blocked: Saxo instrument cache is stale (>${Math.round(MAX_CACHE_AGE_MS / 86_400_000)}d). Refresh required before new buys.`,
          };
        } else {
          outcome = { ok: true, meta };
        }
      }
    }
    cacheHits.set(cacheKey, outcome);
    return outcome;
  };
}
