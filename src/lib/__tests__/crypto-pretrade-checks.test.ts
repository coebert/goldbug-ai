// Unit tests for the crypto post-sizing pre-trade gate:
// fee %, whole-unit lot size, minimum notional and venue market hours.

import { describe, it, expect } from "vitest";
import {
  runCryptoPreTradeChecks,
  isCryptoEtpVenueOpen,
  sessionForCryptoEtp,
  estimateCryptoEtpFeeLocal,
  CRYPTO_PRETRADE_CONFIG,
} from "../crypto-validation.server";

// A Wednesday 11:00 in each venue's local timezone — well inside all three
// continuous-auction windows (XETRA/SIX/LSE).
const WED_LOCAL_11 = new Date("2026-01-14T10:00:00Z"); // 11:00 CET / 10:00 UTC

describe("sessionForCryptoEtp", () => {
  it("maps each approved ETP suffix to its venue", () => {
    expect(sessionForCryptoEtp("BTCE.DE")?.label).toBe("XETRA");
    expect(sessionForCryptoEtp("ZETH.DE")?.label).toBe("XETRA");
    expect(sessionForCryptoEtp("ABTC.SW")?.label).toBe("SIX");
    expect(sessionForCryptoEtp("ZETH.SW")?.label).toBe("SIX");
    expect(sessionForCryptoEtp("HODL.SW")?.label).toBe("SIX");
    expect(sessionForCryptoEtp("BTCW.L")?.label).toBe("LSE");
  });
  it("returns null for unknown suffixes", () => {
    expect(sessionForCryptoEtp("AAPL")).toBeNull();
  });
});

describe("isCryptoEtpVenueOpen", () => {
  it("open mid-session on a weekday", () => {
    expect(isCryptoEtpVenueOpen("BTCE.DE", WED_LOCAL_11).open).toBe(true);
    expect(isCryptoEtpVenueOpen("BTCW.L",  WED_LOCAL_11).open).toBe(true);
    expect(isCryptoEtpVenueOpen("ZETH.SW", WED_LOCAL_11).open).toBe(true);
  });
  it("closed on weekends for every ETP venue", () => {
    const sat = new Date("2026-01-17T11:00:00Z"); // Saturday
    for (const sym of ["BTCE.DE", "ABTC.SW", "BTCW.L", "ZETH.SW", "ZETH.DE", "HODL.SW"]) {
      const r = isCryptoEtpVenueOpen(sym, sat);
      expect(r.open, `${sym} should be closed on Saturday`).toBe(false);
      expect(r.reason).toMatch(/weekend/i);
    }
  });
  it("closed outside the auction window (03:00 local)", () => {
    const preOpen = new Date("2026-01-14T02:00:00Z"); // 03:00 CET, before XETRA opens
    const r = isCryptoEtpVenueOpen("BTCE.DE", preOpen);
    expect(r.open).toBe(false);
    expect(r.reason).toMatch(/outside regular session/i);
  });
});

describe("estimateCryptoEtpFeeLocal", () => {
  it("floors at the per-order minimum on tiny notionals", () => {
    expect(estimateCryptoEtpFeeLocal(100)).toBe(CRYPTO_PRETRADE_CONFIG.estimated_fee_min_local);
  });
  it("scales linearly above the floor", () => {
    // 100_000 * 0.10% = 100 which is > the 5 floor.
    expect(estimateCryptoEtpFeeLocal(100_000)).toBeCloseTo(100, 6);
  });
});

describe("runCryptoPreTradeChecks — buy path", () => {
  const base = { symbol: "BTCE.DE", side: "buy" as const, now: WED_LOCAL_11 };

  it("passes a well-sized whole-unit order in session", () => {
    const r = runCryptoPreTradeChecks({ ...base, price: 40, quantity: 25 }); // 1,000 EUR
    expect(r.ok).toBe(true);
    expect(r.venue).toBe("XETRA");
    expect(r.feePct).toBeLessThan(CRYPTO_PRETRADE_CONFIG.max_fee_pct);
  });

  it("rejects fractional quantities (lot_size gate)", () => {
    const r = runCryptoPreTradeChecks({ ...base, price: 40, quantity: 2.5 });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe("lot_size");
    expect(r.reason).toMatch(/whole unit|lot size/i);
  });

  it("rejects zero / negative quantities", () => {
    const r = runCryptoPreTradeChecks({ ...base, price: 40, quantity: 0 });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe("lot_size");
  });

  it("rejects sub-minimum notional even with a valid lot", () => {
    // 1 * 40 = 40 EUR, below the 100 EUR floor.
    const r = runCryptoPreTradeChecks({ ...base, price: 40, quantity: 1 });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe("min_notional");
    expect(r.reason).toMatch(/below venue minimum/);
  });

  it("rejects fee-heavy dust orders (fee gate)", () => {
    // Force a giant fee via override; notional is comfortably above min.
    const r = runCryptoPreTradeChecks({
      ...base, price: 40, quantity: 5,        // 200 EUR notional
      brokerFeeLocal: 50,                     // 25% fee — absurd
    });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe("fee");
    expect(r.reason).toMatch(/fee/);
  });

  it("rejects orders outside venue trading hours", () => {
    const sat = new Date("2026-01-17T11:00:00Z");
    const r = runCryptoPreTradeChecks({ ...base, price: 40, quantity: 25, now: sat });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe("market_hours");
    expect(r.reason).toMatch(/XETRA/);
  });

  it("respects config overrides so risk levels can widen/tighten thresholds", () => {
    // Notional 500 EUR passes the tightened floor, and fee floor (5) is
    // well inside the max_fee_pct cap.
    const r = runCryptoPreTradeChecks({
      ...base, price: 50, quantity: 10,
      config: { min_order_value_local: 20 },
    });
    expect(r.ok).toBe(true);
  });
});

describe("runCryptoPreTradeChecks — sell path", () => {
  it("always allows sells, even outside hours or below min notional", () => {
    const sat = new Date("2026-01-17T11:00:00Z");
    const r = runCryptoPreTradeChecks({
      symbol: "BTCE.DE", side: "sell", price: 40, quantity: 1, now: sat,
    });
    expect(r.ok).toBe(true);
    expect(r.venue).toBe("XETRA");
  });
});
