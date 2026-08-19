import { describe, expect, it } from "vitest";

import { buildTradeRationale, newsMentionsSymbol } from "../trade-rationale";

const marketInputs = {
  regime: {
    regime: "bull_quiet",
    confidence: 0.8,
    notes: "SPY > 200d MA, VIX 15.8",
  },
  sector: {
    sector: "financials",
    phase: "growing",
    note: "financials: 30d 5.8%",
    applied_multiplier: 1.1,
    strength: 0.51,
  },
  breakout: { applies: false, explanation: "Not a breakout-driven buy." },
  policy: { note: "Bailey leaned dovish", score: -0.2 },
  run_rationale: "Portfolio underinvested at 72% cash.",
};

describe("buildTradeRationale", () => {
  it("extracts signals, run context and matching events", () => {
    const r = buildTradeRationale({
      decision: {
        symbol: "MKS.L",
        action: "sell",
        decidedAt: "2026-08-19T19:01:35Z",
        rationale: "Trend broke down.",
        marketInputs,
      },
      news: [
        {
          id: "n1",
          news_date: "2026-08-18",
          headline: "MKS warns on profit",
          source: "Reuters",
          relevance_score: 80,
        },
        { id: "n2", news_date: "2026-08-18", headline: "Unrelated tech rally", source: "FT" },
      ],
      events: [
        { id: "e1", event_date: "2026-08-17", kind: "earnings", symbol: "MKS.L", title: "H1 results" },
        { id: "e2", event_date: "2026-08-17", kind: "earnings", symbol: "AAPL", title: "Apple results" },
      ],
    });

    expect(r.action).toBe("sell");
    expect(r.signals.map((s) => s.key)).toEqual(["regime", "sector", "breakout", "policy"]);
    expect(r.signals.find((s) => s.key === "policy")?.stance).toBe("cautionary");
    expect(r.events.map((e) => e.id)).toEqual(["n1", "e1"]);
    expect(r.runRationale).toContain("underinvested");
    expect(r.sparse).toBe(false);
    expect(r.headline).toContain("sold");
  });

  it("flags sparse decisions with no structured detail", () => {
    const r = buildTradeRationale({
      decision: { symbol: "SPY", action: "buy", rationale: "Top ranked." },
    });
    expect(r.sparse).toBe(true);
    expect(r.signals).toHaveLength(0);
  });

  it("matches headlines by base symbol and entities, not substrings", () => {
    expect(newsMentionsSymbol({ id: "1", news_date: "d", headline: "VOD.L slips" }, "VOD.L")).toBe(true);
    expect(newsMentionsSymbol({ id: "1", news_date: "d", headline: "AVODA rallies" }, "VOD.L")).toBe(false);
    expect(
      newsMentionsSymbol({ id: "1", news_date: "d", headline: "Retailer update", entities: ["MKS"] }, "MKS.L"),
    ).toBe(true);
  });
});
