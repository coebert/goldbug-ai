// Property-based fuzz tests for the decision → sizing path.
//
// The example-based tests pin known cases; these assert the *laws* that must
// hold for any input the model or the market can produce:
//   * determinism   — same inputs ⇒ byte-identical sizing and decision output
//   * totality      — never NaN/Infinity/negative, whatever the input
//   * monotonicity  — spend is non-decreasing in the risk dial and in budget,
//                     and non-increasing in realised volatility
//   * cap safety    — spend never exceeds the position cap, the cluster
//                     headroom, or the investable budget
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

type Any = Record<string, unknown>;

const { generateText, NoObjectGeneratedError } = vi.hoisted(() => {
  class NoObjectGeneratedError extends Error {
    text?: string;
    static isInstance(e: unknown): boolean {
      return e instanceof NoObjectGeneratedError;
    }
  }
  const generateText = vi.fn(async (_args?: Any): Promise<{ output: Any }> => ({
    output: { briefing: "b", rationale: "r", orders: [] as Any[] },
  }));
  return { generateText, NoObjectGeneratedError };
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
import type { Portfolio } from "../types";
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
  price: number;
  percent: number;
  realizedVol: number;
  clusterWeightBefore: number;
  symbol?: string;
};

/** Production composition, single order: percent → vol → cluster → dial → cash → qty. */
function sizeOne(i: SizeInputs): { spend: number; quantity: number; headroom: number } {
  const symbol = i.symbol ?? "AAA";
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
    currentWeights: { BBB: Math.max(0, i.clusterWeightBefore) },
    proposedSymbol: symbol,
    proposedWeight: vol.fraction,
    clusters: CLUSTERS,
    clusterCap: CLUSTER_CAP,
  });
  const headroom = Math.max(0, (CLUSTER_CAP - cluster.cluster_weight_before) * nav);
  const wanted = aggressiveBuySpend(cluster.allowed_weight * nav, agg);
  const capped = Math.min(wanted, profile.maxPositionPct * nav, budget, headroom);

  const price = i.price;
  if (!Number.isFinite(price) || !(price > 0) || !(capped > 0)) {
    return { spend: 0, quantity: 0, headroom };
  }
  const quantity = Math.floor(capped / price);
  const spend = quantity > 0 ? quantity * price : 0;
  return { spend: Math.max(0, spend), quantity: Math.max(0, quantity), headroom };
}

const arbRisk = fc.constantFrom(...PORTFOLIO_LEVELS);
const arbDial = fc.constantFrom(...RISK_LEVELS);
const num = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

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

