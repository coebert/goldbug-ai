import { describe, it, expect } from "vitest";
import { attributeSellFill, isOversizedSell } from "@/lib/fill-attribution";

const HIGH = "high-risk-sim";
const BAL = "balanced-sim";

describe("attributeSellFill", () => {
  it("splits the SGLN.L 892-share account sell across both books", () => {
    const r = attributeSellFill({
      quantity: 892,
      orderPortfolioId: HIGH,
      positions: [
        { portfolioId: HIGH, quantity: 445 },
        { portfolioId: BAL, quantity: 446 },
      ],
    });
    expect(r.legs).toEqual([
      { portfolioId: HIGH, quantity: 445 },
      { portfolioId: BAL, quantity: 446 },
    ]);
    expect(r.unattributed).toBe(1);
  });

  it("moves the whole V sell to the portfolio that actually held the shares", () => {
    const r = attributeSellFill({
      quantity: 584,
      orderPortfolioId: HIGH,
      positions: [
        { portfolioId: HIGH, quantity: 0 },
        { portfolioId: BAL, quantity: 704 },
      ],
    });
    expect(r.legs).toEqual([{ portfolioId: BAL, quantity: 584 }]);
    expect(r.unattributed).toBe(0);
  });

  it("never attributes more than a portfolio holds", () => {
    const r = attributeSellFill({
      quantity: 1000,
      orderPortfolioId: HIGH,
      positions: [{ portfolioId: HIGH, quantity: 10 }],
    });
    expect(r.legs).toEqual([{ portfolioId: HIGH, quantity: 10 }]);
    expect(r.unattributed).toBe(990);
  });

  it("returns nothing for zero or invalid quantities", () => {
    expect(attributeSellFill({ quantity: 0, orderPortfolioId: HIGH, positions: [] })).toEqual({
      legs: [],
      unattributed: 0,
    });
  });

  it("is deterministic regardless of position ordering", () => {
    const positions = [
      { portfolioId: BAL, quantity: 446 },
      { portfolioId: HIGH, quantity: 445 },
    ];
    const a = attributeSellFill({ quantity: 500, orderPortfolioId: HIGH, positions });
    const b = attributeSellFill({
      quantity: 500,
      orderPortfolioId: HIGH,
      positions: [...positions].reverse(),
    });
    expect(a).toEqual(b);
    expect(a.legs[0]).toEqual({ portfolioId: HIGH, quantity: 445 });
  });
});

describe("isOversizedSell", () => {
  it("flags the historic combined-position sells", () => {
    expect(isOversizedSell(892, 445)).toBe(true);
    expect(isOversizedSell(584, 0)).toBe(true);
    expect(isOversizedSell(445, 445)).toBe(false);
  });
});
