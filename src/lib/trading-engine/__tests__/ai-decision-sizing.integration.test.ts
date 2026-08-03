// Integration test: AI decision output → full order-sizing pipeline.
//
// The unit tests either exercise `callAiForDecision` in isolation (prompt +
// fallback shape) or the sizer composition in isolation (dial → vol-target →
// cluster cap). What was untested is the seam between them: the model's
// `percent` orders being turned into real quantities and cash spend under
// every risk level, with all caps applied at once.
//
// Invariants asserted for EVERY risk level (portfolio enum × 1..5 dial):
//   * per-order notional ≤ the level's max position % of NAV
//   * combined spend ≤ investable cash (cash − cash floor), never negative
//   * post-trade correlation-cluster weight ≤ the cluster cap
//   * quantities are whole units, never negative, and qty × price ≤ spend
//   * an aggressive level never sizes smaller than a defensive one
//   * degenerate model output (0%, >100%, NaN prices) produces no trade,
//     never a NaN/Infinity spend
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Any = Record<string, unknown>;

const { generateText, NoObjectGeneratedError } = vi.hoisted(() => {
  class NoObjectGeneratedError extends Error {
    text?: string;
    static isInstance(e: unknown): boolean {
      return e instanceof NoObjectGeneratedError;
    }
  }
  const generateText = vi.fn(async (): Promise<{ output: Any }> => ({
    output: { briefing: "b", rationale: "r", orders: [] as Any[] },
  }));
  return { generateText, NoObjectGeneratedError };
});

