// End-to-end integration test for the extracted decision flow.
//
// candidate features → portfolio snapshot → AI decision → executed trades
//
// Everything outside the engine is faked: the price cache is an in-memory
// table, the AI gateway returns a fixed structured decision, and the broker
// is a recording stub that fills at the requested price. What is NOT faked is
// the code under test — real `buildCandidateFeatures`, real `snapshotPortfolio`
// orchestration, real `callAiForDecision` prompt/parse path, and the real
// execution-realism sizing helpers.
//
// The point is behavioural parity: this pins the shape and the numbers that
// flow between the four stages, so a future refactor that moves code between
// modules has to keep the same trades coming out the other end.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Any = Record<string, unknown>;

const AS_OF = "2026-08-03";

// ---------------------------------------------------------------- fixtures

/** Deterministic daily candles ending exactly on `AS_OF` (no Yahoo fetch). */
function series(symbol: string, days: number, start: number, drift: number) {
  const rows: Array<Any> = [];
  const end = new Date(`${AS_OF}T00:00:00Z`).getTime();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86400000).toISOString().slice(0, 10);
    // Small deterministic wobble so RSI/ATR/MACD are not degenerate.
    const wobble = ((days - i) % 5) - 2;
    const close = Number((start + drift * (days - 1 - i) + wobble * 0.1).toFixed(4));
    rows.push({
      symbol,
      price_date: date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000 + ((days - i) % 7) * 10_000,
    });
  }
  return rows;
}

const PRICE_ROWS = [
  ...series("AAA", 60, 100, 0.5), // uptrend — the AI will buy this
  ...series("BBB", 60, 200, -0.8), // downtrend — the AI will exit this
];

const { state, brokerOrders, supabaseAdmin } = vi.hoisted(() => {
  const state: { portfolio: Any | null; holdings: Any[] } = { portfolio: null, holdings: [] };
  const brokerOrders: Any[] = [];
  return { state, brokerOrders, supabaseAdmin: makeSupabase(state) };

  function makeSupabase(st: { portfolio: Any | null; holdings: Any[] }) {
    return {
      from(table: string) {
        if (table === "price_cache") return priceCacheQuery();
        if (table === "portfolios") {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: st.portfolio }) }) }),
          };
        }
        if (table === "holdings") {
          return { select: () => ({ eq: async () => ({ data: st.holdings }) }) };
        }
        // Anything else the engine touches is a no-op sink.
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: null }), maybeSingle: async () => ({ data: null }) }),
          }),
          insert: async () => ({ error: null }),
          upsert: async () => ({ error: null }),
        };
      },
    };

    function priceCacheQuery() {
      const filters: { symbols?: string[]; symbol?: string; lte?: string; limit?: number } = {};
      const rows = () => {
        // `globalThis` indirection keeps the hoisted factory free of TDZ issues.
        const all = (globalThis as Any).__PRICE_ROWS__ as Any[];
        let out = all.filter((r) =>
          filters.symbols
            ? filters.symbols.includes(r.symbol as string)
            : filters.symbol
              ? r.symbol === filters.symbol
              : true,
        );
        if (filters.lte) out = out.filter((r) => (r.price_date as string) <= filters.lte!);
        // Callers always ask newest-first.
        out = out
          .slice()
          .sort((a, b) => String(b.price_date).localeCompare(String(a.price_date)));
        if (filters.limit != null) out = out.slice(0, filters.limit);
        return out;
      };
      const builder: Any = {
        select: () => builder,
        in: (_c: string, v: string[]) => ((filters.symbols = v), builder),
        eq: (_c: string, v: string) => ((filters.symbol = v), builder),
        lte: (_c: string, v: string) => ((filters.lte = v), builder),
        order: () => builder,
        limit: (n: number) => ((filters.limit = n), builder),
        then: (res: (v: Any) => unknown) => Promise.resolve({ data: rows() }).then(res),
      };
      return builder;
    }
  }
});

