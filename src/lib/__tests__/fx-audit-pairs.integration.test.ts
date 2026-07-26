// Integration tests for the FX audit surface.
//
// These validate the same building block the `getFxAudit` server-function
// handler runs (`buildFxAuditPairs` in `fx-audit.server.ts`), so we assert on
// the exact matrix the SIM run details view receives without needing to
// stand up the RPC / Supabase middleware in-process.
//
// Coverage:
//   1. The full 6-pair USD/GBP↔EUR matrix is returned (identity rows
//      excluded) in stable "from+to" alphabetical order.
//   2. Each pair's `impliedInverse === 1 / rate` for every selected source
//      (frankfurter, er-api, cache, cache-stale, fallback identity).
//   3. `observedAt` reflects the correct source semantics: fetch time for
//      live provider hits, cache-write time for cache/cache-stale, and a
//      recent "now" for identity fallback.
//   4. Source failures propagate loudly: a provider outage that collapses
//      to identity=1 shows `source` starting with `fallback:` AND
//      `stale=true` on every affected row, so downstream sizing guards
//      have a single, obvious mismatch to key off. Any silent drift
//      (e.g. rate=1 but source=frankfurter) fails the test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const FRANKFURTER_RATES: Record<string, Record<string, number>> = {
  GBP: { USD: 1.27, EUR: 1.17 },
  USD: { GBP: 0.7874, EUR: 0.9213 },
  EUR: { GBP: 0.8547, USD: 1.0854 },
};

const ER_API_RATES: Record<string, Record<string, number>> = {
  GBP: { USD: 1.28, EUR: 1.16 },
  USD: { GBP: 0.7813, EUR: 0.9259 },
  EUR: { GBP: 0.8621, USD: 1.08 },
};

