// Focused unit tests for the extracted price-map helpers.
// These lock the behaviour that the monolithic trading engine relied on:
// broker-native ↔ Yahoo symbol tolerance, GBX→GBP normalization, and the
// "fall back to avg_cost rather than zero" contract.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getPriceOn = vi.fn<(symbol: string, date: string) => Promise<number | null>>();

vi.mock("../../market-data.server", () => ({
  getPriceOn: (s: string, d: string) => getPriceOn(s, d),
}));

import { holdingPriceBySymbol, holdingLivePrice, currentPrices } from "../prices.server";

beforeEach(() => {
  getPriceOn.mockReset();
});

describe("holdingPriceBySymbol", () => {
  it("finds a quote stored under the canonical Yahoo key from a broker-native symbol", () => {
    const map = new Map([["MKS.L", 3.21]]);
    expect(holdingPriceBySymbol(map, "MKS:xlon")).toBe(3.21);
  });

  it("is case-tolerant in both directions", () => {
    expect(holdingPriceBySymbol(new Map([["aapl", 100]]), "AAPL:xnas")).toBe(100);
    expect(holdingPriceBySymbol(new Map([["AAPL", 100]]), "aapl")).toBe(100);
  });

  it("returns null (not 0) when there is no quote, so callers can tell 'missing' from 'zero'", () => {
    expect(holdingPriceBySymbol(new Map(), "AAPL")).toBeNull();
  });

  it("rejects non-positive and non-finite quotes rather than propagating them", () => {
    expect(holdingPriceBySymbol(new Map([["AAPL", 0]]), "AAPL")).toBeNull();
    expect(holdingPriceBySymbol(new Map([["AAPL", -5]]), "AAPL")).toBeNull();
    expect(holdingPriceBySymbol(new Map([["AAPL", Number.NaN]]), "AAPL")).toBeNull();
    expect(holdingPriceBySymbol(new Map([["AAPL", Infinity]]), "AAPL")).toBeNull();
  });

  it("handles empty and colon-only symbols without throwing", () => {
    expect(holdingPriceBySymbol(new Map([["", 1]]), "")).toBeNull();
    expect(() => holdingPriceBySymbol(new Map(), ":")).not.toThrow();
  });

  it("prefers the exact-symbol variant over an unrelated key", () => {
    const map = new Map([
      ["MKS.L", 3.21],
      ["MKS:XLON", 9.99],
    ]);
    // Variants are ordered most-specific-first: raw uppercase then canonical.
    expect(holdingPriceBySymbol(map, "MKS:xlon")).toBe(9.99);
  });
});

describe("holdingLivePrice", () => {
  const h = (symbol: string, avg_cost: number | string) => ({ symbol, avg_cost });

  it("uses the live quote when present", () => {
    expect(holdingLivePrice(new Map([["MKS.L", 3.5]]), h("MKS:xlon", 350))).toBe(3.5);
  });

  it("falls back to the stored avg_cost when the priceMap misses", () => {
    expect(holdingLivePrice(new Map(), h("AAPL", 187.25))).toBe(187.25);
  });

  it("coerces a string avg_cost", () => {
    expect(holdingLivePrice(new Map(), h("AAPL", "187.25"))).toBe(187.25);
  });

  it("returns 0 for an unusable avg_cost instead of NaN", () => {
    expect(holdingLivePrice(new Map(), h("AAPL", "not-a-number"))).toBe(0);
  });

  it("accepts a live quote of exactly 0 (unlike holdingPriceBySymbol) because 0 is finite", () => {
    // This asymmetry is deliberate and load-bearing: the exposure buckets want
    // a real zero rather than a cost-basis guess when the venue quotes zero.
    expect(holdingLivePrice(new Map([["AAPL", 0]]), h("AAPL", 187.25))).toBe(0);
  });

  it("ignores a NaN quote and falls back to cost", () => {
    expect(holdingLivePrice(new Map([["AAPL", Number.NaN]]), h("AAPL", 187.25))).toBe(187.25);
  });
});

describe("currentPrices", () => {
  it("resolves broker-native symbols to their Yahoo key before fetching", async () => {
    getPriceOn.mockResolvedValue(400);
    const map = await currentPrices(["MKS:xlon"], "2026-08-03");
    expect(getPriceOn).toHaveBeenCalledWith("MKS.L", "2026-08-03");
    // GBX quote normalized to GBP for trading.
    expect(map.get("MKS.L")).toBe(4);
  });

  it("publishes the quote under every spelling so either lookup style hits", async () => {
    getPriceOn.mockResolvedValue(400);
    const map = await currentPrices(["MKS:xlon"], "2026-08-03");
    for (const key of ["MKS:xlon", "MKS:XLON", "mks:xlon", "MKS.L", "mks.l"]) {
      expect(map.get(key)).toBe(4);
    }
  });

  it("does not normalize non-LSE symbols", async () => {
    getPriceOn.mockResolvedValue(187.25);
    const map = await currentPrices(["AAPL:xnas"], "2026-08-03");
    expect(getPriceOn).toHaveBeenCalledWith("AAPL", "2026-08-03");
    expect(map.get("AAPL")).toBe(187.25);
  });

  it("falls back to the raw symbol when the canonical key has no quote", async () => {
    getPriceOn.mockImplementation(async (s) => (s === "MKS:xlon" ? 500 : null));
    const map = await currentPrices(["MKS:xlon"], "2026-08-03");
    expect(getPriceOn).toHaveBeenCalledWith("MKS.L", "2026-08-03");
    expect(getPriceOn).toHaveBeenCalledWith("MKS:xlon", "2026-08-03");
    expect(map.get("MKS.L")).toBe(5);
  });

  it("omits symbols with no quote entirely rather than writing a zero", async () => {
    getPriceOn.mockResolvedValue(null);
    const map = await currentPrices(["AAPL"], "2026-08-03");
    expect(map.size).toBe(0);
    expect(map.has("AAPL")).toBe(false);
  });

  it("returns an empty map for an empty symbol list without fetching", async () => {
    const map = await currentPrices([], "2026-08-03");
    expect(map.size).toBe(0);
    expect(getPriceOn).not.toHaveBeenCalled();
  });

  it("prices a mixed batch in one pass", async () => {
    getPriceOn.mockImplementation(async (s) => {
      if (s === "AAPL") return 200;
      if (s === "MKS.L") return 300;
      return null;
    });
    const map = await currentPrices(["AAPL:xnas", "MKS:xlon", "NOPE"], "2026-08-03");
    expect(map.get("AAPL")).toBe(200);
    expect(map.get("MKS.L")).toBe(3);
    expect(map.has("NOPE")).toBe(false);
  });

  it("is not order-dependent when the same canonical key appears twice", async () => {
    getPriceOn.mockResolvedValue(400);
    const map = await currentPrices(["MKS:xlon", "MKS.L"], "2026-08-03");
    expect(map.get("MKS.L")).toBe(4);
  });
});
