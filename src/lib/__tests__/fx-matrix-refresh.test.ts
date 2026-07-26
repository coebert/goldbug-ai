import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;

async function loadFx() {
  vi.resetModules();
  return await import("@/lib/fx.server");
}

describe("refreshFxMatrix", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("evicts cached entries so a subsequent call re-fetches from providers", async () => {
    const rates = [0.8, 0.81]; // first fetch, then refresh
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url);
      const rate = rates[Math.min(calls, rates.length - 1)];
      calls += 1;
      const to = u.searchParams.get("symbols") ?? "GBP";
      const base = u.searchParams.get("base") ?? "USD";
      return new Response(
        JSON.stringify({ base, rates: { [to]: rate } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { getFxMatrix, refreshFxMatrix } = await loadFx();
    const first = await getFxMatrix([{ from: "USD", to: "GBP" }]);
    expect(first.get("USDGBP")?.rate).toBe(0.8);

    // Without refresh, cache would win.
    const cached = await getFxMatrix([{ from: "USD", to: "GBP" }]);
    expect(cached.get("USDGBP")?.rate).toBe(0.8);
    expect(calls).toBe(1);

    const refreshed = await refreshFxMatrix([{ from: "USD", to: "GBP" }]);
    expect(refreshed.get("USDGBP")?.rate).toBe(0.81);
    expect(refreshed.get("USDGBP")?.stale).toBe(false);
    expect(calls).toBe(2);
  });


  it("returns identity fallback again when providers are still down on retry", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { refreshFxMatrix } = await loadFx();
    const m = await refreshFxMatrix([{ from: "USD", to: "JPY" }]);
    const r = m.get("USDJPY")!;
    expect(r.rate).toBe(1);
    expect(r.stale).toBe(true);
    expect(r.source.startsWith("fallback:")).toBe(true);
  });
});