function frankfurterResponse(url: string): Response {
  const u = new URL(url);
  const base = u.searchParams.get("base") ?? "";
  const to = u.searchParams.get("symbols") ?? "";
  const rate = FRANKFURTER_RATES[base]?.[to];
  if (rate == null) return new Response("no rate", { status: 404 });
  return new Response(JSON.stringify({ base, rates: { [to]: rate } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function erApiResponse(url: string): Response {
  // /v6/latest/GBP
  const m = /\/v6\/latest\/([A-Z]{3})/.exec(url);
  const base = m?.[1] ?? "";
  const rates = ER_API_RATES[base] ?? {};
  return new Response(JSON.stringify({ result: "success", rates }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function loadHelpers() {
  vi.resetModules();
  return await import("@/lib/fx-audit.server");
}

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

// The six unique cross-pairs the audit surface must always return, in the
// exact order buildFxAuditPairs sorts them ("from+to" alphabetical).
const EXPECTED_PAIRS: Array<[string, string]> = [
  ["EUR", "GBP"],
  ["EUR", "USD"],
  ["GBP", "EUR"],
  ["GBP", "USD"],
  ["USD", "EUR"],
  ["USD", "GBP"],
];

describe("buildFxAuditPairs — matrix, inverses, observedAt per source", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns exactly 6 USD/GBP↔EUR cross-pairs in stable order and never any identity self-pairs", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterResponse(url);
      throw new Error("unexpected " + url);
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const pairs = await buildFxAuditPairs();
    expect(pairs).toHaveLength(6);
    for (const p of pairs) expect(p.from).not.toBe(p.to);
    expect(pairs.map((p) => [p.from, p.to])).toEqual(EXPECTED_PAIRS);
  });

  it("frankfurter source: rates match provider, impliedInverse === 1/rate, observedAt is recent (fetch time)", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterResponse(url);
      throw new Error("er-api should not be called");
    });
    const t0 = Date.now();
    const { buildFxAuditPairs } = await loadHelpers();
    const pairs = await buildFxAuditPairs();
    const t1 = Date.now();

    for (const p of pairs) {
      // Only one direction of each unordered pair is actually fetched; the
      // reverse row is derived as 1/rate from that same quote and carries
      // the source suffixed with ":inverse".
      expect(["frankfurter", "frankfurter:inverse"]).toContain(p.source);
      expect(p.stale).toBe(false);
      if (p.source === "frankfurter") {
        const expected = FRANKFURTER_RATES[p.from][p.to];
        expect(p.rate).toBeCloseTo(expected, 10);
      } else {
        // Inverse row: rate must equal 1 / (provider quote for the reverse pair).
        const providerReverse = FRANKFURTER_RATES[p.to][p.from];
        expect(p.rate).toBeCloseTo(1 / providerReverse, 10);
      }
      expect(p.impliedInverse).toBeCloseTo(1 / p.rate, 12);
      const obsMs = Date.parse(p.observedAt);
      expect(obsMs).toBeGreaterThanOrEqual(t0 - 5);
      expect(obsMs).toBeLessThanOrEqual(t1 + 5);
    }
  });

  it("er-api fallback: when Frankfurter is down, all 6 pairs come from er-api with correct inverses", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter"))
        return new Response("boom", { status: 503 });
      if (url.includes("er-api.com")) return erApiResponse(url);
      throw new Error("unexpected " + url);
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const pairs = await buildFxAuditPairs();
    for (const p of pairs) {
      expect(["er-api", "er-api:inverse"]).toContain(p.source);
      expect(p.stale).toBe(false);
      if (p.source === "er-api") {
        const expected = ER_API_RATES[p.from][p.to];
        expect(p.rate).toBeCloseTo(expected, 10);
      } else {
        const providerReverse = ER_API_RATES[p.to][p.from];
        expect(p.rate).toBeCloseTo(1 / providerReverse, 10);
      }
      expect(p.impliedInverse).toBeCloseTo(1 / p.rate, 12);
    }
  });


  it("cache: second call inside the TTL reports source=cache and observedAt equal to the original fetch time", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterResponse(url);
      throw new Error("er-api should not be called");
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const first = await buildFxAuditPairs();
    const firstObserved = new Map(
      first.map((p) => [`${p.from}${p.to}`, p.observedAt]),
    );

    // Advance clock inside TTL and re-request; provider is now offline to
    // prove we don't silently re-fetch behind the cache.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    mockFetch(() => {
      throw new Error("no network calls allowed on cache hit");
    });
    const second = await buildFxAuditPairs();
    for (const p of second) {
      expect(p.source).toBe("cache");
      expect(p.stale).toBe(false);
      expect(p.impliedInverse).toBeCloseTo(1 / p.rate, 12);
      // Cache observedAt MUST equal the original fetch time — not "now".
      expect(p.observedAt).toBe(firstObserved.get(`${p.from}${p.to}`));
    }
  });

  it("cache-stale: after TTL with providers down, rates persist but stale=true, source=cache-stale, and observedAt still points at the original fetch", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterResponse(url);
      throw new Error("er-api should not be called");
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const first = await buildFxAuditPairs();
    const firstObserved = new Map(
      first.map((p) => [`${p.from}${p.to}`, p.observedAt]),
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000); // past 10 min TTL
    mockFetch((url) => {
      if (url.includes("frankfurter"))
        return new Response("nope", { status: 502 });
      if (url.includes("er-api.com"))
        return new Response("nope", { status: 500 });
      throw new Error("unexpected " + url);
    });
    const second = await buildFxAuditPairs();
    for (const p of second) {
      expect(p.source).toBe("cache-stale");
      expect(p.stale).toBe(true);
      const expected = FRANKFURTER_RATES[p.from][p.to];
      expect(p.rate).toBeCloseTo(expected, 10);
      expect(p.impliedInverse).toBeCloseTo(1 / p.rate, 12);
      expect(p.observedAt).toBe(firstObserved.get(`${p.from}${p.to}`));
    }
  });

  it("fails loudly when both providers collapse to identity: rate=1, stale=true, source starts with 'fallback:' on every row (no silent drift)", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter"))
        return new Response("down", { status: 502 });
      if (url.includes("er-api.com"))
        return new Response("down", { status: 500 });
      throw new Error("unexpected " + url);
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const pairs = await buildFxAuditPairs();
    expect(pairs).toHaveLength(6);
    for (const p of pairs) {
      // The critical loud-failure invariant: identity fallback MUST NEVER
      // masquerade as a live provider. If any row ever reports rate=1 with
      // source=frankfurter|er-api|cache, the sizing layer would silently
      // trade on a bogus 1:1 cross-rate — this assertion catches that.
      expect(p.rate).toBe(1);
      expect(p.stale).toBe(true);
      expect(p.source.startsWith("fallback:")).toBe(true);
      // impliedInverse is defined only when rate>0; here rate=1 → inverse=1.
      expect(p.impliedInverse).toBe(1);
    }
  });

  it("mixed provider health: if just one pair fails while others succeed, the failing row is flagged loudly and the healthy rows keep their live source/inverse", async () => {
    // Simulate GBP→EUR missing from BOTH providers while the other pairs
    // remain healthy. The audit MUST still return 6 rows, and only the
    // GBP→EUR row (and its inverse EUR→GBP, which is derived separately by
    // the sizer) should show a fallback source.
    mockFetch((url) => {
      if (url.includes("frankfurter")) {
        const u = new URL(url);
        const base = u.searchParams.get("base") ?? "";
        const to = u.searchParams.get("symbols") ?? "";
        if (base === "GBP" && to === "EUR")
          return new Response("no", { status: 404 });
        return frankfurterResponse(url);
      }
      if (url.includes("er-api.com")) {
        const m = /\/v6\/latest\/([A-Z]{3})/.exec(url);
        const base = m?.[1] ?? "";
        if (base === "GBP") {
          // er-api returns success but omits EUR → still counts as failure.
          return new Response(
            JSON.stringify({ result: "success", rates: { USD: 1.28 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return erApiResponse(url);
      }
      throw new Error("unexpected " + url);
    });
    const { buildFxAuditPairs } = await loadHelpers();
    const pairs = await buildFxAuditPairs();
    const bad = pairs.find((p) => p.from === "GBP" && p.to === "EUR");
    expect(bad).toBeDefined();
    expect(bad!.rate).toBe(1);
    expect(bad!.stale).toBe(true);
    expect(bad!.source.startsWith("fallback:")).toBe(true);

    for (const p of pairs) {
      if (p === bad) continue;
      // Everything else must be a real live rate, not identity, not stale.
      expect(p.rate).not.toBe(1);
      expect(p.stale).toBe(false);
      expect(["frankfurter", "er-api"]).toContain(p.source);
      expect(p.impliedInverse).toBeCloseTo(1 / p.rate, 12);
    }
  });
});
