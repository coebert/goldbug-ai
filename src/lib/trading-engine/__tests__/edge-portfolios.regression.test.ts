// Regression tests for *edge portfolios*.
//
// The tricky-input suites (`ai-decision.test.ts`, `ai-decision-sizing.integration.test.ts`,
// `ai-decision-sizing.fuzz.test.ts`) cover normal portfolios with odd numbers.
// This file pins the degenerate *shapes* that have historically produced
// non-deterministic prompts, NaN spend or phantom orders:
//
//   1. empty holdings      — a brand-new portfolio, nothing to sell
//   2. all-cash            — 100% cash, no positions, full budget available
//   3. missing price quote — the model names a symbol we have no price for
//   4. degenerate vol      — realised vol of 0, NaN, negative or absurdly large
//
// Each case must produce the *same* deterministic decision and sizing as the
// existing cases: identical prompts on repeat, schema-valid orders, and spend
// that is finite, non-negative and inside every cap.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Any = Record<string, unknown>;

const { generateText, NoObjectGeneratedError, calls } = vi.hoisted(() => {
  const calls: Array<{ system: string; prompt: string }> = [];
  class NoObjectGeneratedError extends Error {
    text?: string;
    static isInstance(e: unknown): boolean {
      return e instanceof NoObjectGeneratedError;
    }
  }
  const generateText = vi.fn(async (a: Any): Promise<{ output: Any }> => {
    calls.push({ system: String(a.system), prompt: String(a.prompt) });
    return { output: { briefing: "b", rationale: "r", orders: [] as Any[] } };
  });
  return { generateText, NoObjectGeneratedError, calls };
});

vi.mock("ai", () => ({
  generateText: (a: Any) => generateText(a),
  // Production streams the decision; the stream result exposes the same
  // structured `output` promise the non-streaming call returns.
  streamText: (a: Any) => ({ output: (async () => (await generateText(a)).output)() }),
  Output: { object: (o: Any) => o },
  NoObjectGeneratedError,
}));
vi.mock("../../ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => (id: string) => ({ id }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
    }),
  },
}));
vi.mock("../../counterfactuals.server", () => ({ logCounterfactual: async () => {} }));
vi.mock("../../learning.server", () => ({ formatLearningBlock: () => "LEARNING: none." }));
vi.mock("../../hyperparam-tuning.server", () => ({ formatHyperparamBlock: () => "HYPERPARAMS" }));
vi.mock("../../regime-detector.server", () => ({
  regimeDescription: (r: string) => `desc:${r}`,
  humanRegime: (r: string) => `human:${r}`,
}));

import { callAiForDecision } from "../ai-decision.server";
import type { Holding, Portfolio } from "../types";
import { riskProfile } from "../../universe.server";
import { resolveAggressiveness, aggressiveBuySpend } from "../../risk-aggressiveness";
import { RISK_LEVELS, riskPresetConfig } from "../../risk-presets";
import { volTargetSize } from "../../sizing/vol-target";
import { sizeAgainstClusterCap } from "../../sizing/correlation-cluster";

type PortfolioRisk = "conservative" | "balanced" | "aggressive";
const PORTFOLIO_LEVELS: PortfolioRisk[] = ["conservative", "balanced", "aggressive"];
const CLUSTER_CAP = 0.3;
const CLUSTERS = [["AAA", "BBB"], ["CCC"]];

type SizeInputs = {
  risk: PortfolioRisk;
  dial: number;
  nav: number;
  cash: number;
  price: number | null | undefined;
  percent: number;
  realizedVol: number;
  clusterWeightBefore?: number;
};

