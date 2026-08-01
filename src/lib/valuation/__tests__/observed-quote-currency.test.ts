import { describe, expect, it, vi } from "vitest";
import {
  canonicalQuoteCurrency,
  detectUnitFlip,
  isMinorUnitCurrency,
  loadObservedQuoteCurrencies,
  majorOf,
  recordObservedQuoteCurrency,
} from "../observed-quote-currency";

describe("canonicalQuoteCurrency", () => {
  it("preserves the pence/pounds distinction Yahoo signals by casing", () => {
    expect(canonicalQuoteCurrency("GBp")).toBe("GBX");
    expect(canonicalQuoteCurrency("GBP")).toBe("GBP");
    expect(canonicalQuoteCurrency("gbx")).toBe("GBX");
    expect(canonicalQuoteCurrency("usd")).toBe("USD");
    expect(canonicalQuoteCurrency("")).toBe("");
    expect(canonicalQuoteCurrency(null)).toBe("");
  });

  it("classifies minor units and maps them to their major currency", () => {
    expect(isMinorUnitCurrency("GBp")).toBe(true);
    expect(isMinorUnitCurrency("GBP")).toBe(false);
    expect(isMinorUnitCurrency("ZAc")).toBe(true);
    expect(majorOf("GBp")).toBe("GBP");
    expect(majorOf("ZAc")).toBe("ZAR");
    expect(majorOf("ILa")).toBe("ILS");
    expect(majorOf("USD")).toBe("USD");
  });
});

function fakeClient(rows: Array<{ symbol: string; quote_currency: string }> = []) {
  const upserts: any[] = [];
  const client = {
    from: () => ({
      upsert: async (row: any) => {
        upserts.push(row);
        return { error: null };
      },
      select: () => ({
        in: async (_col: string, syms: string[]) => ({
          data: rows.filter((r) => syms.includes(r.symbol)),
          error: null,
        }),
      }),
    }),
  };
  return { client, upserts };
}

describe("recordObservedQuoteCurrency", () => {
  it("stores the canonicalised currency against an upper-cased symbol", async () => {
    const { client, upserts } = fakeClient();
    await recordObservedQuoteCurrency(client, {
      symbol: " mks.l ",
      quoteCurrency: "GBp",
      samplePrice: 350,
      source: "yahoo",
    });
    expect(upserts[0]).toMatchObject({ symbol: "MKS.L", quote_currency: "GBX", sample_price: 350 });
  });

  it("ignores blank input and never throws when the write fails", async () => {
    const { client, upserts } = fakeClient();
    await recordObservedQuoteCurrency(client, { symbol: "", quoteCurrency: "GBP" });
    expect(upserts).toHaveLength(0);

    const throwing = { from: () => ({ upsert: () => { throw new Error("db down"); } }) };
    await expect(
      recordObservedQuoteCurrency(throwing as never, { symbol: "AAPL", quoteCurrency: "USD" }),
    ).resolves.toBeUndefined();
  });
});

describe("loadObservedQuoteCurrencies", () => {
  it("returns a case-insensitive lookup and null for unseen symbols", async () => {
    const { client } = fakeClient([
      { symbol: "MKS.L", quote_currency: "GBX" },
      { symbol: "AAPL", quote_currency: "USD" },
    ]);
    const lookup = await loadObservedQuoteCurrencies(client, ["mks.l", "AAPL", "TSLA"]);
    expect(lookup("MKS.L")).toBe("GBX");
    expect(lookup("aapl")).toBe("USD");
    expect(lookup("TSLA")).toBeNull();
  });

  it("degrades to the heuristic when the query fails", async () => {
    const broken = { from: () => ({ select: () => ({ in: () => { throw new Error("nope"); } }) }) };
    const lookup = await loadObservedQuoteCurrencies(broken as never, ["AAPL"]);
    expect(lookup("AAPL")).toBeNull();
  });
});

describe("detectUnitFlip", () => {
  it("flags a 100x jump as a unit flip, not a market move", () => {
    const flip = detectUnitFlip("MKS.L", 35_000, [350, 352, 348, 351]);
    expect(flip?.direction).toBe("inflated");
    expect(flip?.ratio).toBeGreaterThan(90);
  });

  it("flags a 100x collapse too", () => {
    expect(detectUnitFlip("MKS.L", 3.5, [350, 352, 348, 351])?.direction).toBe("deflated");
  });

  it("does not flag ordinary volatility, even a crash or a 10x", () => {
    expect(detectUnitFlip("AAPL", 120, [200, 205, 198, 202])).toBeNull();
    expect(detectUnitFlip("AAPL", 2_000, [200, 205, 198, 202])).toBeNull();
    expect(detectUnitFlip("AAPL", 20, [200, 205, 198, 202])).toBeNull();
  });

  it("stays silent without enough history or with junk input", () => {
    expect(detectUnitFlip("AAPL", 35_000, [350])).toBeNull();
    expect(detectUnitFlip("AAPL", Number.NaN, [350, 352, 348])).toBeNull();
    expect(detectUnitFlip("AAPL", 0, [350, 352, 348])).toBeNull();
    expect(detectUnitFlip("AAPL", 35_000, [0, -1, Number.NaN])).toBeNull();
  });
});
