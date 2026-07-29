import { describe, it, expect } from "vitest";
import {
  quoteFxCost,
  applyFxCost,
  feeInFromCcy,
  roundTripFxBps,
  summarizeRoundTripCosts,
} from "../fx-cost-model";

describe("fx-cost-model", () => {
  it("prices majors tighter than JPY/AUD crosses", () => {
    const eurUsd = quoteFxCost("EUR", "USD", "wallet");
    const gbpJpy = quoteFxCost("GBP", "JPY", "wallet");
    const gbpAud = quoteFxCost("GBP", "AUD", "wallet");
    expect(eurUsd.pairClass).toBe("major");
    expect(gbpJpy.pairClass).toBe("cross-minor");
    expect(gbpAud.pairClass).toBe("cross-minor");
    expect(gbpJpy.totalBps).toBeGreaterThan(eurUsd.totalBps);
    expect(gbpAud.totalBps).toBeGreaterThan(eurUsd.totalBps);
  });

  it("spot execution drops the wallet markup", () => {
    const wallet = quoteFxCost("GBP", "JPY", "wallet");
    const spot = quoteFxCost("GBP", "JPY", "spot");
    expect(spot.walletMarkupBps).toBe(0);
    expect(spot.totalBps).toBe(spot.spreadBps);
    expect(wallet.totalBps).toBeGreaterThan(spot.totalBps);
  });

  it("classifies unknown currencies as exotic and prices them widest", () => {
    const zar = quoteFxCost("GBP", "ZAR", "wallet");
    expect(zar.pairClass).toBe("exotic");
    expect(zar.totalBps).toBeGreaterThan(quoteFxCost("GBP", "JPY", "wallet").totalBps);
  });

  it("applyFxCost lowers the mid rate by the total bps", () => {
    const q = quoteFxCost("GBP", "JPY", "wallet"); // 8 + 32 = 40 bps
    const eff = applyFxCost(190, q);
    expect(eff).toBeCloseTo(190 * (1 - 40 / 10_000), 6);
  });

  it("feeInFromCcy respects the per-currency minimum for tiny amounts", () => {
    const { fee, quote } = feeInFromCcy(10, "GBP", "USD", "wallet");
    // 10 GBP * ~25bps = 0.025 → below the £1 floor, so it should snap up.
    expect(fee).toBeGreaterThanOrEqual(1);
    expect(quote.pairClass).toBe("major");
  });

  it("roundTripFxBps sums entry + exit costs", () => {
    const rt = roundTripFxBps("GBP", "JPY", { entry: "wallet", exit: "wallet" });
    expect(rt.totalBps).toBe(rt.entryBps + rt.exitBps);
    expect(rt.totalBps).toBeGreaterThan(50); // JPY wallet round-trip is chunky
  });

  it("summarizeRoundTripCosts skips the base currency", () => {
    const rows = summarizeRoundTripCosts("GBP", ["GBP", "USD", "JPY", "AUD"], "wallet");
    expect(rows.map((r) => r.ccy)).toEqual(["USD", "JPY", "AUD"]);
  });
});
