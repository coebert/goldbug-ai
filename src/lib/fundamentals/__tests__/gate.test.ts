import { describe, it, expect } from "vitest";
import { fundamentalsGate } from "../gate";
import type { FundamentalsScore } from "../types";

const score = (over: Partial<FundamentalsScore> = {}): FundamentalsScore => ({
  symbol: "TEST",
  score: 0.2,
  subscores: {
    valuation: 0,
    profitability: 0,
    growth: 0,
    balance_sheet: 0,
    shareholder: 0,
    analysts: 0,
  },
  coverage: 5,
  flags: [],
  summary: "ok",
  ...over,
});

describe("fundamentalsGate", () => {
  it("passes non-equity instruments untouched", () => {
    const r = fundamentalsGate({
      score: score({ score: -0.9, coverage: 6, flags: ["loss-making (negative net margin)"] }),
      assetClass: "commodity",
    });
    expect(r.block).toBeNull();
    expect(r.mult).toBe(1);
  });

  it("blocks a buy when several disclosed distress markers stack up", () => {
    const r = fundamentalsGate({
      score: score({
        score: -0.5,
        coverage: 6,
        flags: [
          "loss-making (negative net margin)",
          "negative free cash flow",
          "high leverage (debt/equity 3.2x)",
        ],
      }),
      assetClass: "stock",
      riskLevel: "balanced",
    });
    expect(r.block).toMatch(/distress markers/);
    expect(r.distress).toHaveLength(3);
  });

  it("blocks earlier for a conservative portfolio than an aggressive one", () => {
    const flags = ["loss-making (negative net margin)", "negative free cash flow"];
    const s = score({ score: -0.3, coverage: 5, flags });
    expect(fundamentalsGate({ score: s, assetClass: "stock", riskLevel: "conservative" }).block).toBeTruthy();
    expect(fundamentalsGate({ score: s, assetClass: "stock", riskLevel: "aggressive" }).block).toBeNull();
  });

  it("blocks a deeply negative, well-disclosed set of accounts on score alone", () => {
    const r = fundamentalsGate({
      score: score({ score: -0.7, coverage: 5, flags: [], summary: "weak on every pillar" }),
      assetClass: "stock",
    });
    expect(r.block).toMatch(/financials score -0\.70/);
  });

  it("haircuts rather than blocks on a single distress marker", () => {
    const r = fundamentalsGate({
      score: score({ score: -0.1, coverage: 5, flags: ["negative free cash flow"] }),
      assetClass: "stock",
    });
    expect(r.block).toBeNull();
    expect(r.mult).toBeLessThan(0.7);
    expect(r.mult).toBeGreaterThanOrEqual(0.25);
    expect(r.note).toContain("negative free cash flow");
  });

  it("sizes down for a stretched valuation without refusing the trade", () => {
    const r = fundamentalsGate({
      score: score({ score: 0.3, coverage: 5, flags: ["stretched valuation (P/E 90)"] }),
      assetClass: "stock",
    });
    expect(r.block).toBeNull();
    expect(r.mult).toBeCloseTo(0.85, 5);
  });

  it("treats no disclosure as unknown, not clean", () => {
    const r = fundamentalsGate({ score: score({ coverage: 0, score: 0 }), assetClass: "stock" });
    expect(r.mult).toBe(0.75);
    expect(r.note).toMatch(/nothing disclosed/);
  });

  it("leaves strong, well-disclosed accounts at full size", () => {
    const r = fundamentalsGate({
      score: score({ score: 0.7, coverage: 6, flags: [] }),
      assetClass: "stock",
    });
    expect(r.mult).toBe(1);
    expect(r.note).toContain("financials strong");
  });

  it("passes through when there is no scored row at all", () => {
    expect(fundamentalsGate({ score: null, assetClass: "stock" }).mult).toBe(1);
  });

  it("never returns a multiplier outside (0.25, 1]", () => {
    const r = fundamentalsGate({
      score: score({
        score: -0.55,
        coverage: 1,
        flags: ["high leverage (debt/equity 4.0x)", "stretched valuation (P/E 90)", "results due in 2d"],
      }),
      assetClass: "stock",
      riskLevel: "aggressive",
    });
    expect(r.mult).toBeGreaterThanOrEqual(0.25);
    expect(r.mult).toBeLessThanOrEqual(1);
  });

  it("is deterministic", () => {
    const s = score({ score: -0.2, coverage: 4, flags: ["revenue shrinking 12%"] });
    expect(fundamentalsGate({ score: s, assetClass: "stock" })).toEqual(
      fundamentalsGate({ score: s, assetClass: "stock" }),
    );
  });
});
