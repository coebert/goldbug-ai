// Unit tests for the dedicated crypto allocation & risk-management engine.
// Locks in sleeve caps by risk level, regime bucketing, entry/exit gates,
// and the hard risk-off veto surfaced to the sizing layer.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  formatCryptoSignalsBlock,
} from "../crypto-strategy.server";

function synth(prices: number[]) {
  return prices.map((p, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: p, high: p, low: p, close: p, volume: 1_000_000,
  }));
}

function uptrend(len = 220, start = 100, step = 0.4) {
  // Wobbly up-trend: enough noise to keep RSI in the 45-70 gate range.
  return Array.from({ length: len }, (_, i) => start + i * step + (i % 2 === 0 ? -0.6 : 0.6));
}
function downtrend(len = 220, start = 200, step = -0.4) {
  return Array.from({ length: len }, (_, i) => Math.max(1, start + i * step));
}
function parabolic(len = 220) {
  const flat = Array.from({ length: len - 60 }, () => 100);
  const rip  = Array.from({ length: 60 }, (_, i) => 100 + i * 2); // +120% in 60d
  return [...flat, ...rip];
}

beforeEach(() => vi.mocked(getDailyCandles).mockReset());

describe("cryptoSleeveCapPct", () => {
  it("scales with risk level", () => {
    expect(cryptoSleeveCapPct("conservative")).toBe(0.05);
    expect(cryptoSleeveCapPct("balanced")).toBe(0.10);
    expect(cryptoSleeveCapPct("aggressive")).toBe(0.15);
  });
});

describe("bucketRegime", () => {
  it("maps regimes to crypto buckets", () => {
    expect(bucketRegime("bull_quiet")).toBe("risk_on");
    expect(bucketRegime("recovery")).toBe("risk_on");
    expect(bucketRegime("bull_volatile")).toBe("caution");
    expect(bucketRegime("correction")).toBe("caution");
    expect(bucketRegime("bear")).toBe("risk_off");
    expect(bucketRegime("crisis")).toBe("risk_off");
  });
});

describe("computeCryptoSleeveDecision — risk_on uptrend", () => {
  it("proposes OPEN with size ~1/3+ of cap when gates pass", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bull_quiet",
      nav: 100_000,
      holdings: [],
      symbols: ["BTCE.DE"],
    });
    expect(d.hard_veto).toBe(false);
    expect(d.sleeve_cap_pct).toBe(0.10);
    expect(d.sleeve_target_pct).toBeCloseTo(0.10, 5);
    const s = d.symbols[0];
    expect(s.trend_up).toBe(true);
    expect(["open", "add"]).toContain(s.action);
    expect(s.size_fraction_of_cap).toBeGreaterThanOrEqual(0.33);
  });
});

describe("computeCryptoSleeveDecision — risk_off HARD veto", () => {
  it("forces EXIT on all crypto symbols regardless of trend", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "aggressive",
      regime: "crisis",
      nav: 100_000,
      holdings: [{ symbol: "BTCE.DE", market_value_base: 12_000 }],
      symbols: ["BTCE.DE", "ZETH.SW"],
    });
    expect(d.hard_veto).toBe(true);
    expect(d.sleeve_target_pct).toBe(0);
    expect(d.veto_reason).toMatch(/risk_off/i);
    for (const s of d.symbols) {
      expect(s.action).toBe("exit");
      expect(s.size_fraction_of_cap).toBe(0);
      expect(s.rationale).toMatch(/X6/);
    }
  });
});

describe("computeCryptoSleeveDecision — trend break exits", () => {
  it("EXITs when close < SMA200 (X2)", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(downtrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bull_quiet",
      nav: 100_000,
      holdings: [],
      symbols: ["BTCE.DE"],
    });
    expect(d.symbols[0].action).toBe("exit");
    expect(d.symbols[0].rationale).toMatch(/X2/);
  });
});

describe("computeCryptoSleeveDecision — parabolic guard (C5/X5)", () => {
  it("TRIMs a +>50% 60d rip and blocks fresh entries", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(parabolic()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bull_quiet",
      nav: 100_000,
      holdings: [],
      symbols: ["BTCE.DE"],
    });
    const s = d.symbols[0];
    expect(s.parabolic_veto).toBe(true);
    expect(s.action).toBe("trim");
    expect(s.rationale).toMatch(/parabolic|C5|X5/i);
  });
});

describe("computeCryptoSleeveDecision — caution regime", () => {
  it("halves sleeve target and holds without adding", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "aggressive",
      regime: "correction",
      nav: 100_000,
      holdings: [],
      symbols: ["BTCE.DE"],
    });
    expect(d.bucket).toBe("caution");
    expect(d.sleeve_target_pct).toBeCloseTo(0.15 * 0.4, 5);
    expect(d.symbols[0].action).toBe("hold");
  });
});

describe("formatCryptoSignalsBlock", () => {
  it("renders a prompt-ready block with veto and per-symbol lines", async () => {
    vi.mocked(getDailyCandles).mockImplementation(async () => synth(uptrend()));
    const d = await computeCryptoSleeveDecision({
      asOf: "2026-01-15",
      riskLevel: "balanced",
      regime: "bear",
      nav: 100_000,
      holdings: [],
      symbols: ["BTCE.DE"],
    });
    const block = formatCryptoSignalsBlock(d);
    expect(block).toMatch(/CRYPTO SLEEVE/);
    expect(block).toMatch(/HARD VETO/);
    expect(block).toMatch(/BTCE\.DE \(BTC\)/);
    expect(block).toMatch(/action=exit/);
  });
});
