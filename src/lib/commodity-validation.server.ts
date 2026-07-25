// Commodity-specific pre-execution validation.
//
// The AI is free to propose commodity buys (physical-gold/silver ETCs,
// broad-commodity ETFs, oil/gas trackers, etc.), but a proposal is only
// safe to execute once we've confirmed the symbol is actually routable via
// Saxo *and* we have the market data the sizing pipeline needs.
//
// This helper is intentionally cache-only: it is called synchronously
// inside the tick loop, so it must not add network round-trips. All Saxo
// instrument data is populated on first live trade / admin refresh into
// `saxo_instrument_cache`. When the row is missing we conservatively block
// the buy with a clear reason instead of firing a fresh /ref/v1/instruments
// search per tick.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { findSymbol, type UniverseSymbol } from "./universe.server";

// Saxo asset types that we allow for cash-only commodity exposure. Physical
// gold/silver/etc. products list as "Etc"; broad-basket funds list as "Etf"
// or "Fund". CFDs/futures are explicitly excluded.
export const COMMODITY_ALLOWED_SAXO_ASSET_TYPES = ["Etc", "Etf", "Fund"] as const;

// How stale a cached instrument row is allowed to be before we consider it
// unverified. Matches the 24h freshness window Saxo lookupUic uses, with a
// generous 30-day fallback so a portfolio that hasn't ticked in weeks is
// not blocked purely on freshness.
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type CommodityValidationOutcome = {
  ok: boolean;
  reason?: string;
  meta?: UniverseSymbol;
};

export type CommodityValidationInput = {
  symbol: string;
  side: "buy" | "sell";
  price: number | null | undefined;
  hasFeatureRow: boolean;
};

// Pure classifier used by the DB-backed validator and by unit tests. All the
// "does this need Saxo verification" logic lives here so it can be exercised
// without a live Supabase client.
export function classifyCommodityProposal(
  input: CommodityValidationInput,
): { needsValidation: boolean; meta: UniverseSymbol | null; failFast: string | null } {
  const meta = findSymbol(input.symbol) ?? null;
  if (!meta || meta.asset_class !== "commodity") {
    return { needsValidation: false, meta, failFast: null };
  }
  // Sells of an existing commodity holding should always be allowed to
  // proceed — the goal is to protect execution of *new* commodity exposure.
  // A stale cache row must not trap the portfolio in a position it can't
  // exit; the broker call itself will surface any real routing error.
  if (input.side === "sell") {
    return { needsValidation: false, meta, failFast: null };
  }
  if (!Number.isFinite(input.price ?? NaN) || (input.price ?? 0) <= 0) {
    return {
      needsValidation: true,
      meta,
      failFast: `commodity ${meta.symbol} blocked: no live price available`,
    };
  }
  if (!input.hasFeatureRow) {
    return {
      needsValidation: true,
      meta,
      failFast: `commodity ${meta.symbol} blocked: missing technical feature row (vol/ATR/ADV) for sizing`,
    };
  }
  return { needsValidation: true, meta, failFast: null };
}

export type CommodityValidator = (
  input: CommodityValidationInput,
) => Promise<CommodityValidationOutcome>;

// Build a validator bound to the current Supabase admin client + Saxo env.
// Returns { ok:true } for anything that isn't a commodity buy (so the caller
// can invoke it unconditionally without special-casing asset classes).
export function makeCommodityValidator(args: {
  supabaseAdmin: SupabaseClient<Database>;
  env: string; // "live" | "sim"
}): CommodityValidator {
  const { supabaseAdmin, env } = args;
  const cacheHits = new Map<string, CommodityValidationOutcome>();

  return async (input) => {
    const { needsValidation, meta, failFast } = classifyCommodityProposal(input);
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

    let outcome: CommodityValidationOutcome;
    if (error) {
      // DB errors are fail-open: we don't want a transient outage to freeze
      // every commodity buy. Downstream broker calls remain authoritative.
      outcome = {
        ok: true,
        meta,
        reason: `commodity ${meta.symbol}: instrument cache lookup failed (${error.message}); relying on broker validation`,
      };
    } else if (!data) {
      outcome = {
        ok: false,
        meta,
        reason: `commodity ${meta.symbol} blocked: not yet verified as Saxo-tradable (no instrument cache row for env=${env}). Trigger a live-broker refresh or place a manual smoke order to populate.`,
      };
    } else {
      const assetType = String(data.asset_type ?? "");
      if (!(COMMODITY_ALLOWED_SAXO_ASSET_TYPES as readonly string[]).includes(assetType)) {
        outcome = {
          ok: false,
          meta,
          reason: `commodity ${meta.symbol} blocked: Saxo asset type '${assetType}' not permitted (must be Etc/Etf/Fund; no CFDs/futures)`,
        };
      } else {
        const age = Date.now() - new Date(String(data.refreshed_at)).getTime();
        if (!Number.isFinite(age) || age > MAX_CACHE_AGE_MS) {
          outcome = {
            ok: false,
            meta,
            reason: `commodity ${meta.symbol} blocked: Saxo instrument cache is stale (>${Math.round(MAX_CACHE_AGE_MS / 86_400_000)}d). Refresh required before new buys.`,
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
