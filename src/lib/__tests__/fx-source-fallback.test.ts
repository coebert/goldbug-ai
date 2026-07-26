import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fresh module for each test so the in-memory cache and env don't leak.
async function loadFx() {
  vi.resetModules();
  return await import("@/lib/fx.server");
}

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

const frankfurterBody = (_from: string, to: string, rate: number) =>
  new Response(
    JSON.stringify({ base: _from, rates: { [to]: rate } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const erApiBody = (to: string, rate: number) =>
  new Response(
    JSON.stringify({ result: "success", rates: { [to]: rate } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("getFxRate — source failures + identity fallback", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns identity (rate=1, source=identity, not stale) when from===to without hitting network", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const { getFxRate } = await loadFx();
    const r = await getFxRate("GBP", "GBP");
    expect(r).toEqual({ from: "GBP", to: "GBP", rate: 1, stale: false, source: "identity" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("uses Frankfurter as primary provider", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterBody("GBP", "EUR", 1.17);
      throw new Error("er-api should not be called");
    });
    const { getFxRate } = await loadFx();
    const r = await getFxRate("GBP", "EUR");
    expect(r.rate).toBe(1.17);
    expect(r.source).toBe("frankfurter");
    expect(r.stale).toBe(false);
  });

  it("falls back to open.er-api.com when Frankfurter returns 5xx", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return new Response("boom", { status: 503 });
      if (url.includes("er-api.com")) return erApiBody("EUR", 1.155);
      throw new Error("unexpected url " + url);
    });
    const { getFxRate } = await loadFx();
    const r = await getFxRate("GBP", "EUR");
    expect(r.rate).toBe(1.155);
    expect(r.source).toBe("er-api");
    expect(r.stale).toBe(false);
  });

  it("falls back to er-api when Frankfurter returns malformed json (no rate)", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter"))
        return new Response(JSON.stringify({ rates: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("er-api.com")) return erApiBody("EUR", 1.16);
      throw new Error("unexpected url " + url);
    });
    const { getFxRate } = await loadFx();
    const r = await getFxRate("GBP", "EUR");
    expect(r.source).toBe("er-api");
    expect(r.rate).toBe(1.16);
  });

  it("returns a stale-cache result when both providers fail but a fresh rate is cached", async () => {
    // Prime the cache with a successful Frankfurter call.
    mockFetch((url) => {
      if (url.includes("frankfurter")) return frankfurterBody("GBP", "EUR", 1.2);
      throw new Error("unexpected url " + url);
    });
    const { getFxRate } = await loadFx();
    const first = await getFxRate("GBP", "EUR");
    expect(first.source).toBe("frankfurter");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past 10 min TTL
    mockFetch((url) => {
      if (url.includes("frankfurter")) return new Response("nope", { status: 502 });
      if (url.includes("er-api.com")) return new Response("nope", { status: 500 });
      throw new Error("unexpected url " + url);
    });
    const second = await getFxRate("GBP", "EUR");
    expect(second.rate).toBe(1.2); // last known good
    expect(second.stale).toBe(true);
    expect(second.source).toBe("cache-stale");
  });

  it("returns rate=1 identity fallback with fallback source when both providers fail AND there is no cache", async () => {
    mockFetch((url) => {
      if (url.includes("frankfurter")) return new Response("boom", { status: 502 });
      if (url.includes("er-api.com")) return new Response("boom", { status: 500 });
      throw new Error("unexpected url " + url);
    });
    const { getFxRate } = await loadFx();
    const r = await getFxRate("GBP", "EUR");
    expect(r.rate).toBe(1);
    expect(r.stale).toBe(true);
    expect(r.source).toMatch(/^fallback:frankfurter\(.*\)\+er-api\(.*\)$/);
  });

  it("also falls back to identity when both providers throw (network)", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    const { getFxRate } = await loadFx();
    const r = await getFxRate("USD", "EUR");
    expect(r.rate).toBe(1);
    expect(r.stale).toBe(true);
    expect(r.source.startsWith("fallback:")).toBe(true);
  });

  it("cache hit on second call within TTL does not re-fetch", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls += 1;
      if (url.includes("frankfurter")) return frankfurterBody("GBP", "EUR", 1.1);
      throw new Error("unexpected url " + url);
    });
    const { getFxRate } = await loadFx();
    const a = await getFxRate("GBP", "EUR");
    const b = await getFxRate("GBP", "EUR");
    expect(a.source).toBe("frankfurter");
    expect(b.source).toBe("cache");
    expect(b.stale).toBe(false);
    expect(calls).toBe(1);
  });
});
