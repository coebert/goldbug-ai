import { describe, expect, it } from "vitest";
import { isNoOpRun, type RunExplanationInput } from "@/lib/run-explanation.server";

const base: RunExplanationInput = {
  portfolioName: "My Portfolio",
  currency: "GBP",
  totalValue: 10_300,
  workingCash: 1_200,
  cashFloor: 500,
  proposedOrders: [],
  executed: [],
  halts: [],
  droppedForCash: [],
  brokerBlocked: [],
  budgetNotes: [],
};

describe("isNoOpRun", () => {
  it("is true when nothing at all happened", () => {
    expect(isNoOpRun(base)).toBe(true);
  });

  it("tolerates missing optional arrays", () => {
    const { halts: _h, droppedForCash: _d, brokerBlocked: _b, ...rest } = base;
    expect(isNoOpRun(rest as RunExplanationInput)).toBe(true);
  });

  it("is false when the AI proposed an order, even if none executed", () => {
    expect(isNoOpRun({ ...base, proposedOrders: [{ symbol: "AAPL", side: "buy" }] })).toBe(
      false,
    );
  });

  it("is false when an order executed", () => {
    expect(
      isNoOpRun({
        ...base,
        executed: [{ symbol: "AAPL", side: "buy", quantity: 2, value: 400 }],
      }),
    ).toBe(false);
  });

  it("is false when an order was rejected by a guardrail", () => {
    expect(
      isNoOpRun({
        ...base,
        executed: [
          { symbol: "AAPL", side: "buy", quantity: 0, rejected: "cash floor" },
        ],
      }),
    ).toBe(false);
  });

  it("is false when a risk halt fired", () => {
    expect(isNoOpRun({ ...base, halts: [{ code: "drawdown" }] })).toBe(false);
  });

  it("is false when candidates were dropped for cash or blocked by the broker", () => {
    expect(isNoOpRun({ ...base, droppedForCash: ["AZN.L (too dear)"] })).toBe(false);
    expect(isNoOpRun({ ...base, brokerBlocked: ["SGLN.L"] })).toBe(false);
  });
});