(globalThis as Any).__PRICE_ROWS__ = PRICE_ROWS;

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin }));

// --- AI gateway -----------------------------------------------------------
const { generateText, aiCalls, aiOutput } = vi.hoisted(() => {
  const aiCalls: Array<{ system: string; prompt: string }> = [];
  const aiOutput: { value: Any } = { value: {} };
  const generateText = vi.fn(async (a: Any): Promise<{ output: Any }> => {
    aiCalls.push({ system: String(a.system), prompt: String(a.prompt) });
    return { output: aiOutput.value };
  });
  return { generateText, aiCalls, aiOutput };
});

vi.mock("ai", () => ({
  generateText: (a: Any) => generateText(a),
  // Production streams the decision; the stream result exposes the same
  // structured `output` promise the non-streaming call returns.
  streamText: (a: Any) => ({ output: (async () => (await generateText(a)).output)() }),
  Output: { object: (o: Any) => o },
  NoObjectGeneratedError: class extends Error {
    static isInstance() {
      return false;
    }
  },
}));
vi.mock("../../ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => (id: string) => ({ id }),
}));
vi.mock("../../counterfactuals.server", () => ({ logCounterfactual: async () => {} }));
vi.mock("../../learning.server", () => ({ formatLearningBlock: () => "LEARNING: none." }));
vi.mock("../../hyperparam-tuning.server", () => ({ formatHyperparamBlock: () => "HYPERPARAMS" }));
vi.mock("../../regime-detector.server", () => ({
  regimeDescription: (r: string) => `desc:${r}`,
  humanRegime: (r: string) => `human:${r}`,
}));

// --- valuation layer (own tests cover the kernel) -------------------------
const valuePortfolioHoldings = vi.fn(async (_a: Any) => ({
  cash: 5000,
  holdingsValue: 5000,
  totalValue: 10000,
  provenance: "live" as const,
}));
vi.mock("../../valuation/value-holdings.server", () => ({
  valuePortfolioHoldings: (a: Any) => valuePortfolioHoldings(a),
}));
const writeEquitySnapshot = vi.fn(async (_c: unknown, _a: Any) => {});
vi.mock("../../valuation/write-snapshot.server", () => ({
  writeEquitySnapshot: (c: unknown, a: Any) => writeEquitySnapshot(c, a),
}));

import { buildCandidateFeatures } from "../candidate-features.server";
import { snapshotPortfolio } from "../snapshot.server";
import { callAiForDecision } from "../ai-decision.server";
import { DecisionSchema, type ExecutedTrade, type Holding, type Portfolio } from "../types";
import { clearCandleMemo } from "../../market-data.server";
import { applyBuyExecution, applySellExecution } from "../../execution-realism.server";
import type {
  BrokerAdapter,
  BrokerOrderRequest,
  BrokerOrderResult,
} from "../../brokers/adapter";

// ------------------------------------------------------------ mock broker

/** Records every ticket and fills at the requested price. Never partial. */
function mockBroker(over: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    name: "mock",
    env: "sim",
    ping: async () => ({ ok: true, latencyMs: 1 }),
    getBalance: async () => ({ cash: 5000, currency: "GBP", totalValue: 10000 }),
    getPositions: async () => [],
    placeOrder: async (req: BrokerOrderRequest): Promise<BrokerOrderResult> => {
      brokerOrders.push({ ...req });
      return {
        brokerOrderId: `mock-${brokerOrders.length}`,
        status: "filled",
        filledQuantity: req.quantity,
        avgFillPrice: req.limitPrice ?? 0,
      };
    },
    cancelOrder: async () => ({ ok: true }),
    ...over,
  };
}

const UNIVERSE = [
  { symbol: "AAA", name: "Alpha Inc", asset_class: "stock" },
  { symbol: "BBB", name: "Beta Plc", asset_class: "stock" },
] as unknown as Parameters<typeof buildCandidateFeatures>[0];

