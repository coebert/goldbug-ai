import { describe, expect, it } from "vitest";
import {
  buildTradeExplanation,
  classifySignal,
  confidenceLabel,
  detectUnitsUnresolved,
} from "../trade-explanation";
import type { AuditEntry } from "../audit-log";

const base: Pick<
  AuditEntry,
  | "symbol" | "side" | "status" | "quantity" | "value" | "price" | "reason"
  | "rejectedReason" | "conviction" | "signalWeights" | "newsFactors"
> = {
  symbol: "AAPL",
  side: "buy",
  status: "executed",
  quantity: 10,
  value: 1000,
  price: 100,
  reason: "momentum continuation",
  rejectedReason: null,
  conviction: 0.72,
  signalWeights: { trend_score: 0.6, news_sentiment: 0.2 },
  newsFactors: [],
};

describe("classifySignal", () => {
  it("splits trend vs event families", () => {
    expect(classifySignal("trend_score")).toBe("trend");
    expect(classifySignal("rsi_14")).toBe("trend");
    expect(classifySignal("news_sentiment")).toBe("event");
    expect(classifySignal("exec_post_nudge")).toBe("event");
    expect(classifySignal("liquidity")).toBe("other");
  });
});

describe("confidenceLabel", () => {
  it("buckets conviction", () => {
    expect(confidenceLabel(0.1)).toBe("low");
    expect(confidenceLabel(0.5)).toBe("moderate");
    expect(confidenceLabel(0.9)).toBe("high");
  });
});

describe("buildTradeExplanation", () => {
  it("attributes a trend-dominated order", () => {
    const x = buildTradeExplanation(base);
    expect(x.driver).toBe("trend-led");
    expect(x.trendShare).toBeCloseTo(0.75, 5);
    expect(x.eventShare).toBeCloseTo(0.25, 5);
    expect(x.confidence.label).toBe("high");
    expect(x.headline).toContain("buy AAPL");
  });

  it("attributes an event-dominated order", () => {
    const x = buildTradeExplanation({
      ...base,
      signalWeights: { trend_score: 0.1, news_sentiment: 0.8, macro_regime: 0.2 },
    });
    expect(x.driver).toBe("event-led");
    expect(x.eventSignals.map((s) => s.key)).toContain("news_sentiment");
  });

  it("marks balanced attribution when shares are close", () => {
    const x = buildTradeExplanation({
      ...base,
      signalWeights: { trend_score: 0.5, news_sentiment: 0.5 },
    });
    expect(x.driver).toBe("balanced");
  });

  it("handles missing weights and conviction", () => {
    const x = buildTradeExplanation({ ...base, signalWeights: null, conviction: null });
    expect(x.driver).toBe("unattributed");
    expect(x.confidence.label).toBeNull();
    expect(x.bullets.join(" ")).toContain("cannot be attributed");
  });

  it("counts aligned and opposing headlines as confidence drivers", () => {
    const x = buildTradeExplanation({
      ...base,
      newsFactors: [
        { headline: "AAPL beats", source: "R", sentiment: 0.5, alignment: "aligned" },
        { headline: "AAPL sued", source: "R", sentiment: -0.5, alignment: "opposing" },
      ],
    });
    expect(x.confidence.drivers.join(" ")).toMatch(/supporting the buy/);
    expect(x.confidence.drivers.join(" ")).toMatch(/other way/);
  });

  it("explains a blocked order", () => {
    const x = buildTradeExplanation({
      ...base,
      status: "rejected",
      rejectedReason: "cash floor breached",
    });
    expect(x.headline).toContain("blocked before it reached the broker");
    expect(x.bullets.join(" ")).toContain("cash floor breached");
  });
});

describe("units-unresolved withholding", () => {
  it("detects unresolved units from recorded text", () => {
    const r = detectUnitsUnresolved({ rejectedReason: "unresolved_quote_units for MKS:xlon" });
    expect(r.withheld).toBe(true);
    expect(r.reason).toMatch(/pence vs pounds/);
  });

  it("does not withhold for ordinary reasons", () => {
    expect(detectUnitsUnresolved({ rejectedReason: "cash floor" }).withheld).toBe(false);
  });

  it("honours an explicit override flag", () => {
    const x = buildTradeExplanation({ ...base, symbol: "MKS:xlon" }, { unitsUnresolved: true });
    expect(x.withheldValue.withheld).toBe(true);
    expect(x.bullets.some((b) => /withheld|pence vs pounds/i.test(b))).toBe(true);
  });

  it("surfaces the unit reason via the entry text path", () => {
    const x = buildTradeExplanation({
      ...base,
      symbol: "HSBA:xlon",
      status: "rejected",
      rejectedReason: "units unknown — GBX vs GBP cannot be decided",
    });
    expect(x.withheldValue.withheld).toBe(true);
  });
});
