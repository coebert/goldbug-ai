// Regression tests for cash-aware universe selection.
//
// These lock in the behaviour that runDailyTick relies on when it writes
// `decisions.raw.guardrails.affordability`:
//   * Instruments whose one-share cost exceeds the per-symbol budget are
//     dropped from BUY candidates with a human-readable reason.
//   * The per-symbol budget clamps to available cash even when the cap % of
//     total value would allow more.
//   * The min-trade-value floor drops everything when the budget is below it.
//   * Already-held symbols are always kept (so sells still work) even when
//     they are no longer affordable.
//   * When nothing is affordable, we fall back to the 6 cheapest with a
//     clear "add funds" note.
//   * The returned metadata (perSymbolBudget, minTradeValue, dropped,
//     notes) matches the shape written to decisions.raw.
import { describe, expect, it } from "vitest";
import {
  filterUniverseByAffordability,
  type UniverseSymbol,
} from "../universe.server";

const U: UniverseSymbol[] = [
  { symbol: "CHEAP", name: "Cheap Co", asset_class: "stock" },
  { symbol: "MID", name: "Mid Co", asset_class: "stock" },
  { symbol: "EXP", name: "Expensive Co", asset_class: "stock" },
  { symbol: "MEGA", name: "Mega Co", asset_class: "stock" },
];

function priceMap(entries: Array<[string, number]>) {
  return new Map<string, number>(entries);
}

describe("filterUniverseByAffordability", () => {
  it("drops instruments whose 1 share price exceeds the per-symbol budget", () => {
    // £100 cash, 15 % per-symbol cap => budget = 15.
    // CHEAP (5) and MID (12) fit; EXP (50) and MEGA (2000) do not.
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 12], ["EXP", 50], ["MEGA", 2000]]),
      heldSymbols: [],
      cash: 100, totalValue: 100,
      perSymbolCapPct: 0.15, minTradeValue: 5,
      currency: "GBP",
    });

    expect(res.perSymbolBudget).toBeCloseTo(15);
    expect(res.candidates.map((c) => c.symbol)).toEqual(["CHEAP", "MID"]);
    const droppedSyms = res.dropped.map((d) => d.symbol);
    expect(droppedSyms).toEqual(["EXP", "MEGA"]);
    for (const d of res.dropped) {
      expect(d.reason).toMatch(/> per-symbol budget/);
    }
    expect(res.fellBackToCheapest).toBe(false);
    expect(res.notes[0]).toMatch(/kept 2\/4 instruments; dropped 2/);
  });

  it("clamps the per-symbol budget to available cash even when the cap % would allow more", () => {
    // totalValue = 1000 (holdings-heavy), but cash is only 20.
    // 15 % of 1000 = 150, but cash floor forces budget = 20.
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 12], ["EXP", 50], ["MEGA", 2000]]),
      heldSymbols: [],
      cash: 20, totalValue: 1000,
      perSymbolCapPct: 0.15, minTradeValue: 5,
      currency: "GBP",
    });
    expect(res.perSymbolBudget).toBeCloseTo(20);
    expect(res.candidates.map((c) => c.symbol)).toEqual(["CHEAP", "MID"]);
  });

  it("drops everything when the per-symbol budget is below the min-trade-value floor", () => {
    // Budget = 15 (per above), but min_trade_value = 25 => nothing tradeable.
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 12], ["EXP", 50], ["MEGA", 2000]]),
      heldSymbols: [],
      cash: 100, totalValue: 100,
      perSymbolCapPct: 0.15, minTradeValue: 25,
      currency: "GBP",
    });
    expect(res.fellBackToCheapest).toBe(true);
    // Falls back to the 6 cheapest (there are only 4 in this test universe).
    expect(res.candidates.map((c) => c.symbol)).toEqual(["CHEAP", "MID", "EXP", "MEGA"]);
    expect(res.notes[0]).toMatch(
      /No instruments affordable within per-symbol budget 15\.00 GBP/,
    );
    // Every non-fallback drop should cite the min-trade-value reason for the
    // two symbols that were also under the price ceiling.
    const cheapDrop = res.dropped.find((d) => d.symbol === "CHEAP");
    expect(cheapDrop?.reason).toMatch(/< min trade value 25/);
  });

  it("always keeps held symbols so sells remain possible even when unaffordable", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 12], ["EXP", 50], ["MEGA", 2000]]),
      heldSymbols: ["MEGA"],
      cash: 100, totalValue: 100,
      perSymbolCapPct: 0.15, minTradeValue: 5,
      currency: "GBP",
    });
    // MEGA is unaffordable but held → appended to candidates.
    expect(res.candidates.map((c) => c.symbol)).toContain("MEGA");
    // …and is still reported in the dropped-for-cash list so the AI prompt
    // makes clear it can't be bought further.
    expect(res.dropped.map((d) => d.symbol)).toContain("MEGA");
  });

  it("returns the exact metadata shape written to decisions.raw.guardrails.affordability", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 12], ["EXP", 50], ["MEGA", 2000]]),
      heldSymbols: [],
      cash: 100, totalValue: 100,
      perSymbolCapPct: 0.15, minTradeValue: 5,
      currency: "GBP",
    });
    // Mirror the object that runDailyTick persists.
    const affordability = {
      per_symbol_budget: res.perSymbolBudget,
      min_trade_value: res.minTradeValue,
      universe_total: U.length,
      candidates_kept: res.candidates.length,
      dropped_for_cash: res.dropped,
      notes: res.notes,
    };
    expect(affordability).toMatchObject({
      per_symbol_budget: 15,
      min_trade_value: 5,
      universe_total: 4,
      candidates_kept: 2,
      dropped_for_cash: [
        { symbol: "EXP", price: 50, reason: expect.stringContaining("per-symbol budget 15.00") },
        { symbol: "MEGA", price: 2000, reason: expect.stringContaining("per-symbol budget 15.00") },
      ],
      notes: [expect.stringContaining("kept 2/4 instruments")],
    });
  });

  it("treats missing/zero prices as unknown and passes them through untouched", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: U,
      priceMap: priceMap([["CHEAP", 5], ["MID", 0]]), // EXP/MEGA missing, MID zero
      heldSymbols: [],
      cash: 100, totalValue: 100,
      perSymbolCapPct: 0.15, minTradeValue: 5,
      currency: "GBP",
    });
    // Unknown-price symbols aren't dropped by the cash filter; downstream
    // guardrails handle them.
    expect(res.candidates.map((c) => c.symbol)).toEqual(["CHEAP", "MID", "EXP", "MEGA"]);
    expect(res.dropped).toEqual([]);
  });

  it("keeps priority short proxies inside a truncated candidate window", () => {
    const universe: UniverseSymbol[] = [
      ...Array.from({ length: 24 }, (_, i) => ({
        symbol: `STK${i + 1}`,
        name: `Stock ${i + 1}`,
        asset_class: "stock" as const,
      })),
      { symbol: "XUKS.L", name: "Inverse FTSE", asset_class: "etf" },
      { symbol: "XSPS.L", name: "Inverse S&P", asset_class: "etf" },
    ];
    const prices = new Map(universe.map((u) => [u.symbol, 10]));
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: [],
      cash: 10_000,
      totalValue: 10_000,
      perSymbolCapPct: 0.15,
      minTradeValue: 25,
      currency: "GBP",
      maxCandidates: 6,
      prioritySymbols: ["XUKS.L", "XSPS.L"],
    });

    expect(res.candidates).toHaveLength(6);
    expect(res.candidates.map((c) => c.symbol).slice(0, 2)).toEqual(["XUKS.L", "XSPS.L"]);
  });
});