function portfolio(over: Partial<Portfolio> = {}): Portfolio {
  return {
    id: "p1",
    currency: "GBP",
    cash: 5000,
    starting_cash: 10000,
    risk_level: "balanced",
    risk_config: null,
    ...over,
  } as unknown as Portfolio;
}

function holding(symbol: string, quantity: number, avgCost: number): Holding {
  return { symbol, quantity, avg_cost: avgCost, asset_class: "stock" } as unknown as Holding;
}

/**
 * The executed-trade stage, wired exactly as the engine wires it: size the
 * order, run it through execution realism, then send one broker ticket per
 * surviving order and record the fill.
 */
async function executeDecision(args: {
  broker: BrokerAdapter;
  decision: { orders: Array<Any> };
  features: Awaited<ReturnType<typeof buildCandidateFeatures>>;
  holdings: Holding[];
  cash: number;
  totalValue: number;
}): Promise<{ executed: ExecutedTrade[]; cash: number }> {
  const executed: ExecutedTrade[] = [];
  let cash = args.cash;
  const byQty = new Map(args.holdings.map((h) => [h.symbol, Number(h.quantity)]));

  for (const o of args.decision.orders) {
    const symbol = String(o.symbol);
    const f = args.features.find((x) => x.symbol === symbol);
    if (!f) {
      executed.push({
        symbol, side: o.side as "buy" | "sell", quantity: 0, price: 0, value: 0,
        reason: String(o.reason ?? ""), rejected: "no price",
      });
      continue;
    }

    if (o.side === "buy") {
      const requestedSpend = Math.min(cash, (Number(o.percent) / 100) * args.totalValue);
      const fill = applyBuyExecution({
        requestedSpend,
        price: f.price,
        atrPct: f.atr_pct,
        adv20d: f.adv_20d,
      });
      if (fill.qty <= 0) {
        executed.push({
          symbol, side: "buy", quantity: 0, price: f.price, value: 0,
          reason: String(o.reason ?? ""), rejected: fill.notes.join("; "),
        });
        continue;
      }
      const res = await args.broker.placeOrder({
        symbol, side: "buy", quantity: fill.qty, orderType: "limit",
        limitPrice: fill.fillPrice, clientOrderId: `${AS_OF}:${symbol}:buy`,
      });
      if (res.status !== "filled") {
        executed.push({
          symbol, side: "buy", quantity: 0, price: f.price, value: 0,
          reason: String(o.reason ?? ""), rejected: res.reason ?? res.status,
        });
        continue;
      }
      cash -= fill.effectiveSpend;
      byQty.set(symbol, (byQty.get(symbol) ?? 0) + fill.qty);
      executed.push({
        symbol, side: "buy", quantity: fill.qty, price: fill.fillPrice,
        value: fill.effectiveSpend, reason: String(o.reason ?? ""),
      });
      continue;
    }

    // sell — never more than is held
    const held = byQty.get(symbol) ?? 0;
    const qty = Math.min(held, (Number(o.percent) / 100) * held);
    if (qty <= 0) {
      executed.push({
        symbol, side: "sell", quantity: 0, price: f.price, value: 0,
        reason: String(o.reason ?? ""), rejected: "no holding to sell",
      });
      continue;
    }
    const fill = applySellExecution({ qty, price: f.price, atrPct: f.atr_pct, adv20d: f.adv_20d });
    const res = await args.broker.placeOrder({
      symbol, side: "sell", quantity: qty, orderType: "limit",
      limitPrice: fill.fillPrice, clientOrderId: `${AS_OF}:${symbol}:sell`,
    });
    if (res.status !== "filled") {
      executed.push({
        symbol, side: "sell", quantity: 0, price: f.price, value: 0,
        reason: String(o.reason ?? ""), rejected: res.reason ?? res.status,
      });
      continue;
    }
    cash += fill.proceedsNet;
    byQty.set(symbol, held - qty);
    executed.push({
      symbol, side: "sell", quantity: qty, price: fill.fillPrice,
      value: fill.proceedsNet, reason: String(o.reason ?? ""),
    });
  }

  return { executed, cash };
}

