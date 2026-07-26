import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;

async function loadFx() {
  vi.resetModules();
  return await import("@/lib/fx.server");
}

describe("getFxMatrix", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("deduplicates pairs and returns one FxResult per unique pair", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url);
      const base = u.searchParams.get("base") ?? "";
      const to = u.searchParams.get("symbols") ?? "";
      const rate = base === "USD" && to === "GBP" ? 0.8 : 1.17;
      return new Response(
        JSON.stringify({ base, rates: { [to]: rate } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { getFxMatrix } = await loadFx();
    const m = await getFxMatrix([
      { from: "USD", to: "GBP" },
      { from: "usd", to: "gbp" }, // same pair, different case
      { from: "GBP", to: "EUR" },
      { from: "GBP", to: "GBP" }, // identity — no network
    ]);
    expect(m.size).toBe(3);
    expect(m.get("USDGBP")?.rate).toBe(0.8);
    expect(m.get("GBPEUR")?.rate).toBe(1.17);
    expect(m.get("GBPGBP")?.rate).toBe(1);
    expect(calls).toBe(2); // one per unique non-identity pair
  });

  it("returns identity + fallback entries when providers fail", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { getFxMatrix } = await loadFx();
    const m = await getFxMatrix([{ from: "USD", to: "JPY" }]);
    const r = m.get("USDJPY")!;
    expect(r.rate).toBe(1);
    expect(r.stale).toBe(true);
    expect(r.source.startsWith("fallback:")).toBe(true);
  });

});
