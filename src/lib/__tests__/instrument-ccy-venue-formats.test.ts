import { describe, expect, it } from "vitest";
import { venueCurrency, normalizeInstrumentCcy } from "../instrument-ccy-rules";
import { planInstrumentCcyFixes } from "../instrument-ccy-fix";
import type { InstrumentCcyFinding } from "../instrument-ccy-check";

describe("venueCurrency — extended MIC coverage", () => {
  const cases: [string, string][] = [
    ["005930:xkrx", "KRW"],
    ["2330:xtai", "TWD"],
    ["600519:xshg", "CNY"],
    ["RELIANCE:xnse", "INR"],
    ["CBA:xasx", "AUD"],
    ["NESN:xswx", "CHF"],
    ["SAP:xetr", "EUR"],
    ["CPI:xwar", "PLN"],
    ["AAPL:xngs", "USD"],
    ["SHOP:neoe", "CAD"],
    ["WALMEX:xmex", "MXN"],
    ["NPN:xjse", "ZAR"],
    ["2222:xsau", "SAR"],
    ["EMAAR:xdfm", "AED"],
  ];
  it.each(cases)("%s → %s", (symbol, ccy) => {
    expect(venueCurrency(symbol)).toEqual({ currency: ccy, source: "mic" });
  });

  it("accepts the MIC on either side and with any separator", () => {
    for (const s of ["XLON:MKS", "MKS.XLON", "XLON/MKS", "MKS:XLON"]) {
      expect(venueCurrency(s)).toEqual({ currency: "GBP", source: "mic" });
    }
  });
});

describe("venueCurrency — extended exchange suffixes", () => {
  const cases: [string, string][] = [
    ["SAP.DE", "EUR"],
    ["NESN.SW", "CHF"],
    ["SHOP.TO", "CAD"],
    ["BHP.AX", "AUD"],
    ["7203.T", "JPY"],
    ["0700.HK", "HKD"],
    ["600519.SS", "CNY"],
    ["000001.SZ", "CNY"],
    ["005930.KS", "KRW"],
    ["2330.TW", "TWD"],
    ["CBK.WA", "PLN"],
    ["CEZ.PR", "CZK"],
    ["OTP.BD", "HUF"],
    ["THYAO.IS", "TRY"],
    ["BBCA.JK", "IDR"],
    ["PTT.BK", "THB"],
    ["MAYBANK.KL", "MYR"],
    ["SM.PS", "PHP"],
    ["WALMEX.MX", "MXN"],
    ["YPFD.BA", "ARS"],
    ["OPK.TA", "ILS"],
    ["ETEL.CA", "EGP"],
  ];
  it.each(cases)("%s → %s", (symbol, ccy) => {
    expect(venueCurrency(symbol)?.currency).toBe(ccy);
  });

  it("keeps the existing LSE and depositary rules", () => {
    expect(venueCurrency("ISF.L")).toEqual({ currency: "GBP", source: "suffix" });
    expect(venueCurrency("BP.IL")).toEqual({ currency: "USD", source: "suffix" });
  });
});

describe("venueCurrency — Bloomberg composite codes", () => {
  it.each([
    ["VOD LN Equity", "GBP"],
    ["AAPL US Equity", "USD"],
    ["SAP GY", "EUR"],
    ["NESN SW", "CHF"],
    ["7203 JT Equity", "JPY"],
    ["BHP AU", "AUD"],
    ["SHOP CT", "CAD"],
  ])("%s → %s", (symbol, ccy) => {
    expect(venueCurrency(symbol)).toEqual({ currency: ccy, source: "composite" });
  });
});

describe("venueCurrency — pairs and class shares", () => {
  it.each([
    ["BTC-USD", "USD"],
    ["BTC/USDT", "USD"],
    ["ETH-GBP", "GBP"],
    ["GBPUSD=X", "USD"],
    ["GBPUSD", "USD"],
    ["EURCHF", "CHF"],
  ])("%s → %s", (symbol, ccy) => {
    expect(venueCurrency(symbol)).toEqual({ currency: ccy, source: "pair" });
  });

  it("resolves US class shares such as BRK.B", () => {
    expect(venueCurrency("BRK.B")).toEqual({ currency: "USD", source: "known_root" });
  });

  it("still returns null for a symbol with no venue information", () => {
    expect(venueCurrency("ZZZQQ")).toBeNull();
  });
});

describe("normalizeInstrumentCcy with the extended rules", () => {
  it("corrects a Tokyo listing wrongly tagged GBP", () => {
    const r = normalizeInstrumentCcy("7203.T", "GBP");
    expect(r.currency).toBe("JPY");
    expect(r.corrected).toBe(true);
  });

  it("corrects a Bloomberg-form US listing tagged GBP", () => {
    expect(normalizeInstrumentCcy("AAPL US Equity", "GBP").currency).toBe("USD");
  });
});

function finding(symbol: string, declared: string | null): InstrumentCcyFinding {
  return {
    symbol,
    declared_ccy: declared,
    issues: [{ code: "venue_mismatch", message: "mismatch" }],
    value_base: 100,
    value_base_declared: 130,
  } as unknown as InstrumentCcyFinding;
}

describe("planInstrumentCcyFixes covers the new venue formats", () => {
  it("auto-fixes MIC, suffix and composite forms", () => {
    const plan = planInstrumentCcyFixes([
      finding("005930.KS", "GBP"),
      finding("NESN:xswx", "USD"),
      finding("VOD LN Equity", "USD"),
      finding("ZZZQQ", "GBP"),
    ]);
    expect(plan.fixes.map((f) => [f.symbol, f.to_ccy])).toEqual([
      ["005930.KS", "KRW"],
      ["NESN:xswx", "CHF"],
      ["VOD LN Equity", "GBP"],
    ]);
    expect(plan.skipped.map((s) => s.symbol)).toEqual(["ZZZQQ"]);
  });
});