/** The whole flow, start to finish. */
async function runFlow(opts: { broker?: BrokerAdapter; orders?: Array<Any> } = {}) {
  const broker = opts.broker ?? mockBroker();
  const holdings = [holding("BBB", 20, 210)];
  state.portfolio = { id: "p1", cash: 5000, currency: "GBP" };
  state.holdings = holdings.map((h) => ({ ...h }));

  const features = await buildCandidateFeatures(UNIVERSE, AS_OF);
  const snapshot = await snapshotPortfolio("p1", AS_OF);

  aiOutput.value = {
    briefing: "trend following",
    rationale: "rotate from BBB into AAA",
    orders: opts.orders ?? [
      {
        symbol: "AAA", side: "buy", percent: 10, conviction: 0.7, reason: "uptrend intact",
        signal_weights: { sma_trend: 40, rsi: 20, price_change: 25, news_sentiment: 5, volatility: 10 },
      },
      {
        symbol: "BBB", side: "sell", percent: 100, conviction: 0.6, reason: "downtrend, cut it",
        signal_weights: { sma_trend: 45, rsi: 15, price_change: 30, news_sentiment: 0, volatility: 10 },
      },
    ],
  };

  const decision = await callAiForDecision({
    portfolio: portfolio(),
    holdings,
    cashValue: 5000,
    totalValue: 10000,
    features,
    news: [{ headline: "Alpha beats estimates", source: "Reuters", sentiment: 0.4 }],
    crossAsset: "CROSS-ASSET",
    optionsBlock: "OPTIONS",
    crossSectional: "XSECTION",
    events: [],
    cooling: [],
    asOf: AS_OF,
    regime: { as_of: AS_OF, regime: "risk_on", confidence: 0.7 } as unknown as Parameters<
      typeof callAiForDecision
    >[0]["regime"],
    learning: {} as Parameters<typeof callAiForDecision>[0]["learning"],
  });

  const exec = await executeDecision({
    broker, decision, features, holdings, cash: 5000, totalValue: 10000,
  });

  return { features, snapshot, decision, ...exec };
}

beforeEach(() => {
  clearCandleMemo();
  brokerOrders.length = 0;
  aiCalls.length = 0;
  generateText.mockClear();
  valuePortfolioHoldings.mockClear();
  writeEquitySnapshot.mockClear();
  process.env.LOVABLE_API_KEY = "test-key";
});

describe("decision flow — stage wiring", () => {
  it("carries features through snapshot and AI into executed trades", async () => {
    const r = await runFlow();

    // 1. features built from the mocked price cache, no network
    expect(r.features.map((f) => f.symbol).sort()).toEqual(["AAA", "BBB"]);
    const aaa = r.features.find((f) => f.symbol === "AAA")!;
    expect(aaa.price).toBeGreaterThan(120);
    expect(aaa.sma20).not.toBeNull();
    expect(aaa.rsi14).not.toBeNull();

    // 2. snapshot valued and persisted exactly once
    expect(valuePortfolioHoldings).toHaveBeenCalledTimes(1);
    expect(writeEquitySnapshot).toHaveBeenCalledTimes(1);
    expect(writeEquitySnapshot.mock.calls[0][1]).toMatchObject({ totalValue: 10000 });

    // 3. AI call happened once and its output parses against the contract
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(DecisionSchema.safeParse(r.decision).success).toBe(true);

    // 4. two broker tickets, one per order, in decision order
    expect(brokerOrders.map((o) => [o.symbol, o.side])).toEqual([
      ["AAA", "buy"],
      ["BBB", "sell"],
    ]);
    expect(r.executed.every((t) => !t.rejected)).toBe(true);
  });

  it("prices every candidate the AI is shown", async () => {
    const r = await runFlow();
    for (const f of r.features) {
      expect(Number.isFinite(f.price)).toBe(true);
      expect(f.price).toBeGreaterThan(0);
    }
    for (const t of r.executed) {
      expect(t.price).toBeGreaterThan(0);
    }
  });
});

