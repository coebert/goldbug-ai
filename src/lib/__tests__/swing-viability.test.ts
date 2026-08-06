import { describe, it, expect } from "vitest";
import {
  assessSwingViability,
  applySwingViabilityGate,
  transactionTaxBpsFor,
} from "../swing-viability";
import { DEFAULT_RISK_CONFIG } from "../universe.server";
import { SWING_STYLE_OVERRIDES } from "../trading-style";

const swingCfg = { ...DEFAULT_RISK_CONFIG, ...SWING_STYLE_OVERRIDES, trading_style: "swing" as const };

describe("swing viability", () => {
  it("charges UK stamp duty only on GBP", () => {
    expect(transactionTaxBpsFor("GBP")).toBe(50);
    expect(transactionTaxBpsFor("usd")).toBe(0);
  });

  it("rejects tiny tickets whose costs swamp the edge", () => {
    const v = assessSwingViability({ equity: 2_000, perSymbolPct: 0.1, currency: "USD" });
    expect(v.viable).toBe(false);
    expect(v.headroomBps).toBeLessThan(0);
    expect(v.reason).toMatch(/not viable/);
  });

  it("accepts a large ticket on a cheap venue", () => {
    const v = assessSwingViability({ equity: 500_000, perSymbolPct: 0.2, currency: "USD" });
    expect(v.viable).toBe(true);
    expect(v.costShareOfEdge).toBeLessThanOrEqual(1);
  });

  it("cost per bps falls monotonically as the ticket grows", () => {
    const small = assessSwingViability({ equity: 5_000, perSymbolPct: 0.2, currency: "USD" });
    const big = assessSwingViability({ equity: 200_000, perSymbolPct: 0.2, currency: "USD" });
    expect(big.roundTripBps).toBeLessThan(small.roundTripBps);
  });

  it("reports a min viable ticket and equity consistent with the verdict", () => {
    const v = assessSwingViability({ equity: 10_000, perSymbolPct: 0.2, currency: "USD" });
    const atThreshold = assessSwingViability({
      equity: v.minViableTicket / 0.2,
      perSymbolPct: 0.2,
      currency: "USD",
    });
    expect(atThreshold.viable).toBe(true);
    expect(v.minViableEquity).toBeCloseTo(v.minViableTicket / 0.2, 4);
  });

  it("is never viable when stamp duty alone exceeds the budget", () => {
    const v = assessSwingViability({
      equity: 10_000_000,
      perSymbolPct: 0.2,
      currency: "GBP",
      expectedEdgeBps: 100, // budget 25bps < 50bps stamp duty
    });
    expect(v.viable).toBe(false);
    expect(v.minViableTicket).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns not viable for zero equity", () => {
    const v = assessSwingViability({ equity: 0, perSymbolPct: 0.2 });
    expect(v.viable).toBe(false);
    expect(v.ticket).toBe(0);
  });
});

describe("swing viability gate", () => {
  it("leaves position configs untouched", () => {
    const r = applySwingViabilityGate(DEFAULT_RISK_CONFIG, { equity: 100, perSymbolPct: 0.2 });
    expect(r.downgraded).toBe(false);
    expect(r.viability).toBeNull();
    expect(r.cfg).toBe(DEFAULT_RISK_CONFIG);
  });

  it("keeps swing on when the economics hold", () => {
    const r = applySwingViabilityGate(swingCfg, {
      equity: 500_000,
      perSymbolPct: 0.2,
      currency: "USD",
    });
    expect(r.downgraded).toBe(false);
    expect(r.cfg.trading_style).toBe("swing");
  });

  it("downgrades swing to position when the ticket is too small", () => {
    const r = applySwingViabilityGate(swingCfg, {
      equity: 3_000,
      perSymbolPct: 0.15,
      currency: "GBP",
    });
    expect(r.downgraded).toBe(true);
    expect(r.cfg.trading_style).toBe("position");
    expect(r.cfg.swing_min_hold_days).toBe(0);
    expect(r.viability?.viable).toBe(false);
  });
});