/** Same composition as production: percent → vol → cluster → dial → cash → qty. */
function sizeOne(i: SizeInputs): { spend: number; quantity: number; headroom: number } {
  const profile = riskProfile(i.risk);
  const agg = resolveAggressiveness(riskPresetConfig(i.dial));
  const nav = Number.isFinite(i.nav) && i.nav > 0 ? i.nav : 0;
  const cash = Number.isFinite(i.cash) && i.cash > 0 ? i.cash : 0;
  const budget = Math.max(0, cash - profile.cashFloorPct * nav);

  const baseFraction = Math.max(
    0,
    Math.min(1, Number.isFinite(i.percent) ? i.percent / 100 : 0),
  );
  const vol = volTargetSize({
    baseFraction,
    targetVol: 0.15,
    realizedVol: i.realizedVol,
    maxFraction: profile.maxPositionPct,
  });
  const cluster = sizeAgainstClusterCap({
    currentWeights: { BBB: Math.max(0, i.clusterWeightBefore ?? 0) },
    proposedSymbol: "AAA",
    proposedWeight: vol.fraction,
    clusters: CLUSTERS,
    clusterCap: CLUSTER_CAP,
  });
  const headroom = Math.max(0, (CLUSTER_CAP - cluster.cluster_weight_before) * nav);
  const wanted = aggressiveBuySpend(cluster.allowed_weight * nav, agg);
  const capped = Math.min(wanted, profile.maxPositionPct * nav, budget, headroom);

  const price = i.price;
  if (typeof price !== "number" || !Number.isFinite(price) || !(price > 0) || !(capped > 0)) {
    return { spend: 0, quantity: 0, headroom };
  }
  const quantity = Math.floor(capped / price);
  return { spend: quantity > 0 ? quantity * price : 0, quantity: Math.max(0, quantity), headroom };
}

function expectSane(r: { spend: number; quantity: number }) {
  expect(Number.isFinite(r.spend)).toBe(true);
  expect(r.spend).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(r.quantity)).toBe(true);
  expect(r.quantity).toBeGreaterThanOrEqual(0);
}

const REGIME = {
  as_of: "2026-08-03",
  regime: "risk_on",
  confidence: 0.75,
  previous_regime: null,
  transitioned: false,
  notes: "SPY>200dma",
} as unknown as Parameters<typeof callAiForDecision>[0]["regime"];

function portfolio(over: Partial<Portfolio> = {}): Portfolio {
  return {
    id: "p1",
    currency: "GBP",
    starting_cash: 10_000,
    risk_level: "balanced",
    risk_config: null,
    ...over,
  } as unknown as Portfolio;
}

function holding(symbol: string, quantity: number): Holding {
  return { symbol, quantity, avg_cost: 100 } as unknown as Holding;
}

function baseArgs(over: Partial<Parameters<typeof callAiForDecision>[0]> = {}) {
  return {
    portfolio: portfolio(),
    holdings: [],
    cashValue: 10_000,
    totalValue: 10_000,
    features: [],
    news: [],
    crossAsset: "CROSS-ASSET",
    optionsBlock: "OPTIONS",
    crossSectional: "XSECTION",
    events: [],
    cooling: [],
    asOf: "2026-08-03",
    regime: REGIME,
    learning: {} as Parameters<typeof callAiForDecision>[0]["learning"],
    ...over,
  } as Parameters<typeof callAiForDecision>[0];
}

function mockBuy(percent: number, symbol = "AAA") {
  generateText.mockImplementation(async (a: Any) => {
    calls.push({ system: String(a.system), prompt: String(a.prompt) });
    return {
      output: {
        briefing: "b",
        rationale: "r",
        orders: [
          {
            symbol,
            side: "buy",
            percent,
            conviction: 0.6,
            reason: "edge case",
            signal_weights: {
              sma_trend: 20, rsi: 20, price_change: 20, news_sentiment: 20, volatility: 20,
            },
          },
        ],
      },
    };
  });
}

beforeEach(() => {
  calls.length = 0;
  generateText.mockClear();
  generateText.mockImplementation(async (a: Any) => {
    calls.push({ system: String(a.system), prompt: String(a.prompt) });
    return { output: { briefing: "b", rationale: "r", orders: [] as Any[] } };
  });
  process.env.LOVABLE_API_KEY = "test-key";
  delete process.env.HEURISTIC_BUYS_ENABLED;
});

