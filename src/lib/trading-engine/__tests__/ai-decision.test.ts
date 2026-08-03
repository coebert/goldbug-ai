// Focused unit tests for the extracted `callAiForDecision` module.
//
// Two things must stay deterministic here:
//   1. The prompt we build — same inputs must produce byte-identical system /
//      user text, and the hard-rule numbers must track the portfolio's risk
//      level and risk_config overrides exactly.
//   2. The failure path — a gateway error, a parse failure or a timeout must
//      never throw; they must degrade to the heuristic decision with fixed
//      conviction/weight shapes so downstream guardrails keep running.
//
// Everything external (AI SDK, Supabase, market data) is faked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    starting_cash: 10000,
    risk_level: "balanced",
    risk_config: null,
    ...over,
  } as unknown as Portfolio;
}

function holding(symbol: string, quantity: number): Holding {
  return { symbol, quantity, avg_cost: 100 } as unknown as Holding;
}

type Feature = Parameters<typeof callAiForDecision>[0]["features"][number];
function feature(over: Partial<Feature> & { symbol: string }): Feature {
  return {
    rsi14: 55,
    change5d: 0.01,
    change30d: 0.05,
    macd_hist: 0.2,
    asset_class: "stock",
    ...over,
  } as unknown as Feature;
}

function baseArgs(over: Partial<Parameters<typeof callAiForDecision>[0]> = {}) {
  return {
    portfolio: portfolio(),
    holdings: [],
    cashValue: 5000,
    totalValue: 10000,
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

beforeEach(() => {
  calls.length = 0;
  generateText.mockClear();
  generateText.mockImplementation(async (a: Any): Promise<{ output: Any }> => {
    calls.push({ system: String(a.system), prompt: String(a.prompt) });
    return { output: { briefing: "b", rationale: "r", orders: [] } };
  });
  process.env.LOVABLE_API_KEY = "test-key";
  delete process.env.HEURISTIC_BUYS_ENABLED;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("callAiForDecision — configuration guards", () => {
  it("throws when the gateway key is missing (never silently trades)", async () => {
    delete process.env.LOVABLE_API_KEY;
    await expect(callAiForDecision(baseArgs())).rejects.toThrow("LOVABLE_API_KEY missing");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns the model's structured output verbatim on the happy path", async () => {
    generateText.mockImplementationOnce(async () => ({
      output: {
        briefing: "calm",
        rationale: "why",
        orders: [
          {
            symbol: "AAPL",
            side: "buy",
            percent: 10,
            conviction: 0.6,
            reason: "trend",
            signal_weights: {
              sma_trend: 40,
              rsi: 20,
              price_change: 20,
              news_sentiment: 10,
              volatility: 10,
            },
          },
        ],
      },
    }));
    const out = await callAiForDecision(baseArgs());
    expect(out.orders).toHaveLength(1);
    expect(out.orders[0]).toMatchObject({ symbol: "AAPL", side: "buy", percent: 10 });
  });
});

describe("callAiForDecision — deterministic prompt construction", () => {
  it("produces byte-identical prompts for identical inputs", async () => {
    await callAiForDecision(baseArgs());
    await callAiForDecision(baseArgs());
    expect(calls[0].system).toBe(calls[1].system);
    expect(calls[0].prompt).toBe(calls[1].prompt);
  });

  it("encodes the per-risk-level position cap and cash floor", async () => {
    const caps: Record<string, { pos: string; cash: string }> = {};
    for (const level of ["conservative", "balanced", "aggressive"] as const) {
      calls.length = 0;
      await callAiForDecision(baseArgs({ portfolio: portfolio({ risk_level: level }) }));
      const sys = calls[0].system;
      caps[level] = {
        pos: sys.match(/may exceed (\d+)% of portfolio value/)![1],
        cash: sys.match(/at least (\d+)% of portfolio value in cash/)![1],
      };
    }
    expect(caps.conservative).toEqual({ pos: "10", cash: "20" });
    expect(caps.balanced).toEqual({ pos: "15", cash: "10" });
    expect(caps.aggressive).toEqual({ pos: "25", cash: "0" });
  });

  it("lets risk_config overrides win over the level preset", async () => {
    await callAiForDecision(
      baseArgs({
        portfolio: portfolio({
          risk_level: "aggressive",
          risk_config: { per_symbol_limit_pct: 0.05, cash_floor_pct: 0.4 } as never,
        }),
      }),
    );
    expect(calls[0].system).toContain("may exceed 5% of portfolio value");
    expect(calls[0].system).toContain("at least 40% of portfolio value in cash");
  });

  it("renders the no-events and no-cooldown branches explicitly", async () => {
    await callAiForDecision(baseArgs());
    expect(calls[0].system).toContain("UPCOMING KNOWN EVENTS: none tracked");
    expect(calls[0].system).not.toContain("LOSS COOLDOWN active");
  });

  it("lists events and cooling symbols when present", async () => {
    await callAiForDecision(
      baseArgs({
        events: [
          {
            event_date: "2026-08-04",
            kind: "earnings",
            symbol: "MSFT",
            title: "Q4",
            impact: "high",
          },
        ],
        cooling: ["TSLA", "NVDA"],
      }),
    );
    expect(calls[0].system).toContain("2026-08-04 [high] earnings MSFT: Q4");
    expect(calls[0].system).toContain("LOSS COOLDOWN active for: TSLA, NVDA");
  });

  it("caps the headline block at 15 items and formats missing sentiment as '?'", async () => {
    const news = Array.from({ length: 20 }, (_, i) => ({
      headline: `H${i}`,
      source: "wire",
      sentiment: i === 0 ? null : 0.5,
    }));
    await callAiForDecision(baseArgs({ news }));
    const prompt = calls[0].prompt;
    expect(prompt).toContain("1. [wire] (sent ?) H0");
    expect(prompt).toContain("15. [wire] (sent 0.50) H14");
    expect(prompt).not.toContain("H15");
  });

  it("summarises holdings as numbers, not raw DB strings", async () => {
    await callAiForDecision(
      baseArgs({ holdings: [{ symbol: "AAPL", quantity: "3", avg_cost: "12.5" } as never] }),
    );
    expect(calls[0].prompt).toContain('[{"symbol":"AAPL","quantity":3,"avg_cost":12.5}]');
  });

  it("omits the budget block unless a per-symbol budget is supplied", async () => {
    await callAiForDecision(baseArgs());
    expect(calls[0].prompt).not.toContain("CASH-AWARE BUDGET");
    calls.length = 0;
    await callAiForDecision(baseArgs({ perSymbolBudget: 1234.5, budgetNotes: ["note-a"] }));
    expect(calls[0].prompt).toContain("Per-symbol budget (cap × total, floored at cash): 1234.50 GBP");
    expect(calls[0].prompt).toContain("Minimum trade value: 25.00 GBP");
    expect(calls[0].prompt).toContain("- note-a");
  });

  it("falls back to a stable 'none' line when no exec posts exist", async () => {
    await callAiForDecision(baseArgs());
    expect(calls[0].prompt).toContain("- none in the last 7 days");
    expect(calls[0].prompt).toContain("no study on file yet");
  });
});

describe("callAiForDecision — failure fallback and order sizing", () => {
  const features = [
    // Losers → protective sells (held).
    feature({ symbol: "LOSE", rsi14: 40, change5d: -0.08, change30d: -0.2, macd_hist: -1 }),
    // Momentum names → heuristic buys (unheld).
    feature({ symbol: "MOM1", rsi14: 60, change5d: 0.03, change30d: 0.2 }),
    feature({ symbol: "MOM2", rsi14: 58, change5d: 0.02, change30d: 0.15 }),
    feature({ symbol: "MOM3", rsi14: 56, change5d: 0.015, change30d: 0.1 }),
  ];

  function failWith(error: unknown) {
    generateText.mockImplementation(async () => {
      throw error;
    });
  }

  it("never throws on a gateway error and emits protective sells", async () => {
    failWith(new Error("403 Forbidden"));
    const out = await callAiForDecision(
      baseArgs({ holdings: [holding("LOSE", 10)], features }),
    );
    const sells = out.orders.filter((o) => o.side === "sell");
    expect(sells.map((s) => s.symbol)).toContain("LOSE");
    for (const s of sells) {
      // Full exit, fixed conviction, and weights attributed to price action.
      expect(s.percent).toBe(100);
      expect(s.conviction).toBe(0.5);
      expect(s.signal_weights).toEqual({
        sma_trend: 0,
        rsi: 0,
        price_change: 100,
        news_sentiment: 0,
        volatility: 0,
      });
    }
  });

  it("treats a structured-output parse failure the same as a gateway error", async () => {
    const err = new NoObjectGeneratedError("bad json");
    err.text = "not-json";
    failWith(err);
    const out = await callAiForDecision(baseArgs({ holdings: [holding("LOSE", 10)], features }));
    expect(out.briefing).toContain("AI unavailable");
    expect(out.orders.length).toBeGreaterThan(0);
  });

  it("degrades to a decision (never a throw) when the call times out", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    failWith(abort);
    const out = await callAiForDecision(baseArgs());
    expect(out.orders).toEqual([]);
    expect(out.briefing).toContain("AI unavailable");
  });

  it("sizes fallback buys identically across risk levels (all map to the balanced sleeve)", async () => {
    failWith(new Error("429 rate limited"));
    for (const level of ["conservative", "balanced", "aggressive"] as const) {
      const out = await callAiForDecision(
        baseArgs({ portfolio: portfolio({ risk_level: level }), features }),
      );
      const buys = out.orders.filter((o) => o.side === "buy");
      // riskProfile levels are conservative/balanced/aggressive, while the
      // heuristic sleeve keys off low/high — so every level lands on the
      // balanced default: 2 names at 8% of cash. Pinned deliberately so a
      // future mapping change is a conscious decision.
      expect(buys).toHaveLength(2);
      for (const b of buys) {
        expect(b.percent).toBe(8);
        expect(b.conviction).toBe(0.4);
        const w = b.signal_weights;
        expect(w.sma_trend + w.rsi + w.price_change + w.news_sentiment + w.volatility).toBe(100);
      }
    }
  });

  it("ranks fallback buys deterministically by momentum score", async () => {
    failWith(new Error("network"));
    const a = await callAiForDecision(baseArgs({ features }));
    const b = await callAiForDecision(baseArgs({ features: [...features].reverse() }));
    const symbolsOf = (o: typeof a) => o.orders.filter((x) => x.side === "buy").map((x) => x.symbol);
    expect(symbolsOf(a)).toEqual(["MOM1", "MOM2"]);
    expect(symbolsOf(b)).toEqual(["MOM1", "MOM2"]);
  });

  it("emits no buys when the kill-switch is set, but still exits losers", async () => {
    process.env.HEURISTIC_BUYS_ENABLED = "false";
    failWith(new Error("network"));
    const out = await callAiForDecision(
      baseArgs({ holdings: [holding("LOSE", 10)], features }),
    );
    expect(out.orders.filter((o) => o.side === "buy")).toHaveLength(0);
    expect(out.orders.filter((o) => o.side === "sell")).toHaveLength(1);
  });

  it("returns an empty, schema-valid decision when there is nothing to act on", async () => {
    failWith(new Error("network"));
    const out = await callAiForDecision(baseArgs({ features: [], holdings: [] }));
    expect(out.orders).toEqual([]);
    expect(typeof out.briefing).toBe("string");
    expect(typeof out.rationale).toBe("string");
  });
});
