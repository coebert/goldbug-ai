// Unit tests for the retail-mania / short-squeeze detector.
//
// Reference episodes (public price/volume/RSI data, rounded):
//   - GME  2021-01-13: opened at ~$20, closed ~$31 (+57% intraday); 5d ret ~+80%,
//                       30d ~+165%, RSI-14 ~86, volume ~10× 20d median,
//                       reported short interest ~140% of float.
//   - GME  2021-01-27: parabolic peak ($347 close); 5d ~+400%, RSI ≈ 97,
//                       volume ~15×, weekly-call OI blew out ≥ 10× baseline.
//   - AMC  2021-06-02: 5d ~+230%, 30d ~+400%, RSI ~92, volume ~20× median,
//                       reported SI ~20% of float.
//   - BBBY 2022-08-17: 5d ~+120%, 30d ~+300%, RSI ~90, volume ~15×.
//
// Non-mania control episodes (should NOT trigger):
//   - Steady large-cap uptrend  : 5d +3%, 30d +8%, RSI 60, vol 1.1×.
//   - Healthy breakout          : 5d +8%, 30d +18%, RSI 68, vol 2.5×.
//   - Grind-down bear tape      : 5d -4%, 30d -12%, RSI 32.
//   - Sideways low-vol          : 5d +0.5%, 30d +1%, RSI 52.
import { describe, it, expect } from "vitest";
import {
  detectRetailMania,
  symbolsToBlockForBuy,
  formatManiaExplanation,
} from "../retail-mania";

describe("detectRetailMania — GameStop-like mania episodes", () => {
  it("flags GME 2021-01-13 as mania and blocks new buys", () => {
    const sig = detectRetailMania({
      symbol: "GME",
      change5d: 0.8,
      change30d: 1.65,
      rsi14: 86,
      volumeRatio20d: 10,
      shortInterestPctFloat: 1.4,
    });
    expect(sig.tier).toBe("mania");
    expect(sig.blockNewBuys).toBe(true);
    expect(sig.trimExistingLong).toBe(true);
    const components = sig.scoreBreakdown.map((s) => s.component);
    expect(components).toEqual(
      expect.arrayContaining(["parabola5d", "parabola30d", "rsi", "volume", "shortSqueeze"]),
    );
    // Short-squeeze booster requires SI ≥ 20% AND 5d ≥ +30%.
    expect(components).toContain("shortSqueeze");
  });

  it("flags GME 2021-01-27 parabolic peak with gamma booster", () => {
    const sig = detectRetailMania({
      symbol: "GME",
      change5d: 4.0,
      change30d: 15.0,
      rsi14: 97,
      volumeRatio20d: 15,
      shortInterestPctFloat: 1.2,
      weeklyCallOiRatio: 10,
      socialMentionRatio: 50,
    });
    expect(sig.tier).toBe("mania");
    expect(sig.blockNewBuys).toBe(true);
    // Every optional component should have contributed on this print.
    const components = sig.scoreBreakdown.map((s) => s.component);
    for (const c of [
      "parabola5d",
      "parabola30d",
      "rsi",
      "volume",
      "shortSqueeze",
      "gamma",
      "social",
    ] as const) {
      expect(components).toContain(c);
    }
    // Score should be well above the mania threshold (≥ 3.5).
    expect(sig.score).toBeGreaterThanOrEqual(7);
  });

  it("flags AMC 2021-06-02 as mania", () => {
    const sig = detectRetailMania({
      symbol: "AMC",
      change5d: 2.3,
      change30d: 4.0,
      rsi14: 92,
      volumeRatio20d: 20,
      shortInterestPctFloat: 0.2,
    });
    expect(sig.tier).toBe("mania");
    expect(sig.blockNewBuys).toBe(true);
  });

  it("flags BBBY 2022-08-17 as mania", () => {
    const sig = detectRetailMania({
      symbol: "BBBY",
      change5d: 1.2,
      change30d: 3.0,
      rsi14: 90,
      volumeRatio20d: 15,
    });
    expect(sig.tier).toBe("mania");
    expect(sig.blockNewBuys).toBe(true);
  });
});