describe("edge portfolio: empty holdings", () => {
  it("builds a deterministic prompt with no positions and never emits a sell", async () => {
    const args = baseArgs({ holdings: [] });
    const a = await callAiForDecision(args);
    const b = await callAiForDecision(args);

    expect(calls[0].system).toBe(calls[1].system);
    expect(calls[0].prompt).toBe(calls[1].prompt);
    expect(a.orders).toEqual(b.orders);
    expect(a.orders.every((o) => o.side !== "sell")).toBe(true);
  });

  it("sizes a buy identically for the same inputs across repeat ticks", async () => {
    mockBuy(10);
    const first = await callAiForDecision(baseArgs({ holdings: [] }));
    const second = await callAiForDecision(baseArgs({ holdings: [] }));
    expect(first.orders).toEqual(second.orders);

    const sized = first.orders.map((o) =>
      sizeOne({
        risk: "balanced", dial: 3, nav: 10_000, cash: 10_000, price: 50,
        percent: Number(o.percent ?? 0), realizedVol: 0.15,
      }),
    );
    expect(sized).toEqual(
      second.orders.map((o) =>
        sizeOne({
          risk: "balanced", dial: 3, nav: 10_000, cash: 10_000, price: 50,
          percent: Number(o.percent ?? 0), realizedVol: 0.15,
        }),
      ),
    );
    sized.forEach(expectSane);
  });

  it("degrades deterministically when the gateway fails on an empty portfolio", async () => {
    generateText.mockImplementation(async () => {
      throw new Error("503 upstream");
    });
    const a = await callAiForDecision(baseArgs({ holdings: [] }));
    const b = await callAiForDecision(baseArgs({ holdings: [] }));
    expect(a.orders).toEqual(b.orders);
    expect(a.orders.every((o) => o.side !== "sell")).toBe(true);
  });
});

describe("edge portfolio: all cash", () => {
  it("keeps spend inside the cash floor for every risk level", () => {
    for (const risk of PORTFOLIO_LEVELS) {
      const profile = riskProfile(risk);
      const r = sizeOne({
        risk, dial: 5, nav: 100_000, cash: 100_000, price: 25, percent: 100, realizedVol: 0.15,
      });
      expectSane(r);
      expect(r.spend).toBeLessThanOrEqual(100_000 - profile.cashFloorPct * 100_000 + 1e-6);
      expect(r.spend).toBeLessThanOrEqual(profile.maxPositionPct * 100_000 + 1e-6);
    }
  });

  it("never sizes above zero when cash sits at or below the floor", () => {
    for (const risk of PORTFOLIO_LEVELS) {
      const floor = riskProfile(risk).cashFloorPct * 50_000;
      for (const cash of [0, floor / 2, floor]) {
        const r = sizeOne({
          risk, dial: 5, nav: 50_000, cash, price: 10, percent: 50, realizedVol: 0.15,
        });
        expectSane(r);
        expect(r.spend).toBe(0);
        expect(r.quantity).toBe(0);
      }
    }
  });

  it("produces a stable prompt when the portfolio is 100% cash", async () => {
    const args = baseArgs({ holdings: [], cashValue: 10_000, totalValue: 10_000 });
    await callAiForDecision(args);
    await callAiForDecision(args);
    expect(calls[0].prompt).toBe(calls[1].prompt);
  });
});

describe("edge portfolio: missing price quotes", () => {
  it("sizes to zero when the quote is absent, zero, negative or non-finite", () => {
    for (const price of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = sizeOne({
        risk: "aggressive", dial: 5, nav: 100_000, cash: 100_000,
        price: price as number | null | undefined, percent: 25, realizedVol: 0.15,
      });
      expectSane(r);
      expect(r.spend).toBe(0);
      expect(r.quantity).toBe(0);
    }
  });

  it("still returns a schema-valid, repeatable decision for an unpriced symbol", async () => {
    mockBuy(20, "NOPRICE");
    const a = await callAiForDecision(baseArgs());
    const b = await callAiForDecision(baseArgs());
    expect(a.orders).toEqual(b.orders);
    for (const o of a.orders) {
      const r = sizeOne({
        risk: "balanced", dial: 3, nav: 10_000, cash: 10_000, price: undefined,
        percent: Number(o.percent ?? 0), realizedVol: 0.15,
      });
      expect(r.spend).toBe(0);
    }
  });

  it("leaves priced symbols unaffected by an unpriced sibling", () => {
    const priced = sizeOne({
      risk: "balanced", dial: 3, nav: 50_000, cash: 50_000, price: 100, percent: 10, realizedVol: 0.15,
    });
    const unpriced = sizeOne({
      risk: "balanced", dial: 3, nav: 50_000, cash: 50_000, price: null, percent: 10, realizedVol: 0.15,
    });
    expectSane(priced);
    expect(priced.spend).toBeGreaterThan(0);
    expect(unpriced.spend).toBe(0);
  });
});

