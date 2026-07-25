/**
 * Configurable mapping for Saxo HTTP 400 business-rule failures.
 *
 * Saxo replies to /trade/v2/orders with HTTP 400 for a wide range of
 * conditions: some are genuine business rejections (InsufficientCash,
 * PositionLimit, MarketClosed) that we want to surface cleanly to the user
 * as `status: "rejected"` without alarming red error rows; others may
 * indicate a real system problem (bad payload, expired token variant) that
 * we want to keep raising as `status: "error"` so an operator sees them.
 *
 * The policy is a map from Saxo `ErrorCode` (case-insensitive) to one of:
 *   - "rejected"  → clean rejection, no error row logged
 *   - "error"     → true system error, surfaces as a red banner
 *   - "retry"     → transient; adapter should retry per its normal backoff
 *
 * Unknown codes fall back to `defaultOutcome` (default: "rejected", since
 * historically every 400 was treated as a business rejection).
 *
 * The runtime map is overridable via the SAXO_ERROR_POLICY_JSON env var,
 * e.g.
 *   SAXO_ERROR_POLICY_JSON='{"default":"rejected","codes":{"InvalidRequest":"error"}}'
 */

export type SaxoErrorOutcome = "rejected" | "error" | "retry";

export type SaxoErrorPolicy = {
  /** Fallback for codes not listed in `codes`. */
  defaultOutcome: SaxoErrorOutcome;
  /** Case-insensitive ErrorCode → outcome. */
  codes: Record<string, SaxoErrorOutcome>;
};

/**
 * Baseline policy tuned to observed Saxo SIM behaviour. All values can be
 * overridden by the operator via SAXO_ERROR_POLICY_JSON without a redeploy.
 */
export const DEFAULT_SAXO_ERROR_POLICY: SaxoErrorPolicy = {
  defaultOutcome: "rejected",
  codes: {
    // ---- Clean business rejections (silent, no error row) ----
    InsufficientCash: "rejected",
    InsufficientBuyingPower: "rejected",
    PositionLimit: "rejected",
    OrderSizeTooSmall: "rejected",
    OrderSizeTooLarge: "rejected",
    MarketClosed: "rejected",
    TradingNotAllowed: "rejected",
    InstrumentNotTradable: "rejected",
    InstrumentSuspended: "rejected",
    PriceOutsideRange: "rejected",
    InvalidPrice: "rejected",
    InvalidAmount: "rejected",
    InvalidLotSize: "rejected",
    ShortSellingNotAllowed: "rejected",

    // ---- True system errors (surface loudly) ----
    InvalidRequest: "error",
    InvalidModelState: "error",
    Unauthorized: "error",
    Forbidden: "error",
    InvalidAccountKey: "error",
    InvalidClientKey: "error",

    // ---- Transient (retry inside req()) ----
    Throttled: "retry",
    RateLimitExceeded: "retry",
    ServiceUnavailable: "retry",
  },
};

/**
 * Parse the operator override from an environment JSON blob. The shape
 * accepted is either the full policy `{ default, codes }` or just a code
 * map `{ InsufficientCash: "rejected", ... }`. Invalid values are ignored
 * and logged rather than throwing — a malformed override should never
 * break trading.
 */
export function parseSaxoErrorPolicyOverride(raw: string | undefined | null): Partial<SaxoErrorPolicy> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn("SAXO_ERROR_POLICY_JSON is not valid JSON, ignoring override:", e);
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;

  const out: Partial<SaxoErrorPolicy> = {};
  const validOutcomes: SaxoErrorOutcome[] = ["rejected", "error", "retry"];

  const defaultCandidate = obj.default ?? obj.defaultOutcome;
  if (typeof defaultCandidate === "string" && (validOutcomes as string[]).includes(defaultCandidate)) {
    out.defaultOutcome = defaultCandidate as SaxoErrorOutcome;
  }

  const codeSource = (obj.codes && typeof obj.codes === "object" ? obj.codes : parsed) as Record<string, unknown>;
  const codes: Record<string, SaxoErrorOutcome> = {};
  for (const [key, value] of Object.entries(codeSource)) {
    if (key === "default" || key === "defaultOutcome" || key === "codes") continue;
    if (typeof value !== "string" || !(validOutcomes as string[]).includes(value)) continue;
    codes[key] = value as SaxoErrorOutcome;
  }
  if (Object.keys(codes).length > 0) out.codes = codes;

  return out;
}

/** Merge an override on top of the baseline policy. */
export function mergeSaxoErrorPolicy(
  base: SaxoErrorPolicy,
  override: Partial<SaxoErrorPolicy>,
): SaxoErrorPolicy {
  return {
    defaultOutcome: override.defaultOutcome ?? base.defaultOutcome,
    codes: { ...base.codes, ...(override.codes ?? {}) },
  };
}

/**
 * Resolve the outcome for a given Saxo ErrorCode / message pair. The
 * `errorCode` lookup is case-insensitive so operators don't have to worry
 * about matching Saxo's exact casing.
 */
export function classifySaxoError(
  policy: SaxoErrorPolicy,
  errorCode: string | null | undefined,
  _message?: string | null,
): SaxoErrorOutcome {
  if (!errorCode) return policy.defaultOutcome;
  const target = errorCode.toLowerCase();
  for (const [key, value] of Object.entries(policy.codes)) {
    if (key.toLowerCase() === target) return value;
  }
  return policy.defaultOutcome;
}

/** Read the effective policy from process.env. Cheap — safe to call per-order. */
export function getSaxoErrorPolicy(): SaxoErrorPolicy {
  const override = parseSaxoErrorPolicyOverride(process.env.SAXO_ERROR_POLICY_JSON);
  return mergeSaxoErrorPolicy(DEFAULT_SAXO_ERROR_POLICY, override);
}

/**
 * Attempt to extract Saxo's ErrorCode + Message from an error thrown by
 * req(). The thrown message looks like:
 *   `Saxo POST /trade/v2/orders failed [400]: {"ErrorInfo":{"ErrorCode":"InsufficientCash","Message":"..."}}`
 */
export function extractSaxoErrorInfo(rawMessage: string): { code: string | null; message: string | null } {
  const jsonStart = rawMessage.indexOf("{");
  if (jsonStart < 0) return { code: null, message: null };
  try {
    const parsed = JSON.parse(rawMessage.slice(jsonStart)) as {
      ErrorInfo?: { ErrorCode?: string; Message?: string };
    };
    return {
      code: parsed.ErrorInfo?.ErrorCode ?? null,
      message: parsed.ErrorInfo?.Message ?? null,
    };
  } catch {
    return { code: null, message: null };
  }
}
