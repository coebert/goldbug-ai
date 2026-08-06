import { describe, expect, it } from "vitest";
import {
  applySplitAdjustment,
  barPrice,
  buildRealTape,
  detectUnhandledActions,
  dividendIncome,
  type SymbolHistory,
} from "../real-market-tape";

const bar = (date: string, close: number, adjClose?: number) => ({ date, close, adjClose });

describe("applySplitAdjustment", () => {
  it("back-adjusts pre-split raw closes by the ratio", () => {
    const bars = [bar("2020-08-28", 400), bar("2020-08-31", 100)];
    const out = applySplitAdjustment(bars, [
      { symbol: "AAPL", date: "2020-08-31", kind: "split", value: 4 },
    ]);
    expect(out[0]!.close).toBe(100);
    expect(out[1]!.close).toBe(100);
  });

  it("is a no-op without splits", () => {
    const bars = [bar("2024-01-02", 10), bar("2024-01-03", 11)];
    expect(applySplitAdjustment(bars, []).map((b) => b.close)).toEqual([10, 11]);
  });

  it("compounds multiple splits", () => {
    const out = applySplitAdjustment([bar("2020-01-01", 800)], [
      { symbol: "NVDA", date: "2021-07-20", kind: "split", value: 4 },
      { symbol: "NVDA", date: "2024-06-10", kind: "split", value: 10 },
    ]);
    expect(out[0]!.close).toBe(20);
  });
});

describe("barPrice", () => {
  it("prefers adjusted close in total-return mode", () => {
    expect(barPrice(bar("2024-01-02", 100, 96), "total_return")).toBe(96);
    expect(barPrice(bar("2024-01-02", 100, 96), "price_return")).toBe(100);
  });

  it("falls back to close when adjusted is missing", () => {
    expect(barPrice({ date: "2024-01-02", close: 50, adjClose: null }, "total_return")).toBe(50);
  });
});

describe("buildRealTape", () => {
  const histories: SymbolHistory[] = [
    {
      symbol: "AAA",
      bars: [bar("2024-01-02", 10, 10), bar("2024-01-03", 11, 11), bar("2024-01-04", 12, 12)],
      dividends: [{ symbol: "AAA", date: "2024-01-03", kind: "dividend", value: 0.25 }],
    },
    {
      symbol: "BBB",
      // No bar on the 3rd — a halt/holiday for this listing only.
      bars: [bar("2024-01-02", 100, 100), bar("2024-01-04", 104, 104)],
    },
  ];

  it("unions calendars and forward-fills missing closes", () => {
    const t = buildRealTape(histories);
    expect(t.bars.map((b) => b.date)).toEqual(["2024-01-02", "2024-01-03", "2024-01-04"]);
    expect(t.bars[1]!.closes["BBB"]).toBe(100);
    expect(t.filledBars["BBB"]).toBe(1);
    expect(t.filledBars["AAA"]).toBe(0);
  });

  it("never looks ahead: a symbol is absent before its first close", () => {
    const t = buildRealTape([
      histories[0]!,
      { symbol: "CCC", bars: [bar("2024-01-04", 7, 7)] },
    ]);
    expect(t.bars[0]!.closes["CCC"]).toBeUndefined();
    expect(t.bars[2]!.closes["CCC"]).toBe(7);
  });

  it("honours the date window and reports corporate actions in it", () => {
    const t = buildRealTape(histories, { from: "2024-01-03" });
    expect(t.bars).toHaveLength(2);
    expect(t.actions).toHaveLength(1);
    expect(buildRealTape(histories, { from: "2024-01-04" }).actions).toHaveLength(0);
  });

  it("drops non-positive and non-finite closes", () => {
    const t = buildRealTape([
      { symbol: "AAA", bars: [bar("2024-01-02", 10), { date: "2024-01-03", close: 0 }] },
    ]);
    expect(t.bars).toHaveLength(1);
  });
});

describe("detectUnhandledActions", () => {
  it("flags an unadjusted 4:1 split as a jump", () => {
    const flags = detectUnhandledActions([
      { date: "2020-08-28", closes: { AAPL: 400 } },
      { date: "2020-08-31", closes: { AAPL: 100 } },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.movePct).toBeCloseTo(-75, 5);
  });

  it("ignores ordinary volatility", () => {
    expect(
      detectUnhandledActions([
        { date: "2024-01-02", closes: { AAA: 100 } },
        { date: "2024-01-03", closes: { AAA: 112 } },
      ]),
    ).toHaveLength(0);
  });
});

describe("dividendIncome", () => {
  it("sums cash dividends for held shares only", () => {
    const hs: SymbolHistory[] = [
      {
        symbol: "AAA",
        bars: [],
        dividends: [
          { symbol: "AAA", date: "2024-01-03", kind: "dividend", value: 0.25 },
          { symbol: "AAA", date: "2024-04-03", kind: "dividend", value: 0.25 },
        ],
      },
      {
        symbol: "BBB",
        bars: [],
        dividends: [{ symbol: "BBB", date: "2024-02-03", kind: "dividend", value: 1 }],
      },
    ];
    expect(dividendIncome(hs, { AAA: 100 })).toBe(50);
    expect(dividendIncome(hs, { AAA: 100, BBB: 10 })).toBe(60);
  });
});
