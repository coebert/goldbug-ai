// Integration tests for the crypto playbook + sleeve engine + universe wiring.
//
// Locks three invariants that must hold together for the crypto sleeve to be
// coherent, and which have regressed independently in the past:
//
//   1. The six Saxo-tradable crypto ETPs (BTCE.DE, ABTC.SW, BTCW.L, ZETH.SW,
//      ZETH.DE, HODL.SW) are ALWAYS present in the classifier map, the
//      investable universe, and every sleeve-decision output.
//   2. Sleeve caps by risk level match the playbook narrative (5/10/15%),
//      the regime multipliers behave as documented, and the risk_off hard
//      veto forces EXIT on every symbol.
//   3. The narrative playbook still spells out the liquidity/quality gates
//      (min ADV$, max ATR%, saxo_instrument_cache requirement) and the
//      forbidden instruments — so prompt/engine drift is caught in CI.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../market-data.server", () => ({
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
}));

import { getDailyCandles } from "../market-data.server";
import {
  CRYPTO_SYMBOLS,
  CRYPTO_SYMBOL_MAP,
  classifyCryptoSymbol,
} from "../crypto-groups";
import { CRYPTO_PLAYBOOK } from "../crypto-playbook.server";
import { UNIVERSE } from "../universe.server";
import {
  cryptoSleeveCapPct,
  computeCryptoSleeveDecision,
  formatCryptoSignalsBlock,
} from "../crypto-strategy.server";

// The exact six ETPs the playbook promises are tradable via Saxo cash
// accounts. Any deletion is a semantic break — a separate test locks
// additions to require explicit playbook updates.
const SAXO_TRADABLE_CRYPTO_ETPS = [
  "BTCE.DE",
  "ABTC.SW",
  "BTCW.L",
  "ZETH.SW",
  "ZETH.DE",
  "HODL.SW",
] as const;

function synth(prices: number[]) {
  return prices.map((p, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: p, high: p, low: p, close: p, volume: 1_000_000,
  }));
}
function uptrend(len = 220, start = 100, step = 0.4) {
  return Array.from({ length: len }, (_, i) => start + i * step + (i % 2 === 0 ? -0.6 : 0.6));
}

beforeEach(() => vi.mocked(getDailyCandles).mockReset());

// -------------------------------------------------------------------------
// 1. Universe / classifier invariants
// -------------------------------------------------------------------------
describe("crypto ETP universe wiring", () => {
  it("classifier map contains all six Saxo-tradable ETPs and nothing more", () => {
    for (const s of SAXO_TRADABLE_CRYPTO_ETPS) {
      expect(CRYPTO_SYMBOL_MAP[s]).toBeDefined();
      expect(classifyCryptoSymbol(s)).not.toBeNull();
    }
    expect(new Set(CRYPTO_SYMBOLS)).toEqual(new Set(SAXO_TRADABLE_CRYPTO_ETPS));
  });

  it("assigns each ETP to the documented group (BTC/ETH/Basket)", () => {
    expect(classifyCryptoSymbol("BTCE.DE")).toBe("BTC");
    expect(classifyCryptoSymbol("ABTC.SW")).toBe("BTC");
    expect(classifyCryptoSymbol("BTCW.L")).toBe("BTC");
    expect(classifyCryptoSymbol("ZETH.SW")).toBe("ETH");
    expect(classifyCryptoSymbol("ZETH.DE")).toBe("ETH");
    expect(classifyCryptoSymbol("HODL.SW")).toBe("Basket");
  });

  it("investable UNIVERSE exposes all six ETPs as asset_class='crypto'", () => {
    for (const s of SAXO_TRADABLE_CRYPTO_ETPS) {
      const row = UNIVERSE.find((u) => u.symbol === s);
      expect(row, `missing ${s} from UNIVERSE`).toBeDefined();
      expect(row!.asset_class).toBe("crypto");
    }
  });

  it("rejects non-Saxo-tradable proxies (spot pairs, miners, MSTR, COIN)", () => {
    for (const bad of ["BTC-USD", "ETH-USD", "SOL-USD", "MSTR", "COIN", "MARA", "RIOT"]) {
      expect(classifyCryptoSymbol(bad)).toBeNull();
    }
  });
});

