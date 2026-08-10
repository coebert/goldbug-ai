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
  /**
   * Optional on-demand instrument lookup (Saxo /ref/v1 search, which also
   * upserts `saxo_instrument_cache`). Without it a symbol that has never
   * been traded can never be verified — the cache only fills during
   * execution, and execution is what this gate blocks. That deadlock silently
   * killed every first buy of a new ETP. Resolve `null` when the instrument
   * genuinely does not exist; throw for transient failures (we then fail open
   * and let the broker precheck decide).
   */
  resolveInstrument?: (symbol: string) => Promise<{ assetType: string } | null>;
}): CryptoValidator {
  const { supabaseAdmin, env, resolveInstrument } = args;
  const cacheHits = new Map<string, CryptoValidationOutcome>();

  // Shared verdict for an asset type coming from either the cache or a live
  // lookup, so both paths enforce exactly the same allowlist.
  const verdictForAssetType = (meta: UniverseSymbol, assetType: string): CryptoValidationOutcome =>
    (CRYPTO_ALLOWED_SAXO_ASSET_TYPES as readonly string[]).includes(assetType)
      ? { ok: true, meta }
      : {
          ok: false,
          meta,
          reason: `crypto ${meta.symbol} blocked: Saxo asset type '${assetType}' not permitted (must be Etn/Etp/Etc/Etf; no CFDs/futures/leveraged tokens)`,
        };

  // Cache miss / stale row: try to resolve the instrument live before
  // blocking. A successful lookup writes the cache row as a side effect.
  const resolveOrBlock = async (
    meta: UniverseSymbol,
    staleness: "missing" | "stale",
  ): Promise<CryptoValidationOutcome> => {
    if (!resolveInstrument) {
      return {
        ok: false,
        meta,
        reason: `crypto ${meta.symbol} blocked: not yet verified as Saxo-tradable (instrument cache row ${staleness} for env=${env}). Trigger a live-broker refresh or place a manual smoke order to populate.`,
      };
    }
    try {
      const hit = await resolveInstrument(meta.symbol);
      if (!hit) {
        return {
          ok: false,
          meta,
          reason: `crypto ${meta.symbol} blocked: Saxo has no matching tradable instrument (env=${env})`,
        };
      }
      return verdictForAssetType(meta, String(hit.assetType ?? ""));
    } catch (e) {
      // Transient lookup failure (token/network/rate limit). Fail open — the
      // broker's own precheck rejects anything unroutable, and freezing the
      // sleeve on an outage is the worse failure.
      return {
        ok: true,
        meta,
        reason: `crypto ${meta.symbol}: live instrument lookup failed (${e instanceof Error ? e.message : String(e)}); relying on broker validation`,
      };
    }
  };

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
      outcome = await resolveOrBlock(meta, "missing");
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
          outcome = await resolveOrBlock(meta, "stale");
        } else {
          outcome = { ok: true, meta };
        }
      }
    }
    cacheHits.set(cacheKey, outcome);
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// Extra pre-trade gates applied AFTER sizing but BEFORE the order hits Saxo.
//
// These guard against the four classes of errors we've seen Saxo reject after
// the initial classifier/routability gate:
//
//   1. Fee-heavy dust orders  — commission > 1.5% of notional makes the trade
//      structurally losing before the first tick moves.
//   2. Fractional-share requests — the six approved ETPs trade in whole units
//      on XETRA / SIX / LSE. Fractional quantities are rounded down by the
//      broker with no fill; we'd rather reject upfront with a clear reason.
//   3. Below-minimum notional — venues quietly reject sub-€100 orders on
//      these ETPs. Same-day retries burn a slot in max_new_positions_per_day.
//   4. Venue closed — orders queue in Saxo's book until the next session,
//      which breaks the tick-loop's assumption that fills reconcile within
//      one run.
//
// Kept as a pure function so it's trivially unit-testable. Config values are
// exported so tests + UI can show the same thresholds the engine enforces.
// ---------------------------------------------------------------------------

