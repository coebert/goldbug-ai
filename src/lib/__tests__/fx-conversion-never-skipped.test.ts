// FX conversion must never be skipped for a foreign-listed position.
//
// A row tagged with the portfolio's base currency takes the identity FX path:
// the leg is added to the total at 1.0 and the tile reads plausibly but wrong
// (a USD book in a GBP portfolio is ~28% too high). These cases pin the four
// symbol shapes that historically arrived untagged or mis-tagged — Yahoo dot
// suffixes (.DE / .SW / .TO), bare US roots, and crypto pairs — across the
// whole chain: rules → valuation currency → audit FX leg → check → auto-fix.

import { describe, expect, it } from "vitest";
import {
  instrumentCcyFor,
  normalizeInstrumentCcy,
  tagRowsCurrency,
} from "../instrument-ccy-rules";
import { instrumentCurrency, type RevalueHolding } from "../equity-snapshot-revalue";
import { auditPriceUnits } from "../price-unit-audit";
import { checkInstrumentCurrencies } from "../instrument-ccy-check";
import { planInstrumentCcyFixes } from "../instrument-ccy-fix";
import { fxBreakdownFor, fxConversionFor } from "../valuation-consistency";

const BASE = "GBP";
const DAY = "2026-07-30";

const FX = new Map<string, number>([
  ["USD", 0.78],
  ["EUR", 0.85],
  ["CHF", 0.88],
  ["CAD", 0.57],
]);

type Case = {
  symbol: string;
  /** Currency the symbol shape must resolve to. */
  ccy: string;
  /** Rule expected to decide it. */
  source: "suffix" | "known_root" | "pair";
  quantity: number;
  quote: number;
};

const CASES: Case[] = [
  // Yahoo dot suffixes.
  { symbol: "SAP.DE", ccy: "EUR", source: "suffix", quantity: 12, quote: 140 },
  { symbol: "ALV.DE", ccy: "EUR", source: "suffix", quantity: 5, quote: 310 },
  { symbol: "NESN.SW", ccy: "CHF", source: "suffix", quantity: 8, quote: 95 },
  { symbol: "ROG.SW", ccy: "CHF", source: "suffix", quantity: 3, quote: 265 },
  { symbol: "SHOP.TO", ccy: "CAD", source: "suffix", quantity: 20, quote: 105 },
  { symbol: "RY.TO", ccy: "CAD", source: "suffix", quantity: 15, quote: 148 },
  // Bare US roots, no venue marker at all.
  { symbol: "AAPL", ccy: "USD", source: "known_root", quantity: 25, quote: 212 },
  { symbol: "VTI", ccy: "USD", source: "known_root", quantity: 30, quote: 288 },
  { symbol: "JNJ", ccy: "USD", source: "known_root", quantity: 18, quote: 160 },
  // Crypto pairs — the quote currency is the right-hand leg.
  { symbol: "BTC-USD", ccy: "USD", source: "pair", quantity: 0.04, quote: 62000 },
  { symbol: "ETH-EUR", ccy: "EUR", source: "pair", quantity: 1.5, quote: 2900 },
  { symbol: "BTC-GBP", ccy: "GBP", source: "pair", quantity: 0.02, quote: 48000 },
];

/** The fault: everything imported with the portfolio's base currency. */
function mistagged(): RevalueHolding[] {
  return CASES.map((c) => ({
    symbol: c.symbol,
    quantity: c.quantity,
    avg_cost: c.quote,
    instrument_ccy: BASE,
    opened_at: "2026-02-01T09:00:00Z",
  }));
}

function prices(): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const c of CASES) map.set(c.symbol.toUpperCase(), new Map([[DAY, c.quote]]));
  return map;
}

function expectedBase(c: Case): number {
  const rate = c.ccy === BASE ? 1 : FX.get(c.ccy)!;
  return c.quantity * c.quote * rate;
}

const FOREIGN = CASES.filter((c) => c.ccy !== BASE);

describe("currency rules resolve every venue shape", () => {
  it.each(CASES)("$symbol → $ccy via $source", (c) => {
    const result = normalizeInstrumentCcy(c.symbol, BASE);
    expect(result.currency).toBe(c.ccy);
    expect(result.source).toBe(c.source);
    expect(result.corrected).toBe(c.ccy !== BASE);
    expect(instrumentCcyFor(c.symbol, BASE)).toBe(c.ccy);
    // Valuation resolves the same currency as the tagging layer.
    expect(instrumentCurrency({ symbol: c.symbol, quantity: 1, instrument_ccy: BASE })).toBe(c.ccy);
  });

  it("ignores a mis-tag regardless of what the row claims", () => {
    for (const c of CASES) {
      for (const wrong of [null, "", "GBP", "GBX", "JPY", "usd"]) {
        expect(instrumentCcyFor(c.symbol, wrong), `${c.symbol}/${wrong}`).toBe(c.ccy);
      }
    }
  });

  it("is lowercase- and whitespace-tolerant on the symbol", () => {
    expect(instrumentCcyFor("  sap.de ", BASE)).toBe("EUR");
    expect(instrumentCcyFor("nesn.sw", BASE)).toBe("CHF");
    expect(instrumentCcyFor("shop.to", BASE)).toBe("CAD");
    expect(instrumentCcyFor("btc-usd", BASE)).toBe("USD");
  });
});

