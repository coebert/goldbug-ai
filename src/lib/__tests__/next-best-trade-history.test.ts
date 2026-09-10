import { describe, it, expect } from "vitest";
import {
  buildSuggestionHistory,
  type SuggestionFill,
  type SuggestionRecord,
} from "../next-best-trade-history";

const sugg = (o: Partial<SuggestionRecord> & Pick<SuggestionRecord, "id">): SuggestionRecord => ({
  symbol: "NVDA",
  name: "NVIDIA",
  currency: "GBP",
  suggestedAt: "2026-09-01T09:00:00Z",
  conviction: 0.6,
  price: 100,
  quantity: 4,
  ticketBase: 400,
  costBase: 8,
  expectedProfitBase: 20,
  netEdgeBps: 50,
  recommended: true,
  blockedReason: null,
  fxToBase: 1,
  ...o,
});

const buy = (o: Partial<SuggestionFill> = {}): SuggestionFill => ({
  symbol: "NVDA",
  side: "buy",
  quantity: 4,
  price: 101,
  feeBase: 5,
  filledAt: "2026-09-01T15:00:00Z",
  ...o,
});

describe("next-best-trade history", () => {
  it("marks a suggestion bought and scores it at real fill prices", () => {
    const { rows } = buildSuggestionHistory([sugg({ id: "1" })], [buy()], { NVDA: 110 });
    const r = rows[0]!;
    expect(r.status).toBe("bought");
    expect(r.filledQuantity).toBe(4);
    expect(r.avgFillPrice).toBe(101);
    expect(r.paper).toBe(false);
    expect(r.outcomeBase).toBe(31); // (110-101)*4 - 5
    expect(r.moveBps).toBeCloseTo(1000, 5);
  });

  it("scores a skipped suggestion on paper at the suggested price and quoted charges", () => {
    const { rows, summary } = buildSuggestionHistory([sugg({ id: "1" })], [], { NVDA: 110 });
    expect(rows[0]!.status).toBe("not_bought");
    expect(rows[0]!.paper).toBe(true);
    expect(rows[0]!.outcomeBase).toBe(32); // (110-100)*4 - 8
    expect(summary.missedBase).toBe(32);
    expect(summary.actualBase).toBe(0);
  });

  it("flags a part-filled suggestion", () => {
    const { rows } = buildSuggestionHistory([sugg({ id: "1" })], [buy({ quantity: 2 })], {
      NVDA: 110,
    });
    expect(rows[0]!.status).toBe("partial");
    expect(rows[0]!.filledQuantity).toBe(2);
  });

  it("ignores buys outside the match window and sells entirely", () => {
    const { rows } = buildSuggestionHistory(
      [sugg({ id: "1" })],
      [buy({ filledAt: "2026-09-20T15:00:00Z" }), { ...buy(), side: "sell" }],
      { NVDA: 110 },
    );
    expect(rows[0]!.status).toBe("not_bought");
  });

  it("never credits one purchase to two suggestions of the same name", () => {
    const { rows, summary } = buildSuggestionHistory(
      [
        sugg({ id: "1", suggestedAt: "2026-09-01T09:00:00Z" }),
        sugg({ id: "2", suggestedAt: "2026-09-02T09:00:00Z" }),
      ],
      [buy({ filledAt: "2026-09-02T15:00:00Z" })],
      { NVDA: 110 },
    );
    expect(summary.bought).toBe(1);
    // rows are newest first; the earlier suggestion claims the fill
    expect(rows.find((r) => r.id === "1")!.status).toBe("bought");
    expect(rows.find((r) => r.id === "2")!.status).toBe("not_bought");
  });

  it("converts foreign-currency outcomes into the account currency", () => {
    const { rows } = buildSuggestionHistory(
      [sugg({ id: "1", currency: "USD", fxToBase: 0.5, costBase: 0 })],
      [],
      { NVDA: 110 },
    );
    expect(rows[0]!.outcomeBase).toBe(20); // (110-100)*4*0.5
  });

  it("summarises hit rate and leaves unknown prices unscored", () => {
    const { rows, summary } = buildSuggestionHistory(
      [
        sugg({ id: "1", symbol: "NVDA" }),
        sugg({ id: "2", symbol: "TSLA", price: 200 }),
        sugg({ id: "3", symbol: "MSFT" }),
      ],
      [],
      { NVDA: 110, TSLA: 180 },
    );
    expect(summary.suggestions).toBe(3);
    expect(summary.hitRatePct).toBeCloseTo(50, 5);
    expect(rows.find((r) => r.id === "3")!.outcomeBase).toBeNull();
    expect(summary.expectedBase).toBe(60);
  });
});