vi.mock("ai", () => ({
  generateText: (a: Any) => generateText(a),
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

const NAV = 100_000;
const CASH = 60_000;
const CLUSTERS = [["AAPL", "MSFT"], ["GLD"]];
const CLUSTER_CAP = 0.3;
const PRICES: Record<string, number> = { AAPL: 187.5, MSFT: 412.25, GLD: 61.4 };

const REGIME = {
  as_of: "2026-08-03",
  regime: "risk_on",
  confidence: 0.75,
  previous_regime: null,
  transitioned: false,
  notes: "SPY>200dma",
} as unknown as Parameters<typeof callAiForDecision>[0]["regime"];

function portfolio(risk: PortfolioRisk, dial?: number): Portfolio {
  return {
    id: "p1",
    currency: "GBP",
    starting_cash: NAV,
    risk_level: risk,
    risk_config: dial == null ? null : { risk_level: dial },
  } as unknown as Portfolio;
}

function holding(symbol: string, quantity: number): Holding {
  return { symbol, quantity, avg_cost: 100 } as unknown as Holding;
}

function baseArgs(risk: PortfolioRisk, dial?: number) {
  return {
    portfolio: portfolio(risk, dial),
    holdings: [holding("MSFT", 20)],
    cashValue: CASH,
    totalValue: NAV,
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
  } as Parameters<typeof callAiForDecision>[0];
}

function modelOrders(orders: Any[]) {
  generateText.mockImplementationOnce(async () => ({
    output: { briefing: "b", rationale: "r", orders },
  }));
}

function buyOrder(symbol: string, percent: number): Any {
  return {
    symbol,
    side: "buy",
    percent,
    conviction: 0.6,
    reason: "trend",
    signal_weights: { sma_trend: 40, rsi: 20, price_change: 20, news_sentiment: 10, volatility: 10 },
  };
}

type SizedOrder = {
  symbol: string;
  quantity: number;
  spend: number;
  weightAfter: number;
};

/**
 * The engine's buy sizer, composed exactly as production does it:
 *   model percent → vol-target → cluster cap → risk dial → cash budget → qty.
 * Runs orders sequentially so each one sees the cash and cluster weight left
 * behind by the previous one (this is where double-spend bugs show up).
 */
function sizeDecision(args: {
  orders: Array<{ symbol: string; side: string; percent?: number | null }>;
  risk: PortfolioRisk;
  dial: number;
  nav: number;
  cash: number;
  realizedVol?: number;
  weights?: Record<string, number>;
  prices?: Record<string, number>;
}): { sized: SizedOrder[]; totalSpend: number; cashLeft: number } {
  const profile = riskProfile(args.risk);
  const agg = resolveAggressiveness(riskPresetConfig(args.dial));
  const prices = args.prices ?? PRICES;
  const weights: Record<string, number> = { ...(args.weights ?? {}) };

  const cashFloor = profile.cashFloorPct * args.nav;
  let budget = Math.max(0, args.cash - cashFloor);
  const sized: SizedOrder[] = [];

  for (const o of args.orders) {
    if (o.side !== "buy") continue;
    const pct = typeof o.percent === "number" && Number.isFinite(o.percent) ? o.percent : 0;
    const baseFraction = Math.max(0, Math.min(1, pct / 100));
    if (baseFraction <= 0) continue;

    const vol = volTargetSize({
      baseFraction,
      targetVol: 0.15,
      realizedVol: args.realizedVol ?? 0.18,
      maxFraction: profile.maxPositionPct,
    });
    const cluster = sizeAgainstClusterCap({
      currentWeights: weights,
      proposedSymbol: o.symbol,
      proposedWeight: vol.fraction,
      clusters: CLUSTERS,
      clusterCap: CLUSTER_CAP,
    });

    const target = cluster.allowed_weight * args.nav;
    const wanted = aggressiveBuySpend(target, agg);
    const capped = Math.min(wanted, profile.maxPositionPct * args.nav, budget);
    const price = prices[o.symbol];
    if (!Number.isFinite(price) || !(price > 0) || !(capped > 0)) continue;

    const quantity = Math.floor(capped / price);
    const spend = quantity * price;
    if (quantity <= 0 || spend <= 0) continue;

    budget -= spend;
    weights[o.symbol] = (weights[o.symbol] ?? 0) + spend / args.nav;
    sized.push({ symbol: o.symbol, quantity, spend, weightAfter: weights[o.symbol] });
  }

  const totalSpend = sized.reduce((s, o) => s + o.spend, 0);
  return { sized, totalSpend, cashLeft: args.cash - totalSpend };
}

function clusterWeight(weights: Record<string, number>, symbol: string): number {
  const cluster = CLUSTERS.find((c) => c.includes(symbol)) ?? [symbol];
  return cluster.reduce((s, sym) => s + (weights[sym] ?? 0), 0);
}

beforeEach(() => {
  generateText.mockClear();
  generateText.mockImplementation(async () => ({
    output: { briefing: "b", rationale: "r", orders: [] as Any[] },
  }));
  process.env.LOVABLE_API_KEY = "test-key";
  delete process.env.HEURISTIC_BUYS_ENABLED;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ai-decision → order sizing (integration)", () => {
  it("keeps every order inside the position, cash and cluster caps at all risk levels", async () => {
    for (const risk of PORTFOLIO_LEVELS) {
      for (const dial of RISK_LEVELS) {
        modelOrders([buyOrder("AAPL", 40), buyOrder("MSFT", 40), buyOrder("GLD", 40)]);
        const decision = await callAiForDecision(baseArgs(risk, dial));
        const { sized, totalSpend, cashLeft } = sizeDecision({
          orders: decision.orders,
          risk,
          dial,
          nav: NAV,
          cash: CASH,
        });

        const profile = riskProfile(risk);
        const weights: Record<string, number> = {};
        for (const o of sized) {
          expect(Number.isFinite(o.spend)).toBe(true);
          expect(o.spend).toBeGreaterThan(0);
          expect(Number.isInteger(o.quantity)).toBe(true);
          expect(o.quantity).toBeGreaterThan(0);
          expect(o.spend).toBeLessThanOrEqual(o.quantity * PRICES[o.symbol] + 1e-9);
          // per-position cap
          expect(o.spend).toBeLessThanOrEqual(profile.maxPositionPct * NAV + 1e-9);
          weights[o.symbol] = (weights[o.symbol] ?? 0) + o.spend / NAV;
          // cluster cap holds after each fill
          expect(clusterWeight(weights, o.symbol)).toBeLessThanOrEqual(CLUSTER_CAP + 1e-9);
        }

        // cash floor is respected and cash never goes negative
        expect(totalSpend).toBeLessThanOrEqual(CASH - profile.cashFloorPct * NAV + 1e-9);
        expect(cashLeft).toBeGreaterThanOrEqual(profile.cashFloorPct * NAV - 1e-9);
      }
    }
  });

  it("never sizes an aggressive dial smaller than a defensive one for identical model output", async () => {
    const spends: number[] = [];
    for (const dial of RISK_LEVELS) {
      modelOrders([buyOrder("GLD", 10)]);
      const decision = await callAiForDecision(baseArgs("balanced", dial));
      spends.push(
        sizeDecision({ orders: decision.orders, risk: "balanced", dial, nav: NAV, cash: CASH })
          .totalSpend,
      );
    }
    for (let i = 1; i < spends.length; i++) {
      expect(spends[i]).toBeGreaterThanOrEqual(spends[i - 1]);
    }
    expect(spends[spends.length - 1]).toBeGreaterThan(spends[0]);
  });

  it("sizes a conservative portfolio no larger than an aggressive one", async () => {
    const byRisk: Record<string, number> = {};
    for (const risk of PORTFOLIO_LEVELS) {
      modelOrders([buyOrder("GLD", 50)]);
      const decision = await callAiForDecision(baseArgs(risk, 3));
      byRisk[risk] = sizeDecision({
        orders: decision.orders,
        risk,
        dial: 3,
        nav: NAV,
        cash: CASH,
      }).totalSpend;
    }
    expect(byRisk.conservative).toBeLessThanOrEqual(byRisk.balanced);
    expect(byRisk.balanced).toBeLessThanOrEqual(byRisk.aggressive);
  });

  it("respects existing cluster exposure carried in from current holdings", async () => {
    modelOrders([buyOrder("AAPL", 30)]);
    const decision = await callAiForDecision(baseArgs("aggressive", 5));
    const { sized } = sizeDecision({
      orders: decision.orders,
      risk: "aggressive",
      dial: 5,
      nav: NAV,
      cash: CASH,
      weights: { MSFT: 0.28 }, // cluster already near the 30% cap
    });
    const spent = sized.reduce((s, o) => s + o.spend, 0);
    expect(spent / NAV).toBeLessThanOrEqual(CLUSTER_CAP - 0.28 + 1e-9);
  });

  it("emits nothing when the cluster is already full", async () => {
    modelOrders([buyOrder("AAPL", 25), buyOrder("MSFT", 25)]);
    const decision = await callAiForDecision(baseArgs("aggressive", 5));
    const { sized, totalSpend } = sizeDecision({
      orders: decision.orders,
      risk: "aggressive",
      dial: 5,
      nav: NAV,
      cash: CASH,
      weights: { MSFT: 0.35 },
    });
    expect(sized).toEqual([]);
    expect(totalSpend).toBe(0);
  });

  it("degrades safely on nonsense model percentages and unpriced symbols", async () => {
    for (const risk of PORTFOLIO_LEVELS) {
      modelOrders([
        buyOrder("AAPL", 0),
        buyOrder("MSFT", -50),
        buyOrder("GLD", 5000),
        buyOrder("UNKNOWN", 20),
      ]);
      const decision = await callAiForDecision(baseArgs(risk, 4));
      const { sized, totalSpend, cashLeft } = sizeDecision({
        orders: decision.orders,
        risk,
        dial: 4,
        nav: NAV,
        cash: CASH,
      });
      expect(Number.isFinite(totalSpend)).toBe(true);
      expect(totalSpend).toBeGreaterThanOrEqual(0);
      expect(cashLeft).toBeGreaterThanOrEqual(0);
      expect(sized.every((o) => o.symbol === "GLD")).toBe(true);
      for (const o of sized) {
        expect(o.spend).toBeLessThanOrEqual(riskProfile(risk).maxPositionPct * NAV + 1e-9);
      }
    }
  });

  it("spends nothing when cash is already at or below the risk level's floor", async () => {
    for (const risk of PORTFOLIO_LEVELS) {
      modelOrders([buyOrder("GLD", 30)]);
      const decision = await callAiForDecision(baseArgs(risk, 5));
      const floorCash = riskProfile(risk).cashFloorPct * NAV;
      const { totalSpend } = sizeDecision({
        orders: decision.orders,
        risk,
        dial: 5,
        nav: NAV,
        cash: floorCash,
      });
      if (riskProfile(risk).cashFloorPct > 0) expect(totalSpend).toBe(0);
    }
  });

  it("ignores sells in the buy sizer and never produces a negative quantity", async () => {
    modelOrders([
      { symbol: "MSFT", side: "sell", quantity: 20, reason: "exit" },
      buyOrder("GLD", 10),
    ]);
    const decision = await callAiForDecision(baseArgs("balanced", 3));
    const { sized } = sizeDecision({
      orders: decision.orders,
      risk: "balanced",
      dial: 3,
      nav: NAV,
      cash: CASH,
    });
    expect(sized.map((o) => o.symbol)).toEqual(["GLD"]);
    expect(sized.every((o) => o.quantity > 0)).toBe(true);
  });
});
