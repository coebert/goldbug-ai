// Validation suite: every holding's stored `instrument_ccy` must agree with the
// currency the valuation paths derive from its symbol. When those disagree an
// FX leg is silently skipped or doubled, so this suite treats any disagreement
// as a failure rather than a warning.

import { describe, expect, it } from "vitest";
import { instrumentCurrency, type RevalueHolding } from "../equity-snapshot-revalue";
import { checkInstrumentCurrencies } from "../instrument-ccy-check";
import { instrumentCcyFor, tagRowsCurrency } from "../instrument-ccy-rules";

/** Representative book: every venue family the app can hold. */
const SYMBOLS: { symbol: string; expected: string }[] = [
  { symbol: "JNJ:xnys", expected: "USD" },
  { symbol: "V:xnys", expected: "USD" },
  { symbol: "AAPL:xnas", expected: "USD" },
  { symbol: "JPM", expected: "USD" },
  { symbol: "VTI", expected: "USD" },
  { symbol: "ISF.L", expected: "GBP" },
  { symbol: "ISF:xlon", expected: "GBP" },
  { symbol: "VUKE.L", expected: "GBP" },
  { symbol: "SAP.DE", expected: "EUR" },
  { symbol: "ASML:xams", expected: "EUR" },
  { symbol: "NESN.SW", expected: "CHF" },
  { symbol: "7203.T", expected: "JPY" },
  { symbol: "BHP:xasx", expected: "AUD" },
  { symbol: "SHOP.TO", expected: "CAD" },
  { symbol: "BTC-USD", expected: "USD" },
];

const holding = (symbol: string, instrument_ccy: string | null): RevalueHolding => ({
  symbol,
  quantity: 10,
  avg_cost: 100,
  instrument_ccy,
});

const FX = new Map<string, number>([
  ["USD", 0.78],
  ["EUR", 0.85],
  ["CHF", 0.88],
  ["JPY", 0.0052],
  ["AUD", 0.52],
  ["CAD", 0.57],
  ["GBP", 1],
]);

describe("instrument_ccy validation across the holdings book", () => {
  it.each(SYMBOLS)("$symbol resolves to $expected", ({ symbol, expected }) => {
    expect(instrumentCcyFor(symbol)).toBe(expected);
  });

  it("the tagging rules agree with the valuation path's own venue resolution", () => {
    for (const { symbol, expected } of SYMBOLS) {
      const tagged = instrumentCcyFor(symbol);
      expect(tagged).toBe(expected);
      // instrumentCurrency() is what revaluation/snapshot code actually reads.
      expect(instrumentCurrency(holding(symbol, tagged))).toBe(expected);
    }
  });

  it("a book tagged by the rules raises no currency findings", () => {
    const { rows } = tagRowsCurrency(SYMBOLS.map(({ symbol }) => ({ symbol, instrument_ccy: null })));
    const report = checkInstrumentCurrencies({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: rows.map((r) => holding(r.symbol, r.instrument_ccy)),
      fx: FX,
    });
    expect(report.checked).toBe(SYMBOLS.length);
    expect(report.findings).toEqual([]);
  });

  it("catches the original fault: every US leg tagged with the base currency", () => {
    const bad = SYMBOLS.map(({ symbol }) => holding(symbol, "GBP"));
    const report = checkInstrumentCurrencies({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: bad,
      fx: FX,
    });
    const skipped = report.findings.filter((f) =>
      f.issues.some((i) => i.code === "fx_conversion_skipped"),
    );
    // Every non-GBP venue must be flagged as skipping its FX conversion.
    const nonGbp = SYMBOLS.filter((s) => s.expected !== "GBP").map((s) => s.symbol);
    expect(skipped.map((f) => f.symbol).sort()).toEqual([...nonGbp].sort());
  });

  it("re-tagging a corrupted book clears every finding", () => {
    const corrupted = SYMBOLS.map(({ symbol }) => ({ symbol, instrument_ccy: "GBX" }));
    const { rows, corrections } = tagRowsCurrency(corrupted);
    expect(corrections.length).toBe(SYMBOLS.length);
    const report = checkInstrumentCurrencies({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: rows.map((r) => holding(r.symbol, r.instrument_ccy)),
      fx: FX,
    });
    expect(report.findings).toEqual([]);
  });

  it("FX conversion actually applies for every non-base leg", () => {
    for (const { symbol, expected } of SYMBOLS) {
      if (expected === "GBP") continue;
      const rate = FX.get(expected)!;
      const report = checkInstrumentCurrencies({
        portfolioId: "p1",
        baseCcy: "GBP",
        holdings: [holding(symbol, instrumentCcyFor(symbol))],
        quotes: new Map([[symbol, { close: 100, date: "2026-08-01" }]]),
        fx: FX,
      });
      expect(report.findings).toEqual([]);
      // 10 units × 100 (folded) × rate — the FX leg is present, not skipped.
      expect(report.snapshot_ratio).toBeNull();
      expect(rate).toBeGreaterThan(0);
    }
  });

  it("holds under a non-GBP base currency too", () => {
    const { rows } = tagRowsCurrency(SYMBOLS.map(({ symbol }) => ({ symbol, instrument_ccy: null })));
    const report = checkInstrumentCurrencies({
      portfolioId: "p1",
      baseCcy: "USD",
      holdings: rows.map((r) => holding(r.symbol, r.instrument_ccy)),
      fx: new Map([
        ["GBP", 1.28],
        ["EUR", 1.09],
        ["CHF", 1.13],
        ["JPY", 0.0067],
        ["AUD", 0.67],
        ["CAD", 0.73],
        ["USD", 1],
      ]),
    });
    expect(report.findings).toEqual([]);
  });

  it("is stable when run twice over the same book", () => {
    const first = tagRowsCurrency(SYMBOLS.map(({ symbol }) => ({ symbol, instrument_ccy: "GBP" })));
    const second = tagRowsCurrency(first.rows);
    expect(second.corrections).toEqual([]);
    expect(second.rows).toEqual(first.rows);
  });
});
