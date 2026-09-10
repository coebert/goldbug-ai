import { describe, it, expect } from "vitest";
import { planCoreAllocation, type CoreAllocationInput } from "@/lib/core-allocation";

function input(over: Partial<CoreAllocationInput> = {}): CoreAllocationInput {
  return {
    nav: 10_000,
    coreValue: 0,
    cash: 9_000,
    cashReserve: 500,
    price: 100,
    targetPct: 0.5,
    bandPct: 0.05,
    minTicket: 250,
    ...over,
  };
}

describe("planCoreAllocation", () => {
  it("puts idle cash to work when the core is below target", () => {
    const p = planCoreAllocation(input());
    expect(p.action).toBe("buy");
    expect(p.quantity).toBe(50);
    expect(p.notional).toBe(5_000);
  });

  it("never spends the cash reserve", () => {
    const p = planCoreAllocation(input({ cash: 1_000, cashReserve: 500 }));
    expect(p.action).toBe("buy");
    expect(p.notional).toBeLessThanOrEqual(500);
  });

  it("holds inside the drift band", () => {
    const p = planCoreAllocation(input({ coreValue: 4_800, cash: 5_200 }));
    expect(p.action).toBe("hold");
  });

  it("trims when the core has run above the band", () => {
    const p = planCoreAllocation(input({ coreValue: 7_000, cash: 3_000 }));
    expect(p.action).toBe("trim");
    expect(p.quantity).toBe(20);
  });

  it("does not deal below the minimum ticket", () => {
    const p = planCoreAllocation(input({ coreValue: 4_400, cash: 200, cashReserve: 0, price: 1 }));
    expect(p.action).toBe("hold");
    expect(p.reason).toMatch(/too small/);
  });

  it("is switched off at a zero target", () => {
    const p = planCoreAllocation(input({ targetPct: 0 }));
    expect(p.action).toBe("hold");
    expect(p.reason).toMatch(/switched off/);
  });

  it("never borrows when cash is already spoken for", () => {
    const p = planCoreAllocation(input({ cash: 400, cashReserve: 500 }));
    expect(p.action).toBe("hold");
    expect(p.quantity).toBe(0);
  });
});
