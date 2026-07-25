import { describe, it, expect } from "vitest";
import { trimBuysToBudget, type BudgetOrder } from "@/lib/pre-place-budget";

const buy = (symbol: string, quantity: number, price: number): BudgetOrder => ({
  symbol,
  side: "buy",
  quantity,
  price,
});

describe("trimBuysToBudget", () => {
  it("allows every buy when total notional fits comfortably inside the budget", () => {
    const r = trimBuysToBudget(
      [buy("A", 10, 5), buy("B", 4, 25)],
      500,
      1,
      { safetyBufferPct: 0 },
    );
    expect(r.decisions.every((d) => d.kind === "allow")).toBe(true);
    expect(r.skippedCount).toBe(0);
    expect(r.totalAllowedBrokerCcy).toBeCloseTo(150, 6);
  });

  it("skips the first buy that would overflow the budget and keeps trying later buys", () => {
    // Budget after 1% buffer = 99. First buy costs 60, second 50 (would push
    // remaining below zero — skip), third 30 (fits in the remaining 39).
    const r = trimBuysToBudget(
      [buy("BIG", 1, 60), buy("MID", 1, 50), buy("SMALL", 1, 30)],
      100,
      1,
    );
    expect(r.decisions.map((d) => d.kind)).toEqual(["allow", "skip", "allow"]);
    const skipped = r.decisions.find((d) => d.kind === "skip");
    expect(skipped && skipped.reason).toMatch(/insufficient broker cash/i);
    expect(r.skippedCount).toBe(1);
    expect(r.totalAllowedBrokerCcy).toBeCloseTo(90, 6);
    expect(r.totalRequestedBrokerCcy).toBeCloseTo(140, 6);
  });

  it("applies FX to convert portfolio-currency notional into broker currency", () => {
    // Portfolio in GBP, broker settled in USD. £100 buy × 1.25 = $125 which
    // exceeds the ~$99 usable budget → skip.
    const r = trimBuysToBudget([buy("US", 1, 100)], 100, 1.25);
    expect(r.decisions[0].kind).toBe("skip");
    expect(r.decisions[0].notionalBrokerCcy).toBeCloseTo(125, 6);
  });

  it("holds back the safety buffer so rounding + commissions can't tip over", () => {
    // With default 1% buffer, budget = 99. A £99.50 buy must be rejected even
    // though the raw broker cash is £100.
    const r = trimBuysToBudget([buy("EDGE", 1, 99.5)], 100, 1);
    expect(r.decisions[0].kind).toBe("skip");
  });

  it("treats non-finite broker cash as zero and skips every buy", () => {
    const r = trimBuysToBudget(
      [buy("A", 1, 10), buy("B", 1, 5)],
      Number.NaN,
      1,
      { safetyBufferPct: 0 },
    );
    expect(r.skippedCount).toBe(2);
    expect(r.totalAllowedBrokerCcy).toBe(0);
  });

  it("treats a non-finite FX rate as identity (1.0) rather than crashing", () => {
    const r = trimBuysToBudget([buy("A", 2, 25)], 100, Number.NaN, {
      safetyBufferPct: 0,
    });
    expect(r.decisions[0].kind).toBe("allow");
    expect(r.decisions[0].notionalBrokerCcy).toBeCloseTo(50, 6);
  });

  it("skips zero-quantity or zero-price orders with a clear reason", () => {
    const r = trimBuysToBudget([buy("Z", 0, 100), buy("P", 1, 0)], 1000, 1);
    expect(r.decisions.every((d) => d.kind === "skip")).toBe(true);
    expect(r.decisions.every((d) => (d as { reason: string }).reason === "zero notional")).toBe(true);
  });
});
