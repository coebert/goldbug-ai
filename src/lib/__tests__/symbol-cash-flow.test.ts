import { describe, expect, it } from "vitest";
import { buildSymbolCashFlow } from "../symbol-cash-flow";

describe("buildSymbolCashFlow", () => {
  it("groups partial buys and sells with broker and estimated fees", () => {
    const rows = buildSymbolCashFlow(
      [
        { symbol: "TSLA:xnas", side: "buy", quantity: 2, fillPriceBase: 100, feeBase: 3, feeSource: "broker" },
        { symbol: "TSLA:xnas", side: "buy", quantity: 1, fillPriceBase: 110, feeBase: 2, feeSource: "model" },
        { symbol: "TSLA:xnas", side: "sell", quantity: 1, fillPriceBase: 120, feeBase: 1, feeSource: "broker" },
      ],
      new Set(["TSLA:xnas"]),
    );

    expect(rows).toEqual([{
      symbol: "TSLA:xnas",
      buyCash: 310,
      sellCash: 120,
      fees: 6,
      brokerFees: 4,
      estimatedFees: 2,
      netCashUsed: 196,
      fills: 3,
      held: true,
    }]);
  });

  it("sorts current holdings first by the cash they consumed", () => {
    const rows = buildSymbolCashFlow(
      [
        { symbol: "CLOSED", side: "buy", quantity: 10, fillPriceBase: 100, feeBase: 0, feeSource: "none" },
        { symbol: "SMALL", side: "buy", quantity: 1, fillPriceBase: 50, feeBase: 1, feeSource: "model" },
        { symbol: "LARGE", side: "buy", quantity: 2, fillPriceBase: 100, feeBase: 2, feeSource: "broker" },
      ],
      new Set(["SMALL", "LARGE"]),
    );
    expect(rows.map((row) => row.symbol)).toEqual(["LARGE", "SMALL", "CLOSED"]);
  });
});