// -------------------------------------------------------------------------
// 2. Sleeve caps & regime behaviour across risk levels
// -------------------------------------------------------------------------
describe("sleeve caps and regime bucketing", () => {
  it("locks 5% / 10% / 15% caps by risk level", () => {
    expect(cryptoSleeveCapPct("conservative")).toBe(0.05);
    expect(cryptoSleeveCapPct("balanced")).toBe(0.10);
    expect(cryptoSleeveCapPct("aggressive")).toBe(0.15);
  });

  it("emits a signal for every one of the six ETPs in a full sleeve pass", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bull_quiet",
      nav: 100_000,
      holdings: [],
      // Default (undefined) uses CRYPTO_SYMBOLS — that's exactly what we want to lock.
    });
    const emitted = d.symbols.map((s) => s.symbol).sort();
    expect(emitted).toEqual([...SAXO_TRADABLE_CRYPTO_ETPS].sort());
  });

  it("hard-vetoes ALL six ETPs in a risk_off regime, regardless of trend", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "aggressive",
      regime: "crisis",
      nav: 100_000,
      holdings: SAXO_TRADABLE_CRYPTO_ETPS.map((s) => ({
        symbol: s, market_value_base: 1_000,
      })),
    });
    expect(d.hard_veto).toBe(true);
    expect(d.sleeve_target_pct).toBe(0);
    expect(d.symbols).toHaveLength(SAXO_TRADABLE_CRYPTO_ETPS.length);
    for (const s of d.symbols) {
      expect(s.action).toBe("exit");
      expect(s.size_fraction_of_cap).toBe(0);
    }
  });

  it("scales sleeve TARGET by regime multiplier (risk_on=1.0, caution=0.4, risk_off=0)", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const base = { asOf: "2026-01-15", nav: 100_000, holdings: [], symbols: ["BTCE.DE"] };

    const on = await computeCryptoSleeveDecision({
      ...base, riskLevel: "aggressive", regime: "bull_quiet",
    });
    const caution = await computeCryptoSleeveDecision({
      ...base, riskLevel: "aggressive", regime: "correction",
    });
    const off = await computeCryptoSleeveDecision({
      ...base, riskLevel: "aggressive", regime: "crisis",
    });

    expect(on.sleeve_target_pct).toBeCloseTo(0.15, 5);
    expect(caution.sleeve_target_pct).toBeCloseTo(0.15 * 0.4, 5);
    expect(off.sleeve_target_pct).toBe(0);
  });
});

// -------------------------------------------------------------------------
// 3. Playbook narrative locks (liquidity gates + forbidden instruments)
// -------------------------------------------------------------------------
describe("CRYPTO_PLAYBOOK narrative locks", () => {
  it("names all six Saxo-tradable ETPs in the playbook body", () => {
    for (const s of SAXO_TRADABLE_CRYPTO_ETPS) {
      expect(CRYPTO_PLAYBOOK).toContain(s);
    }
  });

  it("spells out the liquidity / quality gates the engine enforces", () => {
    expect(CRYPTO_PLAYBOOK).toMatch(/min_adv_usd/);
    expect(CRYPTO_PLAYBOOK).toMatch(/crypto_max_atr_pct/);
    expect(CRYPTO_PLAYBOOK).toMatch(/saxo_instrument_cache/);
  });

  it("keeps the FORBIDDEN section listing spot/futures/leveraged/proxy equities", () => {
    expect(CRYPTO_PLAYBOOK).toMatch(/FORBIDDEN/);
    expect(CRYPTO_PLAYBOOK).toMatch(/BTC-USD/);
    expect(CRYPTO_PLAYBOOK).toMatch(/futures/i);
    expect(CRYPTO_PLAYBOOK).toMatch(/leveraged/i);
    expect(CRYPTO_PLAYBOOK).toMatch(/MSTR|COIN|MARA|RIOT/);
  });
});

// -------------------------------------------------------------------------
// 4. Prompt block renders every symbol so the LLM sees full sleeve state
// -------------------------------------------------------------------------
describe("formatCryptoSignalsBlock full-sleeve rendering", () => {
  it("includes a line for every Saxo-tradable ETP", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bull_quiet",
      nav: 100_000,
      holdings: [],
    });
    const block = formatCryptoSignalsBlock(d);
    for (const s of SAXO_TRADABLE_CRYPTO_ETPS) {
      expect(block, `missing ${s} in prompt block`).toContain(s);
    }
    expect(block).toMatch(/CRYPTO SLEEVE/);
  });
});
