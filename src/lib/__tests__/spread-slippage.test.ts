import { describe, it, expect } from "vitest";
import {
  estimateSpreadSlippage,
  maxNotionalForImpactCap,
  BASE_SPREAD_BPS_BY_CLASS,
  VENUE_SPREAD_MULT,
  DEFAULT_TUNING,
} from "@/lib/spread-slippage";
import { applyBuyExecution, applySellExecution } from "@/lib/execution-realism.server";

describe("spread-slippage — decomposition", () => {
  it("uses per-asset-class base spread scaled by venue currency", () => {
    const usEtf = estimateSpreadSlippage({
      assetClass: "etf", currency: "USD",
      notional: 0, adv20d: 0, atrPct: 0,
    });
    const ukStock = estimateSpreadSlippage({
      assetClass: "stock", currency: "GBP",
      notional: 0, adv20d: 0, atrPct: 0,
    });
    expect(usEtf.halfSpreadBps).toBeCloseTo(BASE_SPREAD_BPS_BY_CLASS.etf * VENUE_SPREAD_MULT.USD / 2, 6);
    expect(ukStock.halfSpreadBps).toBeCloseTo(BASE_SPREAD_BPS_BY_CLASS.stock * VENUE_SPREAD_MULT.GBP / 2, 6);
    expect(ukStock.halfSpreadBps).toBeGreaterThan(usEtf.halfSpreadBps);
  });

  it("widens the half-spread in volatile regimes", () => {
    const calm = estimateSpreadSlippage({
      assetClass: "stock", currency: "USD", atrPct: 0.005, notional: 0, adv20d: 0,
    });
    const stormy = estimateSpreadSlippage({
      assetClass: "stock", currency: "USD", atrPct: 0.05, notional: 0, adv20d: 0,
    });
    expect(stormy.halfSpreadBps).toBeGreaterThan(calm.halfSpreadBps);
  });

  it("market impact grows monotonically with participation (sqrt law)", () => {
    const base = { assetClass: "stock" as const, currency: "USD", atrPct: 0.02, adv20d: 1_000_000 };
    const small = estimateSpreadSlippage({ ...base, notional: 1_000 });
    const mid   = estimateSpreadSlippage({ ...base, notional: 10_000 });
    const big   = estimateSpreadSlippage({ ...base, notional: 100_000 });
    expect(small.impactBps).toBeLessThan(mid.impactBps);
    expect(mid.impactBps).toBeLessThan(big.impactBps);
    // sqrt-law: 100x notional → ~10x impact (allow slack for tuning & caps).
    expect(big.impactBps / small.impactBps).toBeGreaterThan(5);
  });

  it("returns zero impact when ADV is unknown", () => {
    const b = estimateSpreadSlippage({
      assetClass: "stock", currency: "USD", atrPct: 0.02,
      notional: 10_000, adv20d: 0,
    });
    expect(b.impactBps).toBe(0);
    expect(b.participation).toBe(0);
  });

  it("urgency shifts the total cost in the expected direction", () => {
    const args = {
      assetClass: "stock" as const, currency: "USD", atrPct: 0.02,
      notional: 10_000, adv20d: 1_000_000,
    };
    const passive   = estimateSpreadSlippage({ ...args, urgency: "passive" });
    const normal    = estimateSpreadSlippage({ ...args, urgency: "normal" });
    const aggressive= estimateSpreadSlippage({ ...args, urgency: "aggressive" });
    expect(passive.totalBps).toBeLessThan(normal.totalBps);
    expect(normal.totalBps).toBeLessThan(aggressive.totalBps);
  });

  it("clamps half-spread and impact at configured maxima", () => {
    const b = estimateSpreadSlippage({
      assetClass: "crypto", currency: "USD", atrPct: 2, // 200% ATR → huge
      notional: 10_000_000, adv20d: 1,
    });
    expect(b.halfSpreadBps).toBeLessThanOrEqual(DEFAULT_TUNING.max_half_spread_bps);
    expect(b.impactBps).toBeLessThanOrEqual(DEFAULT_TUNING.max_impact_bps);
  });

  it("maxNotionalForImpactCap is the inverse of the sqrt-impact model", () => {
    const cap = 15;
    const N = maxNotionalForImpactCap({ adv20d: 2_000_000, atrPct: 0.02, maxImpactBps: cap });
    const b = estimateSpreadSlippage({
      assetClass: "stock", currency: "USD", atrPct: 0.02,
      notional: N, adv20d: 2_000_000,
    });
    expect(b.impactBps).toBeCloseTo(cap, 1);
  });
});

describe("execution-realism — integration with spread-slippage model", () => {
  it("bigger BUYs cross a wider price than smaller ones (same ADV)", () => {
    const common = {
      price: 100, atrPct: 0.02, adv20d: 1_000_000,
      assetClass: "stock" as const, currency: "USD",
    };
    const small = applyBuyExecution({ ...common, requestedSpend: 1_000 });
    const big   = applyBuyExecution({ ...common, requestedSpend: 200_000 });
    expect(big.fillPrice).toBeGreaterThan(small.fillPrice);
    expect(big.spreadSlippage!.impactBps).toBeGreaterThan(small.spreadSlippage!.impactBps);
  });

  it("SELLs receive symmetric adverse pricing under the same conditions", () => {
    // Stay well under the 1% ADV liquidity cap so buy/sell compare apples-to-apples.
    const buy = applyBuyExecution({
      requestedSpend: 5_000, price: 100, atrPct: 0.02, adv20d: 1_000_000,
      assetClass: "stock", currency: "USD",
    });
    const sell = applySellExecution({
      qty: 50, price: 100, atrPct: 0.02, adv20d: 1_000_000,
      assetClass: "stock", currency: "USD",
    });
    const buyBps = (buy.fillPrice / 100 - 1) * 10_000;
    const sellBps = (1 - sell.fillPrice / 100) * 10_000;
    expect(buyBps).toBeGreaterThan(0);
    expect(sellBps).toBeGreaterThan(0);
    expect(Math.abs(buyBps - sellBps)).toBeLessThan(0.5);
  });

  it("attaches a spread/slippage breakdown for TCA attribution", () => {
    const buy = applyBuyExecution({
      requestedSpend: 5_000, price: 50, atrPct: 0.015, adv20d: 500_000,
      assetClass: "etf", currency: "GBP",
    });
    expect(buy.spreadSlippage).toBeDefined();
    const b = buy.spreadSlippage!;
    expect(b.halfSpreadBps).toBeGreaterThan(0);
    expect(b.latencyBps).toBeGreaterThanOrEqual(0);
    expect(b.impactBps).toBeGreaterThanOrEqual(0);
    expect(b.totalBps).toBeCloseTo(
      Math.max(8, b.halfSpreadBps + b.latencyBps + b.impactBps + b.urgencyBps),
      6,
    );
  });

  it("legacy path (use_microstructure_model=false) preserves ATR-fraction math", () => {
    const legacy = applyBuyExecution({
      requestedSpend: 10_000, price: 100, atrPct: 0.02, adv20d: 1_000_000,
      params: { use_microstructure_model: false, spread_atr_frac: 0.25, slippage_bps: 8 },
    });
    // Expected legacy fill: 100 * (1 + 0.02*0.25 + 8bps) = 100 * (1 + 0.005 + 0.0008).
    expect(legacy.fillPrice).toBeCloseTo(100 * (1 + 0.005 + 0.0008), 6);
    expect(legacy.spreadSlippage).toBeUndefined();
  });
});
