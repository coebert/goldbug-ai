import { describe, expect, it } from "vitest";
import { marketRegion } from "../market-region";
import { marketCapUsd, scaleTier, scaleBonus } from "../quality-scale";
import { earningsThresholdsFor } from "../events/region-thresholds";
import { earningsGate } from "../events/earnings-gate";
import { scoreAnalysts, scoreShareholder } from "../fundamentals/score";
import type { Fundamentals } from "../fundamentals/types";

const base = (over: Partial<Fundamentals>): Fundamentals =>
  ({ symbol: "X", ...over }) as Fundamentals;

describe("market region", () => {
  it("classifies venues", () => {
    expect(marketRegion("AAPL")).toBe("us");
    expect(marketRegion("SAP.DE")).toBe("europe");
    expect(marketRegion("ASML:XAMS")).toBe("europe");
    expect(marketRegion("7203.T")).toBe("japan");
    expect(marketRegion("VWRL.L")).toBe("uk");
  });
});

describe("currency-normalised scale", () => {
  it("bands a yen-reported mega cap correctly", () => {
    // Toyota: ~40 trillion JPY ≈ $268bn.
    expect(scaleTier(40e12, "JPY")).toBe("mega");
    // A 300bn JPY (~$2bn) small cap must not look large.
    expect(scaleTier(300e9, "JPY")).toBe("small");
  });

  it("bands euro reporters above their raw number", () => {
    expect(marketCapUsd(100e9, "EUR")).toBeCloseTo(108e9, -8);
    expect(scaleTier(190e9, "EUR")).toBe("mega");
    expect(scaleBonus(190e9, "EUR")).toBeGreaterThan(scaleBonus(190e9, "USD"));
  });

  it("treats unknown currency as USD", () => {
    expect(scaleTier(60e9, null)).toBe("large");
  });
});

describe("region-aware event thresholds", () => {
  it("tightens the blackout outside the US", () => {
    expect(earningsThresholdsFor("AAPL")).toMatchObject({ vetoDays: 2, haircutDays: 5 });
    expect(earningsThresholdsFor("7203.T")).toMatchObject({ vetoDays: 1, haircutDays: 2 });
    expect(earningsThresholdsFor("SAP.DE")).toMatchObject({ vetoDays: 1, haircutDays: 3 });
  });

  it("lets a Japanese buy through 4 days ahead of a print", () => {
    const t = earningsThresholdsFor("7203.T");
    const g = earningsGate({
      side: "buy",
      asOf: "2026-09-11",
      nextEarningsDate: "2026-09-15",
      confidence: "estimated",
      vetoDays: t.vetoDays,
      haircutDays: t.haircutDays,
    });
    expect(g.veto).toBe(false);
    expect(g.mult).toBe(1);
  });

  it("still vetoes a confirmed US print inside the window", () => {
    const g = earningsGate({
      side: "buy",
      asOf: "2026-09-11",
      nextEarningsDate: "2026-09-12",
      confidence: "confirmed",
    });
    expect(g.veto).toBe(true);
  });
});

describe("regional pillar conventions", () => {
  it("keeps the analyst pillar alive on two-analyst European coverage", () => {
    const f = base({ analyst_mean: 2, analyst_count: 2 });
    expect(scoreAnalysts(f, "us")).toBeNull();
    expect(scoreAnalysts(f, "europe")).not.toBeNull();
  });

  it("does not punish a high but covered European payout", () => {
    const f = base({ dividend_yield: 0.05, payout_ratio: 0.9 });
    expect(scoreShareholder(f, "europe")!).toBeGreaterThan(scoreShareholder(f, "us")!);
  });
});
