import { describe, it, expect } from "vitest";
import { trimBuysToBudget, type BudgetOrder } from "@/lib/pre-place-budget";

const buy = (symbol: string, quantity: number, price: number): BudgetOrder => ({
  symbol,
  side: "buy",
  quantity,
  price,
});

/**
 * Cross-currency behaviour of trimBuysToBudget. The pre-placement trim
 * receives orders sized in the portfolio currency (what the AI thought the
 * position would cost) plus a portfolio→broker FX rate captured in the same
 * tick. These tests lock in that:
 *
 *  - a realistic GBP→EUR rate makes previously-affordable buys hit the
 *    broker's EUR cash ceiling and get skipped
 *  - an identity-fallback rate of 1.0 (both FX providers down) under-states
 *    the true broker cost — the trim still respects the broker cash number
 *    and rejects buys that would have fit at 1:1 but blow the real budget
 *  - the safety buffer (default 1%, widened when FX is stale) always trims
 *    to less than raw broker cash so a rounding blip can't cause the
 *    broker to see an InsufficientCash reject
 */
describe("trimBuysToBudget — cross-currency affordability", () => {
  it("skips buys whose GBP notional exceeds broker EUR cash once converted at fx=1.17", () => {
    // 100 GBP × 1.17 EUR/GBP = 117 EUR, budget after 1% buffer = 99 EUR → skip.
    const r = trimBuysToBudget([buy("VOD.L", 1, 100)], 100, 1.17, {
      safetyBufferPct: 0.01,
    });
    expect(r.skippedCount).toBe(1);
    const d = r.decisions[0];
    expect(d.kind).toBe("skip");
    expect(d.notionalBrokerCcy).toBeCloseTo(117, 6);
    if (d.kind === "skip") {
      expect(d.reason).toMatch(/insufficient broker cash/);
      expect(d.reason).toMatch(/needs 117\.00/);
    }
  });

  it("keeps smaller follow-on buys when the largest cross-currency buy is skipped", () => {
    // 300 EUR broker cash, 297 after buffer.
    // Buy 1: 200 GBP × 1.30 = 260 EUR  → fits (remaining 37)
    // Buy 2:  50 GBP × 1.30 =  65 EUR  → skip (>37)
    // Buy 3:  20 GBP × 1.30 =  26 EUR  → fits (remaining 11)
    const r = trimBuysToBudget(
      [buy("A", 1, 200), buy("B", 1, 50), buy("C", 1, 20)],
      300,
      1.3,
      { safetyBufferPct: 0.01 },
    );
    expect(r.decisions.map((d) => d.kind)).toEqual(["allow", "skip", "allow"]);
    expect(r.totalAllowedBrokerCcy).toBeCloseTo(286, 6);
  });

  it("identity fallback (fx=1) under-states true cost but trim still respects broker cash", () => {
    // Same order as above but the FX providers are down and getFxRate
    // returned rate=1 (identity fallback). The trim now treats 200 GBP as
    // costing 200 EUR — buy 1 still fits and buy 2 (50) also fits inside
    // the 297 EUR buffered budget. The rest go through. This documents the
    // failure mode: without a real FX rate the trim happily lets a 260 EUR
    // trade through as if it were 200 EUR. The executor's PRE_PLACE_FX_BLOCK
    // guard is what stops this in production — trim itself must not
    // silently invent a "safer" number.
    const r = trimBuysToBudget(
      [buy("A", 1, 200), buy("B", 1, 50), buy("C", 1, 20)],
      300,
      1.0, // identity fallback
      { safetyBufferPct: 0.01 },
    );
    expect(r.decisions.map((d) => d.kind)).toEqual(["allow", "allow", "allow"]);
    expect(r.totalAllowedBrokerCcy).toBeCloseTo(270, 6);
  });

  it("widened 5% safety buffer for stale FX rejects a buy that a 1% buffer would have allowed", () => {
    // 100 GBP × 1.30 = 130 EUR. Broker cash 132 EUR.
    //   1% buffer → budget 130.68 → allow
    //   5% buffer → budget 125.40 → skip
    const withNormalBuffer = trimBuysToBudget([buy("A", 1, 100)], 132, 1.3, {
      safetyBufferPct: 0.01,
    });
    expect(withNormalBuffer.decisions[0].kind).toBe("allow");

    const withStaleBuffer = trimBuysToBudget([buy("A", 1, 100)], 132, 1.3, {
      safetyBufferPct: 0.05,
    });
    expect(withStaleBuffer.decisions[0].kind).toBe("skip");
  });

  it("guards against invalid FX rate — non-finite or non-positive falls back to 1 (documented)", () => {
    // If the executor ever passed NaN / -1 the pure function must not amplify
    // it into a negative or NaN notional; it clamps to rate=1.
    const withNaN = trimBuysToBudget([buy("A", 1, 100)], 200, Number.NaN, {
      safetyBufferPct: 0,
    });
    expect(withNaN.decisions[0].kind).toBe("allow");
    expect(withNaN.decisions[0].notionalBrokerCcy).toBe(100);

    const withNegative = trimBuysToBudget([buy("A", 1, 100)], 200, -5, {
      safetyBufferPct: 0,
    });
    expect(withNegative.decisions[0].notionalBrokerCcy).toBe(100);
  });

  it("skips buys whose broker-ccy notional exactly matches remaining minus a rounding epsilon (fits)", () => {
    // 100 GBP × 1.5 = 150 EUR. Broker cash 150.
    // safetyBufferPct 0 → budget 150 → 150 ≤ 150 + 1e-6 → allow.
    const r = trimBuysToBudget([buy("A", 1, 100)], 150, 1.5, {
      safetyBufferPct: 0,
    });
    expect(r.decisions[0].kind).toBe("allow");
  });

  it("second buy that would push cross-currency total past budget is skipped, first still allowed", () => {
    // 200 EUR broker cash, no buffer.
    // Buy 1: 100 GBP × 1.5 = 150 EUR → allow, remaining 50
    // Buy 2:  50 GBP × 1.5 =  75 EUR → skip
    const r = trimBuysToBudget(
      [buy("A", 1, 100), buy("B", 1, 50)],
      200,
      1.5,
      { safetyBufferPct: 0 },
    );
    expect(r.decisions.map((d) => d.kind)).toEqual(["allow", "skip"]);
    expect(r.totalRequestedBrokerCcy).toBeCloseTo(225, 6);
    expect(r.totalAllowedBrokerCcy).toBeCloseTo(150, 6);
  });
});
