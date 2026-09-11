import { describe, expect, it } from "vitest";
import { planCashSleeve } from "../cash-sleeve";

const base = {
  nav: 20_000,
  sleeveValue: 0,
  sleeveQuantity: 0,
  cash: 1_500,
  buffer: 1_500,
  price: 101.5,
  minTicket: 250,
};

describe("planCashSleeve", () => {
  it("holds when cash sits at the buffer", () => {
    expect(planCashSleeve(base).action).toBe("hold");
  });

  it("invests whole units of the spare cash above the buffer", () => {
    const p = planCashSleeve({ ...base, cash: 12_000 });
    expect(p.action).toBe("buy");
    expect(p.quantity).toBe(Math.floor(10_500 / 101.5));
    expect(p.notional).toBeLessThanOrEqual(10_500);
  });

  it("never leaves the buffer short after a buy", () => {
    const p = planCashSleeve({ ...base, cash: 2_000 });
    expect(p.action).toBe("hold");
  });

  it("sells back to restore a short buffer", () => {
    const p = planCashSleeve({ ...base, cash: 200, sleeveQuantity: 100, sleeveValue: 10_150 });
    expect(p.action).toBe("sell");
    expect(p.notional).toBeGreaterThanOrEqual(1_300);
  });

  it("cannot sell more than it holds", () => {
    const p = planCashSleeve({ ...base, cash: 0, sleeveQuantity: 2, sleeveValue: 203 });
    expect(p.quantity).toBe(2);
  });

  it("holds when there is nothing to sell and no spare cash", () => {
    expect(planCashSleeve({ ...base, cash: 100 }).action).toBe("hold");
  });

  it("refuses to act on an unusable price", () => {
    expect(planCashSleeve({ ...base, cash: 50_000, price: 0 }).action).toBe("hold");
  });
});