describe("valuation applies a real FX leg to every foreign position", () => {
  const { rows } = tagRowsCurrency(mistagged(), BASE);
  const audit = auditPriceUnits({
    portfolioId: "p-fx",
    date: DAY,
    baseCcy: BASE,
    holdings: rows,
    prices: prices(),
    fx: FX,
    cash: 0,
  });

  it.each(CASES)("converts $symbol at the $ccy rate", (c) => {
    const row = audit.rows.find((r) => r.symbol === c.symbol)!;
    expect(row).toBeTruthy();
    expect(row.instrument_ccy).toBe(c.ccy);
    // None of these venues quote in pence — the divisor must stay 1.
    expect(row.divisor).toBe(1);
    expect(row.pence_folded).toBe(false);
    expect(row.fx_source).toBe(c.ccy === BASE ? "identity" : "rate");
    expect(row.fx_rate).toBeCloseTo(c.ccy === BASE ? 1 : FX.get(c.ccy)!, 6);
    expect(row.value_instrument_ccy).toBeCloseTo(c.quantity * c.quote, 6);
    expect(row.value_base).toBeCloseTo(expectedBase(c), 4);
  });

  it("never leaves a foreign leg on the assumed-identity path", () => {
    const assumed = audit.rows.filter((r) => r.fx_source === "assumed_identity");
    expect(assumed).toEqual([]);
    for (const c of FOREIGN) {
      const row = audit.rows.find((r) => r.symbol === c.symbol)!;
      expect(fxConversionFor(row, BASE).assumed, c.symbol).toBe(false);
      expect(row.value_base, c.symbol).not.toBeCloseTo(row.value_instrument_ccy, 2);
    }
  });

  it("reports one FX leg per source currency and totals the book", () => {
    const legs = fxBreakdownFor(audit, BASE);
    expect(legs.map((l) => l.from_ccy).sort()).toEqual(["CAD", "CHF", "EUR", "GBP", "USD"]);
    for (const leg of legs) expect(leg.assumed).toBe(false);
    const total = CASES.reduce((sum, c) => sum + expectedBase(c), 0);
    expect(audit.holdings_value).toBeCloseTo(total, 2);
    expect(legs.reduce((sum, l) => sum + l.value_to, 0)).toBeCloseTo(total, 1);
  });
});

describe("validation catches the skipped-FX fault before it reaches a tile", () => {
  const report = checkInstrumentCurrencies({
    portfolioId: "p-fx",
    baseCcy: BASE,
    holdings: mistagged(),
    quotes: new Map(CASES.map((c) => [c.symbol, { close: c.quote, date: DAY }])),
    fx: FX,
  });

  it("flags every foreign leg and nothing that genuinely settles in base", () => {
    expect(report.checked).toBe(CASES.length);
    expect(report.findings.map((f) => f.symbol).sort()).toEqual(
      FOREIGN.map((c) => c.symbol).sort(),
    );
    // BTC-GBP really is a GBP leg — it must not be flagged.
    expect(report.findings.some((f) => f.symbol === "BTC-GBP")).toBe(false);
  });

  it("names the skipped conversion and quantifies the error", () => {
    for (const finding of report.findings) {
      const c = CASES.find((x) => x.symbol === finding.symbol)!;
      expect(finding.declared_ccy).toBe(BASE);
      expect(finding.venue_ccy).toBe(c.ccy);
      expect(finding.expected_divisor).toBe(1);
      expect(finding.issues.map((i) => i.code)).toContain("fx_conversion_skipped");
      expect(finding.value_base).toBeCloseTo(expectedBase(c), 2);
      // The mis-tagged path values the leg without any conversion.
      expect(finding.value_base_declared).toBeCloseTo(c.quantity * c.quote, 2);
    }
  });

  it("raises nothing once the rules have tagged the same book", () => {
    const { rows } = tagRowsCurrency(mistagged(), BASE);
    const clean = checkInstrumentCurrencies({
      portfolioId: "p-fx",
      baseCcy: BASE,
      holdings: rows,
      quotes: new Map(CASES.map((c) => [c.symbol, { close: c.quote, date: DAY }])),
      fx: FX,
    });
    expect(clean.findings).toEqual([]);
  });
});

describe("auto-fix repairs each shape without human review", () => {
  const report = checkInstrumentCurrencies({
    portfolioId: "p-fx",
    baseCcy: BASE,
    holdings: mistagged(),
    quotes: new Map(CASES.map((c) => [c.symbol, { close: c.quote, date: DAY }])),
    fx: FX,
  });
  const plan = planInstrumentCcyFixes(report.findings);

  it("plans a GBP → venue-currency correction for every flagged row", () => {
    expect(plan.skipped).toEqual([]);
    expect(plan.fixes.map((f) => f.symbol).sort()).toEqual(FOREIGN.map((c) => c.symbol).sort());
    for (const fix of plan.fixes) {
      const c = CASES.find((x) => x.symbol === fix.symbol)!;
      expect(fix.from_ccy).toBe(BASE);
      expect(fix.to_ccy).toBe(c.ccy);
      expect(fix.source).toBe(c.source);
    }
  });

  it("converges: applying the plan leaves nothing to fix", () => {
    const applied = mistagged().map((h) => {
      const fix = plan.fixes.find((f) => f.symbol === h.symbol);
      return fix ? { ...h, instrument_ccy: fix.to_ccy } : h;
    });
    const second = checkInstrumentCurrencies({
      portfolioId: "p-fx",
      baseCcy: BASE,
      holdings: applied,
      quotes: new Map(CASES.map((c) => [c.symbol, { close: c.quote, date: DAY }])),
      fx: FX,
    });
    expect(second.findings).toEqual([]);
    expect(planInstrumentCcyFixes(second.findings).fixes).toEqual([]);
  });
});
