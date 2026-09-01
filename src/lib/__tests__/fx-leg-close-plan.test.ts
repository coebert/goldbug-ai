import { describe, it, expect } from "vitest";
import { planFxLegClose } from "@/lib/fx-leg-close-plan";
import { assessFxRisk } from "@/lib/fx-risk-alert";

describe("planFxLegClose", () => {
  const leg = { pairBase: "GBP", quoteCcy: "USD", avgCost: 1.3616, feeQuote: 10 };

  it("buys the base back for a short leg", () => {
    const p = planFxLegClose({ ...leg, quantity: -2325.78, rate: 1.35 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.direction).toBe("short");
    expect(p.fromCcy).toBe("USD");
    expect(p.toCcy).toBe("GBP");
    expect(p.amountFrom).toBeCloseTo(2325.78 * 1.35, 2);
    expect(p.amountTo).toBeCloseTo(2325.78, 2);
    // Short profits when the rate falls; fee is deducted.
    expect(p.pnlQuoteNet).toBeCloseTo(-2325.78 * (1.35 - 1.3616) - 10, 2);
  });

  it("sells the base for a long leg", () => {
    const p = planFxLegClose({ ...leg, quantity: 1000, rate: 1.4 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fromCcy).toBe("GBP");
    expect(p.toCcy).toBe("USD");
    expect(p.amountFrom).toBeCloseTo(1000, 2);
    expect(p.amountTo).toBeCloseTo(1400, 2);
  });

  it("refuses stale, zero and missing rates", () => {
    expect(planFxLegClose({ ...leg, quantity: -100, rate: 1.35, stale: true }).ok).toBe(false);
    expect(planFxLegClose({ ...leg, quantity: -100, rate: null }).ok).toBe(false);
    expect(planFxLegClose({ ...leg, quantity: 0, rate: 1.35 }).ok).toBe(false);
  });
});

describe("assessFxRisk", () => {
  const base = {
    symbol: "GBPUSD",
    pair: "GBPUSD",
    quantity: -2000,
    notionalBase: 2000,
    pnlBaseNet: 0,
    worstCaseBase: -100,
    worstCaseLabel: "-10% shock",
    stale: false,
  };

  it("is ok when the worst case is small against cash", () => {
    const r = assessFxRisk({ legs: [base], cashBase: 10_000 });
    expect(r.level).toBe("ok");
    expect(r.breaches).toHaveLength(0);
  });

  it("warns at 5% of cash and escalates at 10%", () => {
    expect(assessFxRisk({ legs: [{ ...base, worstCaseBase: -600 }], cashBase: 10_000 }).level).toBe("warn");
    expect(assessFxRisk({ legs: [{ ...base, worstCaseBase: -1200 }], cashBase: 10_000 }).level).toBe(
      "critical",
    );
  });

  it("flags a leg already through the cut-loss band", () => {
    const r = assessFxRisk({ legs: [{ ...base, pnlBaseNet: -80 }], cashBase: 100_000 });
    expect(r.level).toBe("critical");
    expect(r.breaches[0].suggestion).toMatch(/Close this leg now/);
  });

  it("warns on a stale mark", () => {
    const r = assessFxRisk({ legs: [{ ...base, stale: true }], cashBase: 100_000 });
    expect(r.level).toBe("warn");
    expect(r.breaches[0].reasons.join(" ")).toMatch(/stale/);
  });
});
