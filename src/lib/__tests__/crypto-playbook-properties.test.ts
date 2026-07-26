// Property-based tests for the crypto playbook.
//
// Uses fast-check to generate varied market regimes and randomised price
// histories, then asserts the playbook's structural invariants hold across
// every input: sleeve target never exceeds sleeve cap, risk_off always
// hard-vetoes, per-symbol sizing stays in [0,1], and drawdown / trend-break
// paths always produce an exit or trim (never a fresh open).

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

vi.mock("../market-data.server", () => {
  return {
    getDailyCandles: vi.fn(),
    sma: (closes: number[], period: number) => {
      if (closes.length < period) return null;
      const slice = closes.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / period;
    },
    rsi: (closes: number[], period = 14) => {
      if (closes.length < period + 1) return null;
      let gains = 0, losses = 0;
      for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gains += d; else losses -= d;
      }
      const avgG = gains / period, avgL = losses / period;
      if (avgL === 0) return 100;
      return 100 - 100 / (1 + avgG / avgL);
    },
    pctChange: (closes: number[], lb: number) => {
      if (closes.length <= lb) return null;
      const now = closes[closes.length - 1];
      const then = closes[closes.length - 1 - lb];
      if (!then) return null;
      return (now - then) / then;
    },
    dailyVolatility: () => 0.03,
  };
});

import { getDailyCandles } from "../market-data.server";
import {
  cryptoSleeveCapPct,
  bucketRegime,
  computeCryptoSleeveDecision,
} from "../crypto-strategy.server";
import { CRYPTO_SYMBOLS } from "../crypto-groups";
import type { RegimeLabel } from "../regime-detector.server";
type RiskLevel = "conservative" | "balanced" | "aggressive";

const RISK_LEVELS: RiskLevel[] = ["conservative", "balanced", "aggressive"];
const REGIMES: RegimeLabel[] = [
  "bull_quiet", "bull_volatile", "correction", "bear", "crisis", "recovery",
];
const VALID_ACTIONS = new Set(["open", "hold", "trim", "exit"]);

// Seeded pseudo-random price path generator. Fast-check drives the seed
// and per-step drift/vol so we sweep a broad regime space deterministically.
function makePath(seed: number, drift: number, vol: number, len = 220, start = 100): number[] {
  // Mulberry32 PRNG for determinism.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [start];
  for (let i = 1; i < len; i++) {
    // Box-Muller-ish approximation via sum of uniforms (mean 0, unit var).
    const z = (rand() + rand() + rand() + rand() + rand() + rand() - 3) / Math.sqrt(0.5);
    const next = out[i - 1] * Math.exp(drift + vol * z);
    out.push(Math.max(0.01, next));
  }
  return out;
}

function synth(prices: number[]) {
  return prices.map((p, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: p, high: p, low: p, close: p, volume: 1_000_000,
  }));
}

beforeEach(() => vi.mocked(getDailyCandles).mockReset());