describe("edge portfolio: degenerate volatility", () => {
  const vols = [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e-9, 1e6];

  it("stays finite and capped for zero, negative, NaN, infinite and extreme vol", () => {
    for (const risk of PORTFOLIO_LEVELS) {
      for (const dial of RISK_LEVELS) {
        for (const realizedVol of vols) {
          const r = sizeOne({
            risk, dial, nav: 100_000, cash: 100_000, price: 20, percent: 40, realizedVol,
          });
          expectSane(r);
          expect(r.spend).toBeLessThanOrEqual(riskProfile(risk).maxPositionPct * 100_000 + 1e-6);
          expect(r.spend).toBeLessThanOrEqual(r.headroom + 1e-6);
        }
      }
    }
  });

  it("is deterministic for repeated degenerate-vol inputs", () => {
    for (const realizedVol of vols) {
      const args = {
        risk: "balanced" as const, dial: 4, nav: 80_000, cash: 80_000,
        price: 37.5, percent: 30, realizedVol,
      };
      expect(sizeOne(args)).toEqual(sizeOne(args));
    }
  });

  it("treats near-zero vol as the max-position cap rather than an unbounded order", () => {
    const r = sizeOne({
      risk: "aggressive", dial: 5, nav: 200_000, cash: 200_000,
      price: 1, percent: 100, realizedVol: 1e-9,
    });
    expectSane(r);
    expect(r.spend).toBeLessThanOrEqual(riskProfile("aggressive").maxPositionPct * 200_000 + 1e-6);
  });

  it("sizes extreme vol no larger than moderate vol", () => {
    const moderate = sizeOne({
      risk: "balanced", dial: 3, nav: 100_000, cash: 100_000, price: 10, percent: 40, realizedVol: 0.15,
    });
    const extreme = sizeOne({
      risk: "balanced", dial: 3, nav: 100_000, cash: 100_000, price: 10, percent: 40, realizedVol: 1e6,
    });
    expect(extreme.spend).toBeLessThanOrEqual(moderate.spend + 1e-9);
  });
});

describe("edge portfolios: cross-shape consistency", () => {
  it("matches the tricky-input contract — held vs empty portfolios size the same buy", () => {
    const empty = sizeOne({
      risk: "balanced", dial: 3, nav: 100_000, cash: 100_000, price: 40, percent: 15, realizedVol: 0.2,
    });
    const held = sizeOne({
      risk: "balanced", dial: 3, nav: 100_000, cash: 100_000, price: 40, percent: 15,
      realizedVol: 0.2, clusterWeightBefore: 0,
    });
    expect(held).toEqual(empty);
  });

  it("shrinks the same order once an existing cluster position is present", () => {
    const clean = sizeOne({
      risk: "aggressive", dial: 5, nav: 100_000, cash: 100_000, price: 40, percent: 30, realizedVol: 0.2,
    });
    const crowded = sizeOne({
      risk: "aggressive", dial: 5, nav: 100_000, cash: 100_000, price: 40, percent: 30,
      realizedVol: 0.2, clusterWeightBefore: 0.28,
    });
    expect(crowded.spend).toBeLessThanOrEqual(clean.spend + 1e-9);
    expectSane(crowded);
  });

  it("holdings present but zero-quantity behave like an empty portfolio", async () => {
    const withZero = baseArgs({ holdings: [holding("AAA", 0)] });
    const a = await callAiForDecision(withZero);
    const b = await callAiForDecision(withZero);
    expect(a.orders).toEqual(b.orders);
    expect(calls[0].prompt).toBe(calls[1].prompt);
  });
});