describe("fuzz: order sizing is total and deterministic", () => {
  it("never emits NaN, Infinity, negative spend, or a fractional quantity", () => {
    fc.assert(
      fc.property(
        arbRisk,
        arbDial,
        num(0, 5_000_000),
        num(0, 5_000_000),
        num(0, 100_000),
        num(-500, 5_000),
        num(-5, 50),
        num(0, 1),
        (risk, dial, nav, cash, price, percent, vol, before) => {
          const r = sizeOne({
            risk, dial, nav, cash, price, percent, realizedVol: vol, clusterWeightBefore: before,
          });
          expect(Number.isFinite(r.spend)).toBe(true);
          expect(r.spend).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(r.quantity)).toBe(true);
          expect(r.quantity).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("is pure — repeated calls with identical inputs give identical output", () => {
    fc.assert(
      fc.property(
        arbRisk, arbDial, num(1, 1_000_000), num(0, 1_000_000), num(0.01, 10_000),
        num(0, 100), num(0.001, 5), num(0, 0.35),
        (risk, dial, nav, cash, price, percent, vol, before) => {
          const args = {
            risk, dial, nav, cash, price, percent, realizedVol: vol, clusterWeightBefore: before,
          };
          expect(sizeOne(args)).toEqual(sizeOne(args));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never breaches the position cap, cluster headroom, or investable budget", () => {
    fc.assert(
      fc.property(
        arbRisk, arbDial, num(1, 2_000_000), num(0, 2_000_000), num(0.01, 5_000),
        num(0, 200), num(0.001, 3), num(0, 0.5),
        (risk, dial, nav, cash, price, percent, vol, before) => {
          const r = sizeOne({
            risk, dial, nav, cash, price, percent, realizedVol: vol, clusterWeightBefore: before,
          });
          const profile = riskProfile(risk);
          const budget = Math.max(0, cash - profile.cashFloorPct * nav);
          const tol = 1e-6 * Math.max(1, nav);
          expect(r.spend).toBeLessThanOrEqual(profile.maxPositionPct * nav + tol);
          expect(r.spend).toBeLessThanOrEqual(budget + tol);
          expect(r.spend).toBeLessThanOrEqual(r.headroom + tol);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("fuzz: order sizing monotonicity laws", () => {
  const base = { nav: 250_000, clusterWeightBefore: 0 };

  it("is non-decreasing in the risk dial", () => {
    fc.assert(
      fc.property(
        arbRisk, num(0, 250_000), num(0.5, 2_000), num(0, 60), num(0.01, 2),
        (risk, cash, price, percent, vol) => {
          const spends = RISK_LEVELS.map(
            (dial) =>
              sizeOne({ ...base, risk, dial, cash, price, percent, realizedVol: vol }).spend,
          );
          for (let i = 1; i < spends.length; i++) {
            expect(spends[i]).toBeGreaterThanOrEqual(spends[i - 1] - 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is non-increasing in realised volatility", () => {
    fc.assert(
      fc.property(
        arbRisk, arbDial, num(0, 250_000), num(0.5, 2_000), num(0, 60),
        (risk, dial, cash, price, percent) => {
          const vols = [0.02, 0.08, 0.15, 0.3, 0.6, 1.2];
          const spends = vols.map(
            (v) => sizeOne({ ...base, risk, dial, cash, price, percent, realizedVol: v }).spend,
          );
          for (let i = 1; i < spends.length; i++) {
            expect(spends[i]).toBeLessThanOrEqual(spends[i - 1] + 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is non-decreasing in available cash and non-increasing in prior cluster weight", () => {
    fc.assert(
      fc.property(
        arbRisk, arbDial, num(0.5, 2_000), num(0, 60), num(0.01, 2),
        (risk, dial, price, percent, vol) => {
          const cashes = [0, 5_000, 25_000, 100_000, 250_000];
          const bySpend = cashes.map(
            (cash) => sizeOne({ ...base, risk, dial, cash, price, percent, realizedVol: vol }).spend,
          );
          for (let i = 1; i < bySpend.length; i++) {
            expect(bySpend[i]).toBeGreaterThanOrEqual(bySpend[i - 1] - 1e-9);
          }

          const befores = [0, 0.05, 0.15, 0.25, 0.3, 0.45];
          const byCluster = befores.map(
            (b) =>
              sizeOne({
                nav: base.nav, risk, dial, cash: 250_000, price, percent,
                realizedVol: vol, clusterWeightBefore: b,
              }).spend,
          );
          for (let i = 1; i < byCluster.length; i++) {
            expect(byCluster[i]).toBeLessThanOrEqual(byCluster[i - 1] + 1e-9);
          }
        },
      ),
      { numRuns: 250 },
    );
  });

  it("sizes a conservative portfolio no larger than an aggressive one", () => {
    fc.assert(
      fc.property(
        arbDial, num(0, 250_000), num(0.5, 2_000), num(0, 100), num(0.01, 2),
        (dial, cash, price, percent, vol) => {
          const spends = PORTFOLIO_LEVELS.map(
            (risk) =>
              sizeOne({ ...base, risk, dial, cash, price, percent, realizedVol: vol }).spend,
          );
          expect(spends[0]).toBeLessThanOrEqual(spends[1] + 1e-9);
          expect(spends[1]).toBeLessThanOrEqual(spends[2] + 1e-9);
        },
      ),
      { numRuns: 250 },
    );
  });
});

function portfolio(risk: PortfolioRisk, dial: number): Portfolio {
  return {
    id: "p1",
    currency: "GBP",
    starting_cash: 100_000,
    risk_level: risk,
    risk_config: { risk_level: dial },
  } as unknown as Portfolio;
}

function args(risk: PortfolioRisk, dial: number, cashValue: number, totalValue: number) {
  return {
    portfolio: portfolio(risk, dial),
    holdings: [],
    cashValue,
    totalValue,
    features: [],
    news: [],
    crossAsset: "CROSS-ASSET",
    optionsBlock: "OPTIONS",
    crossSectional: "XSECTION",
    events: [],
    cooling: [],
    asOf: "2026-08-03",
    regime: {
      as_of: "2026-08-03",
      regime: "risk_on",
      confidence: 0.75,
      previous_regime: null,
      transitioned: false,
      notes: "n",
    },
    learning: {},
  } as unknown as Parameters<typeof callAiForDecision>[0];
}

describe("fuzz: ai-decision output is total and sizeable", () => {
  it("produces deterministic prompts and schema-valid orders for arbitrary budgets", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRisk, arbDial, num(0, 10_000_000), num(0, 10_000_000), num(0, 100),
        async (risk, dial, cash, total, percent) => {
          const seen: string[] = [];
          generateText.mockImplementation(async (a?: Any) => {
            seen.push(`${String(a?.system)}|${String(a?.prompt)}`);
            return {
              output: {
                briefing: "b",
                rationale: "r",
                orders: [
                  {
                    symbol: "AAA",
                    side: "buy",
                    percent,
                    conviction: 0.5,
                    reason: "fuzz",
                    signal_weights: {
                      sma_trend: 20, rsi: 20, price_change: 20, news_sentiment: 20, volatility: 20,
                    },
                  },
                ],
              },
            };
          });

          const a = await callAiForDecision(args(risk, dial, cash, total));
          const b = await callAiForDecision(args(risk, dial, cash, total));
          expect(seen[0]).toBe(seen[1]);
          expect(a.orders).toEqual(b.orders);

          for (const o of a.orders) {
            const r = sizeOne({
              risk, dial, nav: total, cash, price: 123.45,
              percent: typeof o.percent === "number" ? o.percent : 0,
              realizedVol: 0.2, clusterWeightBefore: 0,
            });
            expect(Number.isFinite(r.spend)).toBe(true);
            expect(r.spend).toBeGreaterThanOrEqual(0);
            expect(r.spend).toBeLessThanOrEqual(
              Math.max(0, cash - riskProfile(risk).cashFloorPct * Math.max(0, total)) + 1e-6,
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("degrades to a total, sizeable heuristic decision when the gateway fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRisk, arbDial, num(0, 1_000_000), num(0.5, 5_000),
        async (risk, dial, cash, price) => {
          generateText.mockImplementation(async () => {
            // Terminal status: the production path skips its retry/backoff
            // ladder, so the property runs without real 2s/4s sleeps.
            throw Object.assign(new Error("403 Forbidden"), { statusCode: 403 });
          });
          const out = await callAiForDecision(args(risk, dial, cash, cash));
          expect(typeof out.briefing).toBe("string");
          for (const o of out.orders) {
            if (o.side !== "buy") continue;
            const r = sizeOne({
              risk, dial, nav: cash, cash, price,
              percent: typeof o.percent === "number" ? o.percent : 0,
              realizedVol: 0.2, clusterWeightBefore: 0,
            });
            expect(Number.isFinite(r.spend)).toBe(true);
            expect(r.spend).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
