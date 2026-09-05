import { describe, expect, it } from "vitest";
import { equityRisk, exposureStats, formatRiskProfileBlock, tradeStats } from "./risk-profile";
import { closedTradesFromFills } from "./risk-profile.server";

describe("equityRisk", () => {
  it("measures drawdown and volatility from the curve", () => {
    const r = equityRisk([
      { date: "2026-01-01", value: 100 },
      { date: "2026-01-02", value: 110 },
      { date: "2026-01-03", value: 99 },
      { date: "2026-01-04", value: 104.5 },
    ]);
    expect(r.days).toBe(4);
    expect(r.maxDrawdownPct).toBeCloseTo(-10, 5);
    expect(r.currentDrawdownPct).toBeCloseTo(-5, 5);
    expect(r.volAnnualPct).toBeGreaterThan(0);
  });

  it("ignores deposits and withdrawals rather than booking them as returns", () => {
    const r = equityRisk([
      { date: "2026-01-01", value: 100 },
      { date: "2026-01-02", value: 500 }, // capital added
      { date: "2026-01-03", value: 505 },
    ]);
    expect(r.bestDayPct).toBeCloseTo(1, 5);
  });
});

describe("closedTradesFromFills", () => {
  it("pairs sells against the running average cost", () => {
    const closed = closedTradesFromFills([
      { symbol: "AAPL:xnas", side: "buy", quantity: 10, price: 100, trade_date: "2026-01-01" },
      { symbol: "AAPL:xnas", side: "buy", quantity: 10, price: 120, trade_date: "2026-01-05" },
      { symbol: "AAPL:xnas", side: "sell", quantity: 20, price: 121, trade_date: "2026-01-11" },
    ]);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.symbol).toBe("AAPL");
    expect(closed[0]!.returnPct).toBeCloseTo(0.1, 5);
    expect(closed[0]!.heldDays).toBe(10);
  });

  it("ignores a sell with no matching position", () => {
    expect(
      closedTradesFromFills([
        { symbol: "X", side: "sell", quantity: 5, price: 10, trade_date: "2026-01-02" },
      ]),
    ).toHaveLength(0);
  });
});

describe("tradeStats and exposureStats", () => {
  const closed = [
    { symbol: "A", pnl: 10, returnPct: 0.1, heldDays: 5, notional: 110, closedOn: "2026-01-05" },
    { symbol: "B", pnl: -20, returnPct: -0.2, heldDays: 3, notional: 80, closedOn: "2026-01-06" },
  ];

  it("reports win rate and payoff", () => {
    const t = tradeStats(closed, 1000);
    expect(t.winRate).toBe(0.5);
    expect(t.payoff).toBeCloseTo(0.5, 5);
    expect(t.worst).toEqual({ symbol: "B", returnPct: -20 });
  });

  it("reports concentration over NAV", () => {
    const b = exposureStats(
      [
        { symbol: "A", value: 500, unrealised: 50, unrealisedPct: 11, heldDays: 4 },
        { symbol: "B", value: 250, unrealised: -10, unrealisedPct: -4, heldDays: 9 },
      ],
      1000,
      250,
    );
    expect(b.topSymbol).toBe("A");
    expect(b.topWeightPct).toBe(50);
    expect(b.concentration).toBeCloseTo(0.3125, 5);
    expect(b.cashPct).toBe(25);
  });
});

describe("formatRiskProfileBlock", () => {
  it("states the constraints and the real weights", () => {
    const profile = {
      ...equityRisk([
        { date: "2026-01-01", value: 100 },
        { date: "2026-01-02", value: 95 },
      ]),
      trades: tradeStats([], 1000),
      book: exposureStats([{ symbol: "A", value: 400, unrealised: 20, unrealisedPct: 5, heldDays: 3 }], 1000, 600),
      frictionBpsOfNav: 12.5,
    };
    const text = formatRiskProfileBlock(profile, {
      currency: "GBP",
      windowDays: 180,
      nav: 1000,
      positions: [{ symbol: "A", value: 400, unrealised: 20, unrealisedPct: 5, heldDays: 3 }],
    });
    expect(text).toContain("THIS BOOK'S OWN RISK PROFILE");
    expect(text).toContain("A: 40.0% of NAV");
    expect(text).toContain("12.5bps of NAV");
    expect(text).toContain("no closed round trips yet");
  });
});
