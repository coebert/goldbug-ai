import { describe, it, expect } from "vitest";
import {
  applyTailHedgeToPaperPortfolio,
  defaultHedgeSymbolFor,
} from "@/lib/hedging/tail-hedge-executor.server";
import type { TailHedgeDecision } from "@/lib/hedging/tail-hedge";
import type { Database } from "@/integrations/supabase/types";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

function buyDecision(delta: number): TailHedgeDecision {
  return {
    action: "buy", targetNotional: delta, deltaNotional: delta,
    targetPctNav: 0.05, regime: "risk_off" as const, reason: "test",
  };
}
function sellDecision(delta: number): TailHedgeDecision {
  return {
    action: "sell", targetNotional: 0, deltaNotional: -delta,
    targetPctNav: 0, regime: "risk_on" as const, reason: "test unwind",
  };
}

const baseArgs = {
  portfolioId: "00000000-0000-0000-0000-000000000000",
  portfolioCurrency: "USD",
  isLivePortfolio: false,
};

describe("tail-hedge-executor", () => {
  it("defaults to gold proxies by currency", () => {
    expect(defaultHedgeSymbolFor("USD")).toBe("GLD");
    expect(defaultHedgeSymbolFor("GBP")).toBe("SGLN.L");
    expect(defaultHedgeSymbolFor("EUR")).toBe("SGLN.L");
  });

  it("buys the hedge and appends a trade", () => {
    const holdings = new Map<string, Holding>();
    const prices = new Map([["GLD", 200]]);
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, decision: buyDecision(1_000),
      holdingsByS: holdings, workingCash: 10_000, priceMap: prices,
    });
    expect(r.applied).toBe(true);
    expect(r.symbol).toBe("GLD");
    expect(r.trade?.side).toBe("buy");
    expect(r.qty).toBeCloseTo(1_000 / 200, 6);
    expect(r.workingCash).toBeCloseTo(9_000, 6);
    expect(holdings.get("GLD")?.quantity).toBeCloseTo(5, 6);
  });

  it("caps buy at available cash (minus buffer)", () => {
    const holdings = new Map<string, Holding>();
    const prices = new Map([["GLD", 200]]);
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, decision: buyDecision(5_000),
      holdingsByS: holdings, workingCash: 1_000, priceMap: prices,
    });
    expect(r.applied).toBe(true);
    expect(r.notional).toBeLessThanOrEqual(1_000);
    expect(r.workingCash).toBeGreaterThanOrEqual(0);
  });

  it("unwinds existing hedge on sell", () => {
    const holdings = new Map<string, Holding>([[
      "GLD",
      { id: "x", portfolio_id: baseArgs.portfolioId, symbol: "GLD",
        asset_class: "commodity", quantity: 10, avg_cost: 200,
        opened_at: null, updated_at: null, high_water_mark: 200 } as unknown as Holding,
    ]]);
    const prices = new Map([["GLD", 210]]);
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, decision: sellDecision(420),
      holdingsByS: holdings, workingCash: 500, priceMap: prices,
    });
    expect(r.applied).toBe(true);
    expect(r.trade?.side).toBe("sell");
    expect(r.qty).toBeCloseTo(2, 6);
    expect(holdings.get("GLD")?.quantity).toBeCloseTo(8, 6);
    expect(r.workingCash).toBeCloseTo(500 + 420, 6);
  });

  it("no-ops on hold or tiny delta", () => {
    const holdings = new Map<string, Holding>();
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs,
      decision: { action: "hold", targetNotional: 0, deltaNotional: 0,
        targetPctNav: 0, regime: "risk_on" as const, reason: "within threshold" },
      holdingsByS: holdings, workingCash: 10_000, priceMap: new Map([["GLD", 200]]),
    });
    expect(r.applied).toBe(false);
    expect(r.workingCash).toBe(10_000);
  });

  it("defers on live portfolios", () => {
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, isLivePortfolio: true,
      decision: buyDecision(1_000),
      holdingsByS: new Map(), workingCash: 10_000,
      priceMap: new Map([["GLD", 200]]),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/live/i);
  });

  it("skips when no price is available", () => {
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, decision: buyDecision(1_000),
      holdingsByS: new Map(), workingCash: 10_000, priceMap: new Map(),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/no price/i);
  });

  it("refuses to sell when no hedge exists", () => {
    const r = applyTailHedgeToPaperPortfolio({
      ...baseArgs, decision: sellDecision(500),
      holdingsByS: new Map(), workingCash: 10_000,
      priceMap: new Map([["GLD", 200]]),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/unwind/i);
  });
});
