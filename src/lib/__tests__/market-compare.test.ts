import { describe, expect, it } from "vitest";

import {
  MAX_COMPARE_SYMBOLS,
  buildComparison,
  parseCompareParam,
  serialiseCompareParam,
  toggleCompareSymbol,
} from "../market-compare";
import type { HistoryPoint, SymbolHistory } from "../market-symbol-history";

function history(symbol: string, series: Array<[string, number]>): SymbolHistory {
  const points: HistoryPoint[] = series.map(([date, close]) => ({
    date,
    close,
    indexed: 100,
    sma50: null,
    sma200: null,
  }));
  return {
    symbol,
    label: symbol.toUpperCase(),
    kind: "Market",
    days: 90,
    points,
    last: points.at(-1)?.close ?? null,
    asOf: points.at(-1)?.date ?? null,
    changePct: null,
    changeAbs: null,
    high: null,
    low: null,
    volatilityPct: null,
    maxDrawdownPct: null,
    sma50: null,
    sma200: null,
    aboveSma50: null,
    aboveSma200: null,
  };
}

describe("compare param handling", () => {
  it("parses, dedupes and drops the primary symbol", () => {
    expect(parseCompareParam("^GSPC, GLD ,^GSPC,BTC", "^GSPC")).toEqual(["GLD", "BTC"]);
  });

  it("caps the list", () => {
    expect(parseCompareParam("A,B,C,D,E,F")).toHaveLength(MAX_COMPARE_SYMBOLS);
  });

  it("round-trips through serialise", () => {
    expect(serialiseCompareParam(["A", "B"])).toBe("A,B");
    expect(serialiseCompareParam([])).toBeUndefined();
  });

  it("toggles on and off and respects the cap", () => {
    expect(toggleCompareSymbol(["A"], "B")).toEqual(["A", "B"]);
    expect(toggleCompareSymbol(["A", "B"], "A")).toEqual(["B"]);
    const full = ["A", "B", "C", "D"];
    expect(toggleCompareSymbol(full, "E")).toEqual(full);
  });
});

describe("buildComparison", () => {
  it("rebases every series to 100 on the shared start date", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 100],
        ["2026-01-02", 110],
        ["2026-01-03", 120],
      ]),
      // B starts a day later, so the shared window is Jan 2-3.
      history("B", [
        ["2026-01-02", 50],
        ["2026-01-03", 45],
      ]),
    ]);

    expect(cmp.from).toBe("2026-01-02");
    expect(cmp.to).toBe("2026-01-03");
    expect(cmp.points[0]["A"]).toBe(100);
    expect(cmp.points[0]["B"]).toBe(100);
    // A: 110 -> 120 = +9.09%, B: 50 -> 45 = -10%
    expect(cmp.series[0].changePct).toBeCloseTo(9.0909, 3);
    expect(cmp.series[1].changePct).toBeCloseTo(-10, 6);
  });

  it("reports peak, trough and drawdown inside the shared window", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 100],
        ["2026-01-02", 120],
        ["2026-01-03", 90],
      ]),
    ]);
    expect(cmp.series[0].peakPct).toBeCloseTo(20, 6);
    expect(cmp.series[0].troughPct).toBeCloseTo(-10, 6);
    expect(cmp.series[0].maxDrawdownPct).toBeCloseTo(-25, 6);
  });

  it("gives each series a distinct colour", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
      history("B", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
    ]);
    expect(cmp.series[0].color).not.toBe(cmp.series[1].color);
  });

  it("returns an empty comparison when the overlap is too short", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
      history("B", [
        ["2026-02-01", 1],
        ["2026-02-02", 2],
      ]),
    ]);
    expect(cmp.points).toEqual([]);
    expect(cmp.series).toEqual([]);
  });
});
