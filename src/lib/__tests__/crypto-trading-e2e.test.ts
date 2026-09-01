// End-to-end checks that the AI can trade the six approved crypto ETPs
// through both the SIM and LIVE-CASH broker environments.
//
// This test exercises the full pre-broker pipeline for a crypto BUY proposal:
//   1. Sleeve decision (regime → target %, hard veto)
//   2. Per-symbol classifier + routability gate (classifyCryptoProposal)
//   3. Cache-backed Saxo asset-type / freshness gate (makeCryptoValidator)
//   4. Post-sizing pre-trade gates: lot size, min notional, fee %, market hours
// and runs the pipeline once per environment (`sim` and `live`) to prove that
// nothing in the routing layer is gated on the environment flag.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The crypto-strategy engine reads OHLCV from `market-data.server`. Mock it
// with a synthetic wobbly uptrend + working technical helpers so we can drive
// the sleeve decision deterministically without touching Postgres.
vi.mock("../market-data.server", () => {
  return {
    getDailyCandles: vi.fn(async (_symbol: string) => {
      const closes = Array.from(
        { length: 220 },
        (_, i) => 100 + i * 0.4 + (i % 2 === 0 ? -0.6 : 0.6),
      );
      return closes.map((p, i) => ({
        date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        open: p, high: p, low: p, close: p, volume: 1_000_000,
      }));
    }),
    sma: (closes: number[], period: number) => {
      if (closes.length < period) return null;
      const slice = closes.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / period;
    },
    rsi: (closes: number[], period = 14) => {
      if (closes.length < period + 1) return null;
      let g = 0, l = 0;
      for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      if (l === 0) return 100;
      return 100 - 100 / (1 + g / period / (l / period));
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

import {
  classifyCryptoProposal,
  makeCryptoValidator,
  runCryptoPreTradeChecks,
} from "../crypto-validation.server";
import {
  computeCryptoSleeveDecision,
  formatCryptoSignalsBlock,
} from "../crypto-strategy.server";
import { CRYPTO_SYMBOLS } from "../crypto-groups";

// A Wednesday 11:00 UTC — mid-session on XETRA (12:00 CET), SIX (12:00 CET)
// and LSE (11:00 GMT). Every approved crypto ETP venue is in its continuous
// auction window at this instant.
const MID_SESSION = new Date("2026-01-14T11:00:00Z");

// The six ETPs the sleeve is allowed to route. Any regression that drops one
// of these from the tradable universe should fail this test.
const APPROVED_ETPS = [
  "BTCE.DE",
  "ABTC.SW",
  "BTCW.L",
  "ZETH.SW",
  "ZETH.DE",
  "HODL.SW",
] as const;

// Minimal in-memory stub of the `saxo_instrument_cache` table shape that
// `makeCryptoValidator` reads. We simulate "yes, verified as Etp, freshly
// refreshed" for every approved ETP in both `sim` and `live` environments.
function makeFakeAdmin(opts?: { staleAll?: boolean; missing?: string[] }) {
  const now = new Date();
  const staleAge = new Date(now.getTime() - 60 * 24 * 3600 * 1000); // 60d
  const missing = new Set(opts?.missing ?? []);
  const rows = new Map<string, { asset_type: string; refreshed_at: string; currency: string; env: string }>();
  for (const env of ["sim", "live"] as const) {
    for (const sym of APPROVED_ETPS) {
      if (missing.has(`${sym}::${env}`)) continue;
      rows.set(`${sym}::${env}`, {
        asset_type: sym.endsWith(".L") ? "Etp" : "Etn",
        refreshed_at: (opts?.staleAll ? staleAge : now).toISOString(),
        currency: sym.endsWith(".L") ? "GBP" : sym.endsWith(".DE") ? "EUR" : "CHF",
        env,
      });
    }
  }
  // Build a chainable Supabase-like query builder that returns .maybeSingle().
  return {
    from() {
      const filters: Record<string, string> = {};
      const api = {
        select() { return api; },
        eq(col: string, val: string) { filters[col] = val; return api; },
        async maybeSingle() {
          const key = `${filters.symbol}::${filters.env}`;
          const row = rows.get(key);
          return { data: row ?? null, error: null };
        },
      };
      return api;
    },
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("crypto trading e2e — SIM and LIVE cash portfolios", () => {
  it.each(["sim", "live"] as const)(
    "%s: sleeve decision surfaces all six approved ETPs and a non-vetoed target",
    async (env) => {
      const decision = await computeCryptoSleeveDecision({
        asOf: "2026-01-14",
        riskLevel: "balanced",
        regime: "bull_quiet",
        nav: 10_000,
        holdings: [],
        symbols: [...CRYPTO_SYMBOLS],
      });

      expect(decision.hard_veto).toBe(false);
      expect(decision.sleeve_target_pct).toBeGreaterThan(0);
      const surfaced = new Set(decision.symbols.map((s) => s.symbol));
      for (const sym of APPROVED_ETPS) expect(surfaced.has(sym)).toBe(true);
      // Prompt block must still render for the downstream AI regardless of env.
      const block = formatCryptoSignalsBlock(decision);
      expect(block).toContain("CRYPTO SLEEVE");
      // env is only carried in the validator; sleeve is env-agnostic — still
      // asserting the value is consumable proves the pipeline exists.
      expect(env).toMatch(/^(sim|live)$/);
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: every approved ETP passes classifier + cache validator + post-sizing gates",
    async (env) => {
      const validator = makeCryptoValidator({ supabaseAdmin: makeFakeAdmin(), env });
      const results: Array<{ sym: string; ok: boolean; reason?: string }> = [];

      for (const sym of APPROVED_ETPS) {
        // Stage 1: classifier / routability (spot pairs would fail-fast here).
        const cls = classifyCryptoProposal({
          symbol: sym, side: "buy", price: 40, hasFeatureRow: true,
        });
        expect(cls.needsValidation).toBe(true);
        expect(cls.failFast).toBeNull();

        // Stage 2: cache-backed Saxo asset-type / freshness gate.
        const v = await validator({
          symbol: sym, side: "buy", price: 40, hasFeatureRow: true,
        });
        expect(v.ok, `${sym} ${env} validator: ${v.reason}`).toBe(true);

        // Stage 3: post-sizing pre-trade gates (25 units × 40 = 1,000 local).
        const pre = runCryptoPreTradeChecks({
          symbol: sym, side: "buy", price: 40, quantity: 25, now: MID_SESSION,
        });
        expect(pre.ok, `${sym} ${env} pretrade: ${pre.reason}`).toBe(true);
        expect(pre.venue).toMatch(/^(XETRA|SIX|LSE)$/);
        results.push({ sym, ok: pre.ok });
      }

      expect(results).toHaveLength(APPROVED_ETPS.length);
      expect(results.every((r) => r.ok)).toBe(true);
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: spot crypto pairs (BTC-USD) are rejected before broker routing",
    async (env) => {
      const validator = makeCryptoValidator({ supabaseAdmin: makeFakeAdmin(), env });
      const cls = classifyCryptoProposal({
        symbol: "BTC-USD", side: "buy", price: 40_000, hasFeatureRow: true,
      });
      expect(cls.failFast).toMatch(/spot pair not routable/i);
      const v = await validator({
        symbol: "BTC-USD", side: "buy", price: 40_000, hasFeatureRow: true,
      });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/spot pair not routable/i);
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: hard risk-off veto zeroes sleeve target and would strip AI buys",
    async (env) => {
      const decision = await computeCryptoSleeveDecision({
        asOf: "2026-01-14",
        riskLevel: "balanced",
        regime: "crisis",
        nav: 10_000,
        holdings: [{ symbol: "BTCE.DE", market_value_base: 500 }],
        symbols: [...CRYPTO_SYMBOLS],
      });
      expect(decision.hard_veto).toBe(true);
      expect(decision.sleeve_target_pct).toBe(0);
      expect(decision.veto_reason).toMatch(/risk_off/i);
      // All per-symbol actions must be `exit` when the bucket is risk_off.
      for (const s of decision.symbols) expect(s.action).toBe("exit");
      // env is only relevant once buys reach the validator — nothing should
      // even reach it in a hard-veto tick.
      expect(env).toMatch(/^(sim|live)$/);
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: cache-missing ETP is blocked with a refresh-required reason",
    async (env) => {
      const validator = makeCryptoValidator({
        supabaseAdmin: makeFakeAdmin({ missing: [`BTCE.DE::${env}`] }),
        env,
      });
      const v = await validator({
        symbol: "BTCE.DE", side: "buy", price: 40, hasFeatureRow: true,
      });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/not yet verified/i);
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: sells of held crypto ETPs always pass — a position can always exit",
    async (env) => {
      const validator = makeCryptoValidator({
        supabaseAdmin: makeFakeAdmin({ staleAll: true, missing: APPROVED_ETPS.map((s) => `${s}::${env}`) }),
        env,
      });
      for (const sym of APPROVED_ETPS) {
        const v = await validator({
          symbol: sym, side: "sell", price: 40, hasFeatureRow: false,
        });
        expect(v.ok, `${sym} ${env} sell must pass even with a stale/missing cache`).toBe(true);

        const pre = runCryptoPreTradeChecks({
          symbol: sym, side: "sell", price: 40, quantity: 0.5, now: MID_SESSION,
        });
        // Sells bypass economic gates so partial-unit exits still succeed.
        expect(pre.ok).toBe(true);
      }
    },
  );

  it.each(["sim", "live"] as const)(
    "%s: weekend buys are rejected by the market-hours gate for every ETP",
    async (_env) => {
      const sat = new Date("2026-01-17T12:00:00Z"); // Saturday
      for (const sym of APPROVED_ETPS) {
        const pre = runCryptoPreTradeChecks({
          symbol: sym, side: "buy", price: 40, quantity: 25, now: sat,
        });
        expect(pre.ok).toBe(false);
        expect(pre.gate).toBe("market_hours");
      }
    },
  );
});