describe("decision flow — determinism", () => {
  it("produces byte-identical trades on a repeat run", async () => {
    const a = await runFlow();
    const b = await runFlow();
    expect(JSON.stringify(b.executed)).toBe(JSON.stringify(a.executed));
    expect(b.cash).toBe(a.cash);
  });

  it("sends the same prompt for the same inputs", async () => {
    await runFlow();
    const first = aiCalls[0];
    aiCalls.length = 0;
    await runFlow();
    expect(aiCalls[0].system).toBe(first.system);
    expect(aiCalls[0].prompt).toBe(first.prompt);
  });

  it("uses a stable, idempotent client order id per symbol and side", async () => {
    await runFlow();
    const ids = brokerOrders.map((o) => o.clientOrderId);
    expect(ids).toEqual([`${AS_OF}:AAA:buy`, `${AS_OF}:BBB:sell`]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("decision flow — execution invariants", () => {
  it("never spends more cash than the portfolio holds", async () => {
    const r = await runFlow({
      orders: [
        {
          symbol: "AAA", side: "buy", percent: 900, reason: "oversized",
          signal_weights: { sma_trend: 40, rsi: 20, price_change: 25, news_sentiment: 5, volatility: 10 },
        },
      ],
    });
    expect(r.cash).toBeGreaterThanOrEqual(0);
    const buy = r.executed[0];
    expect(buy.value).toBeLessThanOrEqual(5000);
  });

  it("never sells more than is held and never shorts", async () => {
    const r = await runFlow({
      orders: [
        {
          symbol: "BBB", side: "sell", percent: 500, reason: "exit everything",
          signal_weights: { sma_trend: 45, rsi: 15, price_change: 30, news_sentiment: 0, volatility: 10 },
        },
      ],
    });
    expect(r.executed[0].quantity).toBe(20);
    expect(brokerOrders[0].quantity).toBe(20);
  });

  it("marks an order rejected — and leaves cash untouched — when the broker refuses", async () => {
    const broker = mockBroker({
      placeOrder: async (req: BrokerOrderRequest) => {
        brokerOrders.push({ ...req });
        return { brokerOrderId: "x", status: "rejected" as const, reason: "suitability" };
      },
    });
    const r = await runFlow({ broker });
    expect(r.cash).toBe(5000);
    expect(r.executed.map((t) => t.rejected)).toEqual(["suitability", "suitability"]);
    expect(r.executed.every((t) => t.quantity === 0)).toBe(true);
  });

  it("does not ticket an order for a symbol with no priced candidate", async () => {
    const r = await runFlow({
      orders: [
        {
          symbol: "ZZZ", side: "buy", percent: 10, reason: "hallucinated",
          signal_weights: { sma_trend: 40, rsi: 20, price_change: 25, news_sentiment: 5, volatility: 10 },
        },
      ],
    });
    expect(brokerOrders).toHaveLength(0);
    expect(r.executed[0].rejected).toBe("no price");
    expect(r.cash).toBe(5000);
  });

  it("skips sub-minimum tickets instead of churning pennies", async () => {
    const r = await runFlow({
      orders: [
        {
          symbol: "AAA", side: "buy", percent: 0.05, reason: "dust",
          signal_weights: { sma_trend: 40, rsi: 20, price_change: 25, news_sentiment: 5, volatility: 10 },
        },
      ],
    });
    expect(brokerOrders).toHaveLength(0);
    expect(r.executed[0].quantity).toBe(0);
    expect(r.executed[0].rejected).toMatch(/min trade value/);
  });

  it("does nothing at all when the AI returns an empty order list", async () => {
    const r = await runFlow({ orders: [] });
    expect(r.executed).toEqual([]);
    expect(brokerOrders).toHaveLength(0);
    expect(r.cash).toBe(5000);
    // The snapshot still runs — valuation is not conditional on trading.
    expect(writeEquitySnapshot).toHaveBeenCalledTimes(1);
  });
});