export type CryptoPreTradeConfig = {
  max_fee_pct: number;
  estimated_fee_pct: number;
  estimated_fee_min_local: number;
  lot_size: number;
  min_order_value_local: number;
  allowed_phases: readonly string[];
};

export const CRYPTO_PRETRADE_CONFIG: CryptoPreTradeConfig = {
  // Max broker commission as a fraction of order notional. Saxo's tiered
  // schedule is ~0.08% on XETRA/SIX/LSE with a small per-order floor, so any
  // effective rate over 1.5% means the order is too small to be economic.
  max_fee_pct: 0.015,
  // Fee estimate fallback when the cache has no explicit commission info.
  // Chosen to match Saxo's classic retail schedule for European exchanges.
  estimated_fee_pct: 0.0010,        // 10 bps
  estimated_fee_min_local: 5,       // per-order floor in the ETP's local ccy
  // Minimum whole-unit lot size for the approved crypto ETPs. All six
  // (BTCE.DE, ABTC.SW, VBTC.L, ZETH.SW, ETHE.DE, HODL.SW) are cash equities
  // that trade in whole shares on their listing venue.
  lot_size: 1,
  // Minimum acceptable order notional expressed in the ETP's local ccy.
  // Kept intentionally conservative — Saxo enforces its own floors.
  min_order_value_local: 100,
  // Venue phases in which we're willing to route a fresh order. `regular`
  // is Saxo's continuous auction window; anything else queues the order.
  allowed_phases: ["regular"],
};

/** Approximate venue trading window (local wall-clock minutes, Mon–Fri). */
type VenueSession = { tz: string; openMin: number; closeMin: number; label: string };

// Session windows are intentionally 5 minutes inside the auction to keep us
// off the opening/closing crosses where Saxo often rejects with `MarketClosed`
// or `NoLastTradedPrice`.
const CRYPTO_ETP_SESSIONS: Record<string, VenueSession> = {
  ".DE":  { tz: "Europe/Berlin", openMin: 9 * 60 + 5,  closeMin: 17 * 60 + 25, label: "XETRA" },
  ".SW":  { tz: "Europe/Zurich", openMin: 9 * 60 + 5,  closeMin: 17 * 60 + 25, label: "SIX"   },
  ".L":   { tz: "Europe/London", openMin: 8 * 60 + 5,  closeMin: 16 * 60 + 25, label: "LSE"   },
};

export function sessionForCryptoEtp(symbol: string): (VenueSession & { suffix: string }) | null {
  const upper = symbol.toUpperCase();
  for (const suffix of Object.keys(CRYPTO_ETP_SESSIONS)) {
    if (upper.endsWith(suffix)) return { suffix, ...CRYPTO_ETP_SESSIONS[suffix] };
  }
  return null;
}

function venueLocalMinutes(now: Date, tz: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutes: Number(get("hour") || "0") * 60 + Number(get("minute") || "0"),
    weekday: wdMap[get("weekday")] ?? 0,
  };
}

export function isCryptoEtpVenueOpen(symbol: string, now: Date = new Date()): {
  open: boolean; venue: string | null; reason: string | null;
} {
  const s = sessionForCryptoEtp(symbol);
  if (!s) return { open: true, venue: null, reason: null };
  const { minutes, weekday } = venueLocalMinutes(now, s.tz);
  if (weekday === 0 || weekday === 6) {
    return { open: false, venue: s.label, reason: `${s.label} closed (weekend)` };
  }
  if (minutes < s.openMin || minutes >= s.closeMin) {
    return {
      open: false, venue: s.label,
      reason: `${s.label} outside regular session (local ${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")})`,
    };
  }
  return { open: true, venue: s.label, reason: null };
}

/** Estimate broker commission in the ETP's LOCAL currency. */
export function estimateCryptoEtpFeeLocal(notionalLocal: number, cfg = CRYPTO_PRETRADE_CONFIG): number {
  if (!(notionalLocal > 0)) return cfg.estimated_fee_min_local;
  return Math.max(cfg.estimated_fee_min_local, notionalLocal * cfg.estimated_fee_pct);
}

