import { describe, expect, it } from "vitest";
import { ordersForDecision } from "@/lib/order-explanations-backfill.server";

const row = {
  id: "d1",
  portfolio_id: "p1",
  run_date: "2026-08-01",
  portfolios: { currency: "GBP", risk_config: { trading_style: "swing" } },
  raw: {
    orders: [
      {
        symbol: "aapl",
        side: "buy",
        signal_weights: { sma_trend: 0.5, rsi: 0.2 },
      },
    ],
    executed: [
      { symbol: "AAPL", side: "buy", quantity: 3, price: 100, value: 300, reason: "trend" },
      { symbol: "TSLA", side: "sell", quantity: 1, price: 50, value: 50, reason: "exit" },
    ],
    signals: [{ symbol: "AAPL", name: "Apple Inc", asset_class: "stock", price: 100 }],
    news: [{ headline: "Apple beats earnings", source: "Reuters" }],
    guardrails: { risk_level: "balanced", max_position_pct: 0.2, cash_floor_pct: 0.1 },
  },
} as never;

describe("ordersForDecision", () => {
  it("uses the same order keys the UI caches under", () => {
    const out = ordersForDecision(row);
    expect(out.map((o) => o.orderKey)).toEqual(["AAPL:buy:0", "TSLA:sell:1"]);
  });

  it("carries currency, trading style, weights and related news", () => {
    const [first] = ordersForDecision(row);
    expect(first?.input.currency).toBe("GBP");
    expect(first?.input.tradingStyle).toBe("swing");
    expect(first?.input.weights?.sma_trend).toBe(0.5);
    expect(first?.input.relatedNews?.[0]?.headline).toBe("Apple beats earnings");
    expect(first?.input.guardrails?.risk_level).toBe("balanced");
  });

  it("leaves unmatched orders without weights or news", () => {
    const second = ordersForDecision(row)[1];
    expect(second?.input.weights).toBeNull();
    expect(second?.input.relatedNews).toEqual([]);
  });
});
