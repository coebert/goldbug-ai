// Contract tests for the extracted decision schemas. The AI's raw output is
// untrusted: these lock exactly what the engine accepts, since a loosened
// schema would let malformed orders reach the guardrails/execution layer.
import { describe, it, expect } from "vitest";
import { SignalWeightsSchema, OrderSchema, DecisionSchema } from "../types";

const weights = {
  sma_trend: 30,
  rsi: 20,
  price_change: 20,
  news_sentiment: 20,
  volatility: 10,
};

const order = {
  symbol: "AAPL",
  side: "buy" as const,
  percent: 5,
  reason: "momentum",
  signal_weights: weights,
};

describe("SignalWeightsSchema", () => {
  it("accepts the 0..100 range inclusive at both ends", () => {
    expect(SignalWeightsSchema.safeParse({ ...weights, rsi: 0 }).success).toBe(true);
    expect(SignalWeightsSchema.safeParse({ ...weights, rsi: 100 }).success).toBe(true);
  });

  it("rejects out-of-range weights", () => {
    expect(SignalWeightsSchema.safeParse({ ...weights, rsi: -1 }).success).toBe(false);
    expect(SignalWeightsSchema.safeParse({ ...weights, rsi: 100.1 }).success).toBe(false);
  });

  it("requires every weight key", () => {
    const { rsi: _omitted, ...partial } = weights;
    expect(SignalWeightsSchema.safeParse(partial).success).toBe(false);
  });

  it("does not coerce numeric strings", () => {
    expect(SignalWeightsSchema.safeParse({ ...weights, rsi: "20" }).success).toBe(false);
  });

  it("does not require the weights to sum to 100", () => {
    const all = { sma_trend: 1, rsi: 1, price_change: 1, news_sentiment: 1, volatility: 1 };
    expect(SignalWeightsSchema.safeParse(all).success).toBe(true);
  });
});

describe("OrderSchema", () => {
  it("accepts a minimal valid order without conviction", () => {
    expect(OrderSchema.safeParse(order).success).toBe(true);
  });

  it("accepts conviction across the 0..1 range and rejects outside it", () => {
    expect(OrderSchema.safeParse({ ...order, conviction: 0 }).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, conviction: 1 }).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, conviction: 1.01 }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, conviction: -0.01 }).success).toBe(false);
  });

  it("only allows buy/sell sides", () => {
    expect(OrderSchema.safeParse({ ...order, side: "short" }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, side: "BUY" }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, side: "sell" }).success).toBe(true);
  });

  it("leaves percent unbounded so downstream guardrails own sizing policy", () => {
    // Deliberate: sizing is clamped by risk config, not by the parse step.
    expect(OrderSchema.safeParse({ ...order, percent: 900 }).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, percent: -5 }).success).toBe(true);
  });

  it("rejects non-finite percents", () => {
    expect(OrderSchema.safeParse({ ...order, percent: Number.NaN }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, percent: Infinity }).success).toBe(false);
  });

  it("requires signal_weights and reason", () => {
    const { signal_weights: _w, ...noWeights } = order;
    const { reason: _r, ...noReason } = order;
    expect(OrderSchema.safeParse(noWeights).success).toBe(false);
    expect(OrderSchema.safeParse(noReason).success).toBe(false);
  });

  it("strips unknown keys rather than failing", () => {
    const parsed = OrderSchema.parse({ ...order, hallucinated_field: "ignore me" });
    expect(parsed).not.toHaveProperty("hallucinated_field");
  });
});

describe("DecisionSchema", () => {
  const decision = { briefing: "b", rationale: "r", orders: [order] };

  it("accepts a decision with no FX blocks", () => {
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("accepts an empty order list (a valid 'do nothing' tick)", () => {
    expect(DecisionSchema.safeParse({ ...decision, orders: [] }).success).toBe(true);
  });

  it("rejects a decision missing orders entirely", () => {
    const { orders: _o, ...noOrders } = decision;
    expect(DecisionSchema.safeParse(noOrders).success).toBe(false);
  });

  it("fails the whole decision when any single order is invalid", () => {
    const bad = { ...decision, orders: [order, { ...order, side: "hold" }] };
    expect(DecisionSchema.safeParse(bad).success).toBe(false);
  });

  it("requires briefing and rationale to be strings", () => {
    expect(DecisionSchema.safeParse({ ...decision, briefing: null }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...decision, rationale: 12 }).success).toBe(false);
    // Empty strings are allowed — the engine renders them as "no commentary".
    expect(DecisionSchema.safeParse({ ...decision, briefing: "" }).success).toBe(true);
  });

  it("accepts empty optional fx arrays", () => {
    const parsed = DecisionSchema.safeParse({ ...decision, fx_conversions: [], fx_intents: [] });
    expect(parsed.success).toBe(true);
  });
});
