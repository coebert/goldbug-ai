// Regression tests: lock the crypto sleeve caps, regime→sleeve multipliers,
// and risk-off veto behavior for the six Saxo-tradable crypto ETPs.
//
// These tests are intentionally strict snapshots of the numbers and rules
// callers rely on. If the trading-engine changes any of them, this file
// must fail so the change is a conscious decision rather than a silent
// risk-envelope drift.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../market-data.server", () => ({
  getDailyCandles: vi.fn(async () => []),
  sma: () => null,
  rsi: () => null,
  pctChange: () => null,
  dailyVolatility: () => null,
}));

import {
  cryptoSleeveCapPct,
  bucketRegime,
  computeCryptoSleeveDecision,
} from "../crypto-strategy.server";
import { CRYPTO_SYMBOL_MAP, CRYPTO_SYMBOLS } from "../crypto-groups";
import type { RegimeLabel } from "../regime-detector.server";

// --- Locked universe ---------------------------------------------------------

const APPROVED_ETPS = {
  "BTCE.DE": "BTC",
  "ABTC.SW": "BTC",
  "BTCW.L":  "BTC",
  "ZETH.SW": "ETH",
  "ZETH.DE": "ETH",
  "HODL.SW": "Basket",
} as const;

describe("crypto ETP universe — locked", () => {
  it("exactly the six Saxo-tradable ETPs are approved, with the expected groups", () => {
    expect(CRYPTO_SYMBOL_MAP).toEqual(APPROVED_ETPS);
    expect(CRYPTO_SYMBOLS).toHaveLength(6);
    expect(new Set(CRYPTO_SYMBOLS)).toEqual(new Set(Object.keys(APPROVED_ETPS)));
  });
});

// --- Sleeve caps -------------------------------------------------------------

describe("cryptoSleeveCapPct — locked risk-level table", () => {
  it("conservative caps sleeve at 5% of NAV", () => {
    expect(cryptoSleeveCapPct("conservative")).toBe(0.05);
  });
  it("balanced caps sleeve at 10% of NAV", () => {
    expect(cryptoSleeveCapPct("balanced")).toBe(0.10);
  });
  it("aggressive caps sleeve at 15% of NAV", () => {
    expect(cryptoSleeveCapPct("aggressive")).toBe(0.15);
  });
});

// --- Regime → bucket → multiplier -------------------------------------------

const REGIME_BUCKET: Record<RegimeLabel, "risk_on" | "caution" | "risk_off"> = {
  bull_quiet: "risk_on",
  recovery: "risk_on",
  bull_volatile: "caution",
  correction: "caution",
  bear: "risk_off",
  crisis: "risk_off",
};

// Locked: multiplier applied to sleeve CAP to get sleeve TARGET.
const BUCKET_MULTIPLIER = {
  risk_on: 1.00,
  caution: 0.40,
  risk_off: 0.00,
} as const;

describe("regime → sleeve multiplier — locked mapping", () => {
  it.each(Object.entries(REGIME_BUCKET))(
    "regime %s buckets to %s",
    (regime, bucket) => {
      expect(bucketRegime(regime as RegimeLabel)).toBe(bucket);
    },
  );

  it.each(Object.entries(REGIME_BUCKET) as [RegimeLabel, keyof typeof BUCKET_MULTIPLIER][])(
    "regime %s yields target = cap × %s across all risk levels",
    async (regime, bucket) => {
      const multiplier = BUCKET_MULTIPLIER[bucket];
      for (const risk of ["conservative", "balanced", "aggressive"] as const) {
        const d = await computeCryptoSleeveDecision({
          asOf: "2026-01-15",
          riskLevel: risk,
          regime,
          nav: 100_000,
          holdings: [],
        });
        expect(d.sleeve_cap_pct).toBe(cryptoSleeveCapPct(risk));
        expect(d.bucket).toBe(bucket);
        expect(d.sleeve_target_pct).toBeCloseTo(d.sleeve_cap_pct * multiplier, 12);
      }
    },
  );
});

// --- Risk-off hard veto ------------------------------------------------------

describe("risk-off veto — locked behavior for all six ETPs", () => {
  const RISK_OFF: RegimeLabel[] = ["bear", "crisis"];

  it.each(RISK_OFF)(
    "regime %s hard-vetoes the sleeve: target 0, every approved ETP exits with size 0",
    async (regime) => {
      for (const risk of ["conservative", "balanced", "aggressive"] as const) {
        const d = await computeCryptoSleeveDecision({
          asOf: "2026-01-15",
          riskLevel: risk,
          regime,
          nav: 250_000,
          holdings: [],
        });
        expect(d.hard_veto).toBe(true);
        expect(d.veto_reason).toMatch(/risk_off/);
        expect(d.sleeve_target_pct).toBe(0);
        // Every one of the six ETPs is present and forced to exit at size 0.
        const seen = new Set(d.symbols.map((s) => s.symbol));
        for (const sym of Object.keys(APPROVED_ETPS)) {
          expect(seen.has(sym)).toBe(true);
        }
        for (const s of d.symbols) {
          expect(s.regime_veto).toBe(true);
          expect(s.action).toBe("exit");
          expect(s.size_fraction_of_cap).toBe(0);
        }
      }
    },
  );

  it("non-risk-off regimes do NOT hard-veto (sanity guard on the veto rule)", async () => {
    for (const regime of ["bull_quiet", "bull_volatile", "correction", "recovery"] as RegimeLabel[]) {
      const d = await computeCryptoSleeveDecision({
        asOf: "2026-01-15",
        riskLevel: "balanced",
        regime,
        nav: 100_000,
        holdings: [],
      });
      expect(d.hard_veto).toBe(false);
      expect(d.veto_reason).toBeNull();
      expect(d.sleeve_target_pct).toBeGreaterThan(0);
    }
  });
});