describe("detectRetailMania — normal trend controls (must NOT over-trigger)", () => {
  it("does not fire on a steady large-cap uptrend", () => {
    const sig = detectRetailMania({
      symbol: "AAPL",
      change5d: 0.03,
      change30d: 0.08,
      rsi14: 60,
      volumeRatio20d: 1.1,
    });
    expect(sig.tier).toBe("none");
    expect(sig.blockNewBuys).toBe(false);
    expect(sig.trimExistingLong).toBe(false);
    expect(sig.score).toBe(0);
  });

  it("does not fire on a healthy breakout", () => {
    const sig = detectRetailMania({
      symbol: "MSFT",
      change5d: 0.08,
      change30d: 0.18,
      rsi14: 68,
      volumeRatio20d: 2.5,
    });
    expect(sig.tier).toBe("none");
    expect(sig.blockNewBuys).toBe(false);
  });

  it("does not fire on a grind-down bear tape", () => {
    const sig = detectRetailMania({
      symbol: "META",
      change5d: -0.04,
      change30d: -0.12,
      rsi14: 32,
    });
    expect(sig.tier).toBe("none");
    expect(sig.blockNewBuys).toBe(false);
  });

  it("does not fire on a sideways low-vol tape", () => {
    const sig = detectRetailMania({
      symbol: "KO",
      change5d: 0.005,
      change30d: 0.01,
      rsi14: 52,
      volumeRatio20d: 1.0,
    });
    expect(sig.tier).toBe("none");
    expect(sig.score).toBe(0);
  });

  it("does not fire when only a single mild indicator crosses (below watch threshold)", () => {
    // Only a 5d parabola present (+2 weight), which puts us at exactly the
    // "watch" threshold — but NOT at "mania" and MUST NOT block buys.
    const sig = detectRetailMania({
      symbol: "TSLA",
      change5d: 0.55, // just over the +50% 5d line
      change30d: 0.4, // under the 30d parabola threshold
      rsi14: 70, // under RSI-extreme threshold
    });
    expect(sig.tier).toBe("watch");
    expect(sig.blockNewBuys).toBe(false);
  });
});

describe("detectRetailMania — trim-into-strength edge case", () => {
  it("trims an existing long on RSI≥85 + 5d≥+50% even when total score is only 'watch'", () => {
    // Score = 2 (parabola5d) + 1.5 (rsi) = 3.5 → mania, so also blocks buys.
    // Confirm the trim flag is set regardless.
    const sig = detectRetailMania({
      symbol: "NVDA",
      change5d: 0.55,
      rsi14: 88,
    });
    expect(sig.trimExistingLong).toBe(true);
  });
});

describe("detectRetailMania — resilience to missing inputs", () => {
  it("treats missing fields as absent and returns 'none' when nothing crosses", () => {
    const sig = detectRetailMania({ symbol: "XYZ" });
    expect(sig.tier).toBe("none");
    expect(sig.score).toBe(0);
    expect(sig.scoreBreakdown).toHaveLength(0);
  });

  it("ignores explicit nulls without throwing", () => {
    const sig = detectRetailMania({
      symbol: "XYZ",
      change5d: null,
      change30d: null,
      rsi14: null,
      volumeRatio20d: null,
    });
    expect(sig.tier).toBe("none");
  });
});

describe("symbolsToBlockForBuy — batch helper", () => {
  it("returns only the mania-tier symbols in a mixed universe", () => {
    const blocked = symbolsToBlockForBuy([
      // mania — GME-like
      {
        symbol: "GME",
        change5d: 0.8,
        change30d: 1.65,
        rsi14: 86,
        volumeRatio20d: 10,
        shortInterestPctFloat: 1.4,
      },
      // normal — AAPL-like
      { symbol: "AAPL", change5d: 0.03, change30d: 0.08, rsi14: 60 },
      // healthy breakout — MSFT-like
      { symbol: "MSFT", change5d: 0.08, change30d: 0.18, rsi14: 68 },
      // mania — AMC-like
      { symbol: "AMC", change5d: 2.3, change30d: 4.0, rsi14: 92, volumeRatio20d: 20 },
    ]);
    expect(blocked.has("GME")).toBe(true);
    expect(blocked.has("AMC")).toBe(true);
    expect(blocked.has("AAPL")).toBe(false);
    expect(blocked.has("MSFT")).toBe(false);
    expect(blocked.size).toBe(2);
  });
});

describe("formatManiaExplanation — output shape parseable by the summary card", () => {
  it("emits the '(tier, score N.N): verb — Label detail (+w); ...' shape", () => {
    const sig = detectRetailMania({
      symbol: "GME",
      change5d: 0.8,
      change30d: 1.65,
      rsi14: 86,
    });
    const out = formatManiaExplanation(sig, "block");
    expect(out).toMatch(
      /^retail-mania guardrail \(mania, score [\d.]+\): block new buys — .+(\(\+[\d.]+\))/,
    );
    // Every component in the breakdown must appear as its own "Label detail (+w)" segment.
    for (const item of sig.scoreBreakdown) {
      expect(out).toContain(`${item.label} ${item.detail} (+${item.weight})`);
    }
  });

  it("switches the verb when action='trim'", () => {
    const sig = detectRetailMania({
      symbol: "GME",
      change5d: 0.8,
      change30d: 1.65,
      rsi14: 86,
    });
    expect(formatManiaExplanation(sig, "trim")).toContain(": trim —");
  });
});