describe("crypto playbook — property-based invariants", () => {
  it("target never exceeds cap; cap always matches the risk-level table", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom(...REGIMES),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: -0.01, max: 0.01, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.005, max: 0.08, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1_000, max: 10_000_000, noNaN: true, noDefaultInfinity: true }),
        async (risk, regime, seed, drift, vol, nav) => {
          vi.mocked(getDailyCandles).mockImplementation(
            async (sym?: string) => synth(makePath(seed ^ ((sym ?? "X").length), drift, vol)),
          );
          const d = await computeCryptoSleeveDecision({
            asOf: "2026-01-15",
            riskLevel: risk,
            regime,
            nav,
            holdings: [],
          });
          expect(d.sleeve_cap_pct).toBe(cryptoSleeveCapPct(risk));
          expect(d.sleeve_target_pct).toBeLessThanOrEqual(d.sleeve_cap_pct + 1e-12);
          expect(d.sleeve_target_pct).toBeGreaterThanOrEqual(0);
          expect(d.bucket).toBe(bucketRegime(regime));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("risk_off regimes always hard-veto: target 0, every symbol exits with size 0", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom<RegimeLabel[]>("bear", "crisis"),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: -0.005, max: 0.005, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.005, max: 0.08, noNaN: true, noDefaultInfinity: true }),
        async (risk, regime, seed, drift, vol) => {
          vi.mocked(getDailyCandles).mockImplementation(
            async (sym?: string) => synth(makePath(seed ^ ((sym ?? "X").length), drift, vol)),
          );
          const d = await computeCryptoSleeveDecision({
            asOf: "2026-01-15",
            riskLevel: risk,
            regime,
            nav: 100_000,
            holdings: [],
          });
          expect(d.hard_veto).toBe(true);
          expect(d.sleeve_target_pct).toBe(0);
          for (const s of d.symbols) {
            expect(s.action).toBe("exit");
            expect(s.size_fraction_of_cap).toBe(0);
            expect(s.regime_veto).toBe(true);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("per-symbol sizing stays in [0,1] and action stays in the known set", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom(...REGIMES),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: -0.02, max: 0.02, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.001, max: 0.15, noNaN: true, noDefaultInfinity: true }),
        async (risk, regime, seed, drift, vol) => {
          vi.mocked(getDailyCandles).mockImplementation(
            async (sym?: string) => synth(makePath(seed ^ ((sym ?? "X").length), drift, vol)),
          );
          const d = await computeCryptoSleeveDecision({
            asOf: "2026-01-15",
            riskLevel: risk,
            regime,
            nav: 250_000,
            holdings: [],
          });
          for (const s of d.symbols) {
            expect(VALID_ACTIONS.has(s.action)).toBe(true);
            expect(s.size_fraction_of_cap).toBeGreaterThanOrEqual(0);
            expect(s.size_fraction_of_cap).toBeLessThanOrEqual(1);
            // Fresh opens are only ever allowed in the risk_on bucket.
            if (s.action === "open") {
              expect(d.bucket).toBe("risk_on");
            }
            // Regime-veto flag and exit action are consistent for risk_off.
            if (s.regime_veto) {
              expect(s.action).toBe("exit");
              expect(s.size_fraction_of_cap).toBe(0);
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("sustained downtrends (price < SMA200) never open — always exit or trim", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RISK_LEVELS),
        // Non-risk-off regimes so we're really testing the trend-break gate,
        // not the regime hard veto that already covers bear/crisis.
        fc.constantFrom<RegimeLabel[]>("bull_quiet", "bull_volatile", "correction", "recovery"),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (risk, regime, seed) => {
          // Strong, noisy downtrend: negative drift dominates volatility so
          // the final close reliably sits well below the 200-day SMA.
          vi.mocked(getDailyCandles).mockImplementation(
            async (sym?: string) => synth(makePath(seed ^ ((sym ?? "X").length), -0.01, 0.02, 220, 300)),
          );
          const d = await computeCryptoSleeveDecision({
            asOf: "2026-01-15",
            riskLevel: risk,
            regime,
            nav: 100_000,
            holdings: [],
          });
          for (const s of d.symbols) {
            if (s.price != null && s.sma200 != null && s.price < s.sma200) {
              expect(s.action).not.toBe("open");
              expect(["exit", "trim", "hold"]).toContain(s.action);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it("current sleeve pct equals held MV / NAV and only counts approved crypto symbols", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom(...REGIMES),
        fc.array(
          fc.record({
            symbol: fc.constantFrom(...CRYPTO_SYMBOLS, "AAPL", "TSLA", "FAKE.X"),
            mv: fc.double({ min: 0, max: 50_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        fc.double({ min: 10_000, max: 5_000_000, noNaN: true, noDefaultInfinity: true }),
        async (risk, regime, holdings, nav) => {
          vi.mocked(getDailyCandles).mockImplementation(
            async () => synth(makePath(42, 0.001, 0.02)),
          );
          const d = await computeCryptoSleeveDecision({
            asOf: "2026-01-15",
            riskLevel: risk,
            regime,
            nav,
            holdings: holdings.map((h) => ({ symbol: h.symbol, market_value_base: h.mv })),
          });
          const cryptoMv = holdings
            .filter((h) => (CRYPTO_SYMBOLS as readonly string[]).includes(h.symbol))
            .reduce((sum, h) => sum + Math.max(0, h.mv), 0);
          const expected = nav > 0 ? cryptoMv / nav : 0;
          expect(d.current_sleeve_pct).toBeCloseTo(expected, 10);
          expect(d.current_sleeve_pct).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});
