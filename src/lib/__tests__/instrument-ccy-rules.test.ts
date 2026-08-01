import { describe, expect, it } from "vitest";
import {
  instrumentCcyFor,
  normalizeInstrumentCcy,
  tagRowCurrency,
  tagRowsCurrency,
  venueCurrency,
} from "../instrument-ccy-rules";

describe("venueCurrency", () => {
  it("reads MIC suffixes", () => {
    expect(venueCurrency("JNJ:xnys")).toEqual({ currency: "USD", source: "mic" });
    expect(venueCurrency("ISF:xlon")).toEqual({ currency: "GBP", source: "mic" });
    expect(venueCurrency("BHP:xasx")).toEqual({ currency: "AUD", source: "mic" });
  });

  it("reads dot suffixes", () => {
    expect(venueCurrency("ISF.L")!.currency).toBe("GBP");
    expect(venueCurrency("SAP.DE")!.currency).toBe("EUR");
    expect(venueCurrency("7203.T")!.currency).toBe("JPY");
    expect(venueCurrency("SHOP.TO")!.currency).toBe("CAD");
  });

  it("reads crypto and FX pairs", () => {
    expect(venueCurrency("BTC-USD")).toEqual({ currency: "USD", source: "pair" });
    expect(venueCurrency("ETH-EUR")!.currency).toBe("EUR");
    expect(venueCurrency("GBPUSD=X")!.currency).toBe("USD");
  });

  it("recognises bare US roots", () => {
    expect(venueCurrency("AAPL")).toEqual({ currency: "USD", source: "known_root" });
    expect(venueCurrency("VTI")!.currency).toBe("USD");
  });

  it("says nothing for unknown bare symbols", () => {
    expect(venueCurrency("WEIRDCO")).toBeNull();
    expect(venueCurrency("")).toBeNull();
  });
});

describe("normalizeInstrumentCcy", () => {
  it("overrides a base-currency tag that would skip FX", () => {
    const r = normalizeInstrumentCcy("JNJ:xnys", "GBP");
    expect(r.currency).toBe("USD");
    expect(r.corrected).toBe(true);
    expect(r.reason).toContain("USD");
  });

  it("leaves a correct tag alone", () => {
    const r = normalizeInstrumentCcy("JNJ:xnys", "USD");
    expect(r.corrected).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("never stores GBX as a currency", () => {
    expect(normalizeInstrumentCcy("ISF.L", "GBX").currency).toBe("GBP");
    expect(normalizeInstrumentCcy("MYSTERY", "GBX").currency).toBe("GBP");
    expect(normalizeInstrumentCcy("MYSTERY", "GBX").corrected).toBe(true);
  });

  it("fills in a missing tag from the venue", () => {
    const r = normalizeInstrumentCcy("SAP.DE", null);
    expect(r.currency).toBe("EUR");
    expect(r.source).toBe("suffix");
    expect(r.corrected).toBe(true);
  });

  it("keeps a declared currency when the symbol says nothing", () => {
    const r = normalizeInstrumentCcy("WEIRDCO", "CHF");
    expect(r).toMatchObject({ currency: "CHF", source: "declared", corrected: false });
  });

  it("falls back to the supplied default when nothing is known", () => {
    expect(normalizeInstrumentCcy("WEIRDCO", null, { defaultCcy: "GBP" }).currency).toBe("GBP");
    expect(normalizeInstrumentCcy("WEIRDCO", null).currency).toBe("USD");
  });

  it("ignores junk tags", () => {
    expect(instrumentCcyFor("JNJ:xnys", "  ")).toBe("USD");
    expect(instrumentCcyFor("WEIRDCO", "x", "EUR")).toBe("EUR");
  });

  it("is idempotent", () => {
    const once = instrumentCcyFor("ISF.L", "GBX");
    expect(instrumentCcyFor("ISF.L", once)).toBe(once);
  });
});

describe("row tagging", () => {
  it("tags a single row without mutating the input", () => {
    const row = { symbol: "V:xnys", instrument_ccy: "GBP", quantity: 3 };
    const out = tagRowCurrency(row);
    expect(out.instrument_ccy).toBe("USD");
    expect(row.instrument_ccy).toBe("GBP");
    expect(out.quantity).toBe(3);
  });

  it("reports every correction in a batch", () => {
    const { rows, corrections } = tagRowsCurrency([
      { symbol: "JPM", instrument_ccy: "GBP" },
      { symbol: "ISF.L", instrument_ccy: "GBP" },
      { symbol: "VTI", instrument_ccy: null },
    ]);
    expect(rows.map((r) => r.instrument_ccy)).toEqual(["USD", "GBP", "USD"]);
    expect(corrections.map((c) => c.symbol)).toEqual(["JPM", "VTI"]);
    expect(corrections[0]).toMatchObject({ from: "GBP", to: "USD" });
  });

  it("re-running the batch produces no further corrections", () => {
    const first = tagRowsCurrency([{ symbol: "JPM", instrument_ccy: "GBP" }]);
    const second = tagRowsCurrency(first.rows);
    expect(second.corrections).toEqual([]);
  });
});