export type CryptoPreTradeInput = {
  symbol: string;
  side: "buy" | "sell";
  price: number;                  // in the ETP's local currency
  quantity: number;               // requested units after sizing/execution
  /** Broker-quoted fee if available; falls back to `estimateCryptoEtpFeeLocal`. */
  brokerFeeLocal?: number | null;
  now?: Date;
  /** Override thresholds in tests. */
  config?: Partial<typeof CRYPTO_PRETRADE_CONFIG>;
};

export type CryptoPreTradeOutcome = {
  ok: boolean;
  reason?: string;
  gate?: "fee" | "lot_size" | "min_notional" | "market_hours";
  notionalLocal: number;
  feeLocal: number;
  feePct: number;
  venue: string | null;
};

/**
 * Post-sizing pre-trade gate for crypto ETPs. Skipped for SELLs (we always
 * let a position exit even if fees are ugly or the venue just closed — the
 * broker will simply queue it).
 */
export function runCryptoPreTradeChecks(input: CryptoPreTradeInput): CryptoPreTradeOutcome {
  const cfg = { ...CRYPTO_PRETRADE_CONFIG, ...(input.config ?? {}) };
  const price = Number(input.price);
  const qty = Number(input.quantity);
  const notionalLocal = Math.max(0, price * qty);
  const feeLocal = Math.max(
    0,
    input.brokerFeeLocal != null && Number.isFinite(input.brokerFeeLocal)
      ? Number(input.brokerFeeLocal)
      : estimateCryptoEtpFeeLocal(notionalLocal, cfg),
  );
  const feePct = notionalLocal > 0 ? feeLocal / notionalLocal : 1;
  const venueSession = sessionForCryptoEtp(input.symbol);
  const venueLabel = venueSession?.label ?? null;

  // SELLs bypass economic gates but still surface a warning-shaped outcome.
  if (input.side === "sell") {
    return { ok: true, notionalLocal, feeLocal, feePct, venue: venueLabel };
  }

  // 1. Whole-unit lot size (BTCE.DE / ZETH.SW / HODL.SW etc. don't fractionise).
  if (!(qty > 0) || Math.abs(qty - Math.round(qty)) > 1e-9 || qty < cfg.lot_size) {
    return {
      ok: false,
      gate: "lot_size",
      reason: `crypto ${input.symbol} blocked: quantity ${qty} < lot size ${cfg.lot_size} or not a whole unit`,
      notionalLocal, feeLocal, feePct, venue: venueLabel,
    };
  }

  // 2. Minimum notional in local currency.
  if (notionalLocal < cfg.min_order_value_local) {
    return {
      ok: false,
      gate: "min_notional",
      reason: `crypto ${input.symbol} blocked: notional ${notionalLocal.toFixed(2)} below venue minimum ${cfg.min_order_value_local}`,
      notionalLocal, feeLocal, feePct, venue: venueLabel,
    };
  }

  // 3. Fee headroom — the order must still be economic after commission.
  if (feePct > cfg.max_fee_pct) {
    return {
      ok: false,
      gate: "fee",
      reason: `crypto ${input.symbol} blocked: est. fee ${(feePct * 100).toFixed(2)}% > cap ${(cfg.max_fee_pct * 100).toFixed(2)}% (fee=${feeLocal.toFixed(2)} on ${notionalLocal.toFixed(2)})`,
      notionalLocal, feeLocal, feePct, venue: venueLabel,
    };
  }

  // 4. Market hours — reject fresh buys when the venue isn't in its
  //    continuous auction. SIX/XETRA/LSE close overnight and on weekends;
  //    queued orders skew the tick-loop reconciliation.
  const hours = isCryptoEtpVenueOpen(input.symbol, input.now ?? new Date());
  if (!hours.open) {
    return {
      ok: false,
      gate: "market_hours",
      reason: `crypto ${input.symbol} blocked: ${hours.reason ?? "venue closed"}`,
      notionalLocal, feeLocal, feePct, venue: venueLabel,
    };
  }

  return { ok: true, notionalLocal, feeLocal, feePct, venue: venueLabel };
}
