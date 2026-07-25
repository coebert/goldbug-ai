// Pre-trade FX matrix guard.
//
// Inspects the bulk FX matrix (from `getFxMatrix`) against the set of
// currency legs a batch of buys actually requires, and returns the pairs
// that must NOT be routed. A pair is blocked when its matrix entry is:
//
//   - MISSING           — no entry at all (network / provider failure)
//   - IDENTITY_FALLBACK — `source` starts with "fallback:" and rate=1
//                         (both live providers down and no cached rate)
//   - STALE             — `stale: true` (cache-stale or non-live source)
//
// The executor uses this to skip buys whose instrument currency depends on
// a blocked pair BEFORE the trimmer runs, so we never quote size against a
// rate we don't trust and never hand Saxo an order guaranteed to reject as
// InsufficientCash.
//
// Pure — no IO, no side effects. Safe to unit-test in isolation.

export type FxMatrixEntry = { rate: number; stale: boolean; source: string };
export type FxMatrixLike = {
  get(key: string): FxMatrixEntry | undefined;
};

export type BlockedFxPairReason = "missing" | "identity_fallback" | "stale";

export type BlockedFxPair = {
  from: string;
  to: string;
  reason: BlockedFxPairReason;
  /** Human-readable explanation suitable for a broker-log `error` column. */
  detail: string;
  /** Present when `reason !== "missing"`. */
  source?: string;
};

export type FxMatrixGuardResult = {
  /** Currency codes whose base->ccy conversion is blocked. */
  blockedCcys: Set<string>;
  /** One row per blocked pair, in the order supplied. */
  blocked: BlockedFxPair[];
  /** True when at least one required pair is blocked. */
  hasBlock: boolean;
};

/**
 * @param baseCcy      portfolio base currency (e.g. "GBP")
 * @param requiredCcys instrument currencies the batch needs to spend in
 * @param matrix       result of `getFxMatrix` (keyed by `${from}${to}`)
 */
export function guardFxMatrix(
  baseCcy: string,
  requiredCcys: readonly string[],
  matrix: FxMatrixLike,
): FxMatrixGuardResult {
  const base = baseCcy.toUpperCase();
  const seen = new Set<string>();
  const blocked: BlockedFxPair[] = [];
  const blockedCcys = new Set<string>();

  for (const raw of requiredCcys) {
    const to = raw.toUpperCase();
    if (to === base) continue; // no conversion needed
    if (seen.has(to)) continue;
    seen.add(to);

    const entry = matrix.get(`${base}${to}`);
    if (!entry) {
      blocked.push({
        from: base,
        to,
        reason: "missing",
        detail: `fx ${base}->${to} missing from matrix (provider outage)`,
      });
      blockedCcys.add(to);
      continue;
    }
    // Identity-fallback: both live providers failed and no cached rate is
    // available. The fx.server module returns rate=1 with a "fallback:..."
    // source tag; treat that as unusable regardless of the stale flag.
    if (entry.source.startsWith("fallback:")) {
      blocked.push({
        from: base,
        to,
        reason: "identity_fallback",
        detail: `fx ${base}->${to} using identity fallback (${entry.source})`,
        source: entry.source,
      });
      blockedCcys.add(to);
      continue;
    }
    if (entry.stale === true) {
      blocked.push({
        from: base,
        to,
        reason: "stale",
        detail: `fx ${base}->${to} rate is stale (source=${entry.source})`,
        source: entry.source,
      });
      blockedCcys.add(to);
      continue;
    }
  }

  return { blockedCcys, blocked, hasBlock: blocked.length > 0 };
}
