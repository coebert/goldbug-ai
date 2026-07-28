// Contract for the automated price/unit scaling audit. The pure detector
// must catch the specific bug categories that have historically produced
// wrong tiles: GBX-vs-GBP unit-mixing, ETF classified as stock, missing
// asset_class, split/reverse-split jumps, and broken cache rows.

import { describe, it, expect } from "vitest";
import { auditHoldingScalings, type HoldingScanRow } from "@/lib/price-scaling-audit";

const base: HoldingScanRow = {
  portfolio_id: "p1",
  portfolio_name: "Real Money",
  symbol: "HSBA.L",
  asset_class: "stock",
  quantity: 100,
  avg_cost: 1500,
  latest_close: 1555.19,
  price_history: [1500, 1510, 1520, 1530, 1540, 1550, 1555],
  canonical_asset_class: "stock",
};

describe("auditHoldingScalings — clean rows produce no findings", () => {
  it("silences a healthy LSE stock in GBX", () => {
    const out = auditHoldingScalings([{ ...base }]);
    expect(out).toEqual([]);
  });

  it("silences a healthy LSE ETF in GBP", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "VUKE.L", asset_class: "etf", canonical_asset_class: "etf",
        avg_cost: 46.34, latest_close: 46.5, price_history: [45, 45.5, 46, 46.2, 46.5] },
    ]);
    expect(out).toEqual([]);
  });

  it("silences a healthy US stock", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "AAPL", asset_class: "stock", canonical_asset_class: "stock",
        avg_cost: 189.42, latest_close: 190, price_history: [185, 187, 189, 190] },
    ]);
    expect(out).toEqual([]);
  });
});

describe("auditHoldingScalings — asset-class integrity", () => {
  it("flags a missing asset_class as an error", () => {
    const out = auditHoldingScalings([{ ...base, asset_class: null }]);
    expect(out.some((f) => f.category === "asset_class_missing" && f.severity === "error")).toBe(true);
  });

  it("flags declared/canonical mismatch (VUKE.L wrongly stored as stock)", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "VUKE.L", asset_class: "stock", canonical_asset_class: "etf",
        avg_cost: 46.34, latest_close: 46.5, price_history: [46, 46.5] },
    ]);
    const hit = out.find((f) => f.category === "asset_class_mismatch");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
  });
});

describe("auditHoldingScalings — GBX/GBP envelope", () => {
  it("flags an LSE stock whose price has been double-normalised to GBP", () => {
    // HSBA.L at £15.55 instead of 1555.19p — the price is inside GBP range
    // but far below the GBX floor. Auditor must catch this.
    const out = auditHoldingScalings([
      { ...base, avg_cost: 15.5, latest_close: 15.55,
        price_history: [15.5, 15.55, 15.6] },
    ]);
    expect(out.some((f) => f.category === "lse_stock_out_of_gbx_range")).toBe(true);
  });

  it("flags an LSE ETF whose price landed in the pence range", () => {
    // VUKE.L at 4634p (raw GBX) instead of £46.34 — inside GBX but outside GBP.
    const out = auditHoldingScalings([
      { ...base, symbol: "VUKE.L", asset_class: "etf", canonical_asset_class: "etf",
        avg_cost: 4634, latest_close: 4634, price_history: [4600, 4634] },
    ]);
    expect(out.some((f) => f.category === "lse_etf_out_of_gbp_range")).toBe(true);
  });

  it("does not flag LSE stocks whose GBX price sits inside the plausible range", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "LLOY.L", avg_cost: 55, latest_close: 56,
        price_history: [54, 55, 55, 56] },
    ]);
    expect(out.filter((f) => f.category === "lse_stock_out_of_gbx_range")).toEqual([]);
  });
});

describe("auditHoldingScalings — ratio jump vs history", () => {
  it("flags a 100x jump (typical GBX row landing in a GBP cache)", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "AAPL", asset_class: "stock", canonical_asset_class: "stock",
        avg_cost: 190, latest_close: 19000,
        price_history: [188, 189, 190, 191, 192] },
    ]);
    const hit = out.find((f) => f.category === "price_ratio_jump");
    expect(hit).toBeDefined();
    expect(hit?.observed.ratio).toBeGreaterThan(20);
  });

  it("flags a reverse split (10x downward jump)", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "AAPL", asset_class: "stock", canonical_asset_class: "stock",
        avg_cost: 190, latest_close: 4.5,
        price_history: [180, 185, 190, 195, 200] },
    ]);
    // 200/4.5 = 44x, well above the 20x threshold.
    expect(out.some((f) => f.category === "price_ratio_jump")).toBe(true);
  });

  it("does not flag ordinary daily volatility", () => {
    const out = auditHoldingScalings([
      { ...base, symbol: "AAPL", asset_class: "stock", canonical_asset_class: "stock",
        avg_cost: 190, latest_close: 205,
        price_history: [180, 185, 190, 195, 200] },
    ]);
    expect(out.filter((f) => f.category === "price_ratio_jump")).toEqual([]);
  });
});

describe("auditHoldingScalings — broken feed values", () => {
  it("flags NaN prices as errors", () => {
    const out = auditHoldingScalings([{ ...base, latest_close: NaN }]);
    expect(out.some((f) => f.category === "non_finite_price" && f.severity === "error")).toBe(true);
  });

  it("flags zero and negative prices as errors", () => {
    const out = auditHoldingScalings([
      { ...base, latest_close: 0 },
      { ...base, symbol: "BP.L", latest_close: -5 },
    ]);
    expect(out.filter((f) => f.category === "non_positive_price").length).toBe(2);
  });
});

describe("auditHoldingScalings — regression: 2026-07-28 real-money tile", () => {
  it("catches VUKE.L / VMID.L if a broker re-classifies them as stock", () => {
    const rows: HoldingScanRow[] = [
      { portfolio_id: "rm", portfolio_name: "Real Money", symbol: "HSBA.L",
        asset_class: "stock", canonical_asset_class: "stock",
        quantity: 102, avg_cost: 1555.19, latest_close: 1560,
        price_history: [1500, 1520, 1540, 1560] },
      { portfolio_id: "rm", portfolio_name: "Real Money", symbol: "VMID.L",
        asset_class: "stock", canonical_asset_class: "etf",
        quantity: 4, avg_cost: 36.4425, latest_close: 36.5,
        price_history: [36, 36.2, 36.5] },
      { portfolio_id: "rm", portfolio_name: "Real Money", symbol: "VUKE.L",
        asset_class: "stock", canonical_asset_class: "etf",
        quantity: 3, avg_cost: 46.34, latest_close: 46.5,
        price_history: [46, 46.2, 46.5] },
    ];
    const out = auditHoldingScalings(rows);
    const mismatches = out.filter((f) => f.category === "asset_class_mismatch");
    expect(mismatches.map((f) => f.symbol).sort()).toEqual(["VMID.L", "VUKE.L"]);
  });
});
