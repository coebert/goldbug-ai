// Regression tests for Yahoo → Saxo instrument symbol resolution.
//
// Locks in that Yahoo-suffix tickers (VUKE.L, VMID.L, SAP.DE, ...) get their
// suffix stripped for the Saxo /ref/v1/instruments keyword search and that the
// hit-selection ranker picks the correct listing venue, not a same-ticker
// listing on another exchange (US, DE, etc).
import { describe, expect, it } from "vitest";
import {
  YAHOO_SUFFIX_TO_EXCHANGE,
  normalizeSaxoSymbol,
  selectSaxoInstrument,
  type SaxoInstrumentHit,
} from "../brokers/saxo.server";

describe("normalizeSaxoSymbol", () => {
  it("strips .L suffix and returns LSE as the preferred exchange list", () => {
    const n = normalizeSaxoSymbol("VUKE.L");
    expect(n.base).toBe("VUKE");
    expect(n.suffix).toBe("L");
    expect(n.keyword).toBe("VUKE"); // NOT "VUKE.L" — Saxo returns 0 hits for that
    expect(n.preferredExchanges).toEqual(YAHOO_SUFFIX_TO_EXCHANGE.L);
    // First search keyword must be the bare ticker so we hit Saxo on attempt 1.
    expect(n.searchKeywords[0]).toBe("VUKE");
  });

  it("strips .L for VMID.L (FTSE 250 ETF)", () => {
    const n = normalizeSaxoSymbol("VMID.L");
    expect(n.base).toBe("VMID");
    expect(n.keyword).toBe("VMID");
    expect(n.preferredExchanges).toContain("LSE");
  });

  it("handles .DE suffix (Xetra)", () => {
    const n = normalizeSaxoSymbol("SAP.DE");
    expect(n.base).toBe("SAP");
    expect(n.keyword).toBe("SAP");
    expect(n.preferredExchanges).toEqual(["XETR", "FRA"]);
  });

  it("leaves suffix-less tickers alone", () => {
    const n = normalizeSaxoSymbol("AAPL");
    expect(n.base).toBe("AAPL");
    expect(n.suffix).toBe("");
    expect(n.keyword).toBe("AAPL");
    expect(n.preferredExchanges).toEqual([]);
    expect(n.searchKeywords).toEqual(["AAPL"]);
  });

  it("uppercases lowercase input", () => {
    const n = normalizeSaxoSymbol("vuke.l");
    expect(n.upper).toBe("VUKE.L");
    expect(n.base).toBe("VUKE");
    expect(n.suffix).toBe("L");
  });

  it("keeps unknown suffixes as literal keyword (no exchange preference)", () => {
    const n = normalizeSaxoSymbol("FOO.ZZ");
    // Unknown suffix => no preferred exchanges, keyword is the full upper form.
    expect(n.preferredExchanges).toEqual([]);
    expect(n.keyword).toBe("FOO.ZZ");
  });

  it("deduplicates search keywords when base equals keyword", () => {
    const n = normalizeSaxoSymbol("VUKE.L");
    // Should not repeat "VUKE" three times.
    expect(new Set(n.searchKeywords).size).toBe(n.searchKeywords.length);
  });
});

describe("selectSaxoInstrument", () => {
  it("picks LSE listing for VUKE.L over same-ticker US listings", () => {
    const hits: SaxoInstrumentHit[] = [
      // A US ETF that happens to share the VUKE base — must NOT win.
      { Identifier: 111, AssetType: "Etf", Symbol: "VUKE", ExchangeId: "NYSE_ARCA", CurrencyCode: "USD" },
      // The real one: Vanguard FTSE 100 UCITS ETF on LSE.
      { Identifier: 222, AssetType: "Etf", Symbol: "VUKE:xlon", ExchangeId: "LSE", CurrencyCode: "GBP" },
      { Identifier: 333, AssetType: "Etf", Symbol: "VUKE", ExchangeId: "XETR", CurrencyCode: "EUR" },
    ];
    const hit = selectSaxoInstrument("VUKE.L", hits);
    expect(hit?.Identifier).toBe(222);
    expect(hit?.ExchangeId).toBe("LSE");
    expect(hit?.CurrencyCode).toBe("GBP");
  });

  it("picks LSE_ETF listing for VMID.L", () => {
    const hits: SaxoInstrumentHit[] = [
      { Identifier: 900, AssetType: "Etf", Symbol: "VMID", ExchangeId: "SIX_SWX", CurrencyCode: "CHF" },
      { Identifier: 901, AssetType: "Etf", Symbol: "VMID:xlon", ExchangeId: "LSE_ETF", CurrencyCode: "GBP" },
    ];
    const hit = selectSaxoInstrument("VMID.L", hits);
    expect(hit?.Identifier).toBe(901);
    expect(hit?.ExchangeId).toBe("LSE_ETF");
  });

  it("prefers an exact Symbol match on a preferred exchange over prefix-only", () => {
    const hits: SaxoInstrumentHit[] = [
      { Identifier: 1, AssetType: "Stock", Symbol: "LLOY:xlon", ExchangeId: "LSE", CurrencyCode: "GBP" },
      { Identifier: 2, AssetType: "Stock", Symbol: "LLOY", ExchangeId: "LSE_SETSMM", CurrencyCode: "GBP" },
    ];
    const hit = selectSaxoInstrument("LLOY.L", hits);
    // Rule 1 (exact + preferred) beats rule 2 (prefix + preferred).
    expect(hit?.Identifier).toBe(2);
  });

  it("falls back to any preferred-exchange hit if no symbol match", () => {
    const hits: SaxoInstrumentHit[] = [
      { Identifier: 10, AssetType: "Etf", Symbol: "OTHER", ExchangeId: "NYSE_ARCA" },
      { Identifier: 11, AssetType: "Etf", Symbol: "SOMETHINGELSE", ExchangeId: "LSE" },
    ];
    const hit = selectSaxoInstrument("VUKE.L", hits);
    expect(hit?.Identifier).toBe(11);
  });

  it("returns undefined for an empty candidate list", () => {
    expect(selectSaxoInstrument("VUKE.L", [])).toBeUndefined();
  });

  it("falls back to first hit for suffix-less ticker with no exchange preference", () => {
    const hits: SaxoInstrumentHit[] = [
      { Identifier: 500, AssetType: "Stock", Symbol: "AAPL", ExchangeId: "NASDAQ", CurrencyCode: "USD" },
      { Identifier: 501, AssetType: "Stock", Symbol: "AAPL:arcx", ExchangeId: "NYSE_ARCA", CurrencyCode: "USD" },
    ];
    const hit = selectSaxoInstrument("AAPL", hits);
    // Rule 4: exact Symbol match (any exchange) wins over the ":arcx" variant.
    expect(hit?.Identifier).toBe(500);
  });

  it("picks XETR listing for SAP.DE over same-ticker US line", () => {
    const hits: SaxoInstrumentHit[] = [
      { Identifier: 42, AssetType: "Stock", Symbol: "SAP", ExchangeId: "NYSE", CurrencyCode: "USD" },
      { Identifier: 43, AssetType: "Stock", Symbol: "SAP", ExchangeId: "XETR", CurrencyCode: "EUR" },
    ];
    const hit = selectSaxoInstrument("SAP.DE", hits);
    expect(hit?.Identifier).toBe(43);
    expect(hit?.ExchangeId).toBe("XETR");
  });
});
