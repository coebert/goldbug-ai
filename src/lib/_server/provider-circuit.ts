// In-process circuit breaker for outbound third-party providers
// (Yahoo Finance, GDELT, Saxo, Lovable AI Gateway).
//
// The domain circuit breaker in `src/lib/circuit-breaker.server.ts` pauses
// the *AI trading loop* on loss streaks; this one is a plain fail-fast
// wrapper around remote calls so a provider outage doesn't burn the whole
// request budget on repeated timeouts.
//
// State is per Worker instance (Map in module scope). That's intentional:
// each Cloudflare Worker isolate handles a small burst of concurrent
// requests, and a shared/persisted breaker would need coordination we don't
// need at this scale. On isolate churn the breaker simply resets — the
// worst case is one extra failing call before the breaker re-opens.

import { createLogger } from "./log";

const log = createLogger("provider-circuit");

export interface CircuitOptions {
  /** Consecutive failures required to open the breaker. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe call. */
  cooldownMs?: number;
}

interface CircuitEntry {
  failures: number;
  openedAt: number | null;
  cooldownMs: number;
  failureThreshold: number;
}

const registry = new Map<string, CircuitEntry>();

function getEntry(name: string, opts?: CircuitOptions): CircuitEntry {
  let e = registry.get(name);
  if (!e) {
    e = {
      failures: 0,
      openedAt: null,
      cooldownMs: opts?.cooldownMs ?? 30_000,
      failureThreshold: opts?.failureThreshold ?? 5,
    };
    registry.set(name, e);
  } else if (opts) {
    // Allow options to be tuned per call; keeps API ergonomic.
    if (opts.cooldownMs != null) e.cooldownMs = opts.cooldownMs;
    if (opts.failureThreshold != null) e.failureThreshold = opts.failureThreshold;
  }
  return e;
}

export class CircuitOpenError extends Error {
  constructor(public provider: string, public retryAfterMs: number) {
    super(`provider ${provider} circuit open (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Run `fn` guarded by a named breaker. If the breaker is open, throws
 * `CircuitOpenError` immediately without invoking `fn`. Success closes the
 * breaker; a thrown error increments the failure count and opens the
 * breaker once the threshold is met.
 */
export async function runWithBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: CircuitOptions,
): Promise<T> {
  const entry = getEntry(name, opts);
  const now = Date.now();

  if (entry.openedAt != null) {
    const elapsed = now - entry.openedAt;
    if (elapsed < entry.cooldownMs) {
      throw new CircuitOpenError(name, entry.cooldownMs - elapsed);
    }
    // Cooldown elapsed — half-open: let this call probe.
    log.info("half-open probe", { provider: name });
  }

  try {
    const result = await fn();
    if (entry.failures > 0 || entry.openedAt != null) {
      log.info("closed after success", { provider: name, priorFailures: entry.failures });
    }
    entry.failures = 0;
    entry.openedAt = null;
    return result;
  } catch (err) {
    entry.failures += 1;
    if (entry.failures >= entry.failureThreshold) {
      entry.openedAt = now;
      log.warn("opened", {
        provider: name,
        failures: entry.failures,
        cooldownMs: entry.cooldownMs,
      });
    }
    throw err;
  }
}

/** Test helper — reset a single breaker or the whole registry. */
export function resetCircuit(name?: string) {
  if (name) registry.delete(name);
  else registry.clear();
}

/** Introspection for diagnostics endpoints. */
export function circuitSnapshot() {
  const out: Record<string, { failures: number; open: boolean; openedAt: number | null }> = {};
  for (const [name, e] of registry) {
    out[name] = { failures: e.failures, open: e.openedAt != null, openedAt: e.openedAt };
  }
  return out;
}
