// End-to-end portfolio valuation across venue families.
//
// Walks one multi-venue book through the full pipeline the tiles depend on:
//
//   tagging (instrument-ccy-rules)
//     → per-holding audit (price-unit-audit: fold → FX → base)
//       → currency check (instrument-ccy-check)
//         → FX breakdown + jump detection (valuation-consistency)
//
// Every venue family is represented: LSE pence, LSE pound-quoted (allowlist),
// US, XETRA, SIX, TSE, ASX and a crypto pair. The assertions pin the money,
// not just the shape, so a regression in any single stage shows up here.

import { describe, expect, it } from "vitest";
import { tagRowsCurrency, normalizeInstrumentCcy } from "../instrument-ccy-rules";
import { auditPriceUnits } from "../price-unit-audit";
import { checkInstrumentCurrencies } from "../instrument-ccy-check";
import {
  checkValuationConsistency,
  fxBreakdownFor,
  fxConversionFor,
} from "../valuation-consistency";
import type { RevalueHolding } from "../equity-snapshot-revalue";

const BASE = "GBP";
const DAY = "2026-07-30";
const PRIOR = "2026-07-29";

/** instrument ccy → GBP */
const FX = new Map<string, number>([
  ["USD", 0.78],
  ["EUR", 0.85],
  ["CHF", 0.88],
  ["JPY", 0.0052],
  ["AUD", 0.52],
]);

type Venue = {
  symbol: string;
  quantity: number;
  /** raw feed quote, in whatever unit the feed publishes */
  quote: number;
  expectedCcy: string;
  expectedDivisor: 1 | 100;
};

const VENUES: Venue[] = [
  // LSE common stock — feed quotes pence.
  { symbol: "ISF:xlon", quantity: 100, quote: 1062, expectedCcy: "GBP", expectedDivisor: 100 },
  // LSE Vanguard range — feed quotes pounds (allowlist).
  { symbol: "VUKE:xlon", quantity: 100, quote: 47.6, expectedCcy: "GBP", expectedDivisor: 1 },
  { symbol: "JNJ:xnys", quantity: 10, quote: 160, expectedCcy: "USD", expectedDivisor: 1 },
  { symbol: "SAP.DE", quantity: 10, quote: 140, expectedCcy: "EUR", expectedDivisor: 1 },
  { symbol: "NESN.SW", quantity: 10, quote: 95, expectedCcy: "CHF", expectedDivisor: 1 },
  { symbol: "7203.T", quantity: 100, quote: 2500, expectedCcy: "JPY", expectedDivisor: 1 },
  { symbol: "BHP.AX", quantity: 100, quote: 45, expectedCcy: "AUD", expectedDivisor: 1 },
  { symbol: "BTC-GBP", quantity: 0.05, quote: 50000, expectedCcy: "GBP", expectedDivisor: 1 },
];

/** The fault this pipeline exists to catch: every row imported as base ccy. */
function mistaggedBook(): RevalueHolding[] {
  return VENUES.map((v) => ({
    symbol: v.symbol,
    quantity: v.quantity,
    avg_cost: v.quote / v.expectedDivisor,
    instrument_ccy: "GBP",
    opened_at: "2026-01-05T09:00:00Z",
  }));
}

function priceMap(dates: string[] = [PRIOR, DAY]): Map<string, Map<string, number>> {
  const prices = new Map<string, Map<string, number>>();
  for (const v of VENUES) {
    const series = new Map<string, number>();
    for (const d of dates) series.set(d, v.quote);
    prices.set(v.symbol.toUpperCase(), series);
  }
  return prices;
}

function expectedBaseValue(v: Venue): number {
  const folded = v.quote / v.expectedDivisor;
  const rate = v.expectedCcy === BASE ? 1 : (FX.get(v.expectedCcy) ?? 1);
  return v.quantity * folded * rate;
}

const EXPECTED_HOLDINGS = VENUES.reduce((sum, v) => sum + expectedBaseValue(v), 0);

describe("venue-family tagging", () => {
  it("normalizes every venue family to its listing currency", () => {
    const { rows, corrections } = tagRowsCurrency(mistaggedBook(), BASE);

    for (const [i, v] of VENUES.entries()) {
      expect(rows[i]!.instrument_ccy, v.symbol).toBe(v.expectedCcy);
    }

    // Only the genuinely foreign legs needed correcting.
    const corrected = corrections.map((c) => c.symbol).sort();
    expect(corrected).toEqual(["7203.T", "BHP.AX", "JNJ:xnys", "NESN.SW", "SAP.DE"]);
    for (const c of corrections) expect(c.from).toBe("GBP");
  });

  it("is idempotent — re-tagging a corrected book changes nothing", () => {
    const first = tagRowsCurrency(mistaggedBook(), BASE);
    const second = tagRowsCurrency(first.rows, BASE);
    expect(second.corrections).toEqual([]);
    expect(second.rows.map((r) => r.instrument_ccy)).toEqual(
      first.rows.map((r) => r.instrument_ccy),
    );
  });

  it("treats GBX as a quote unit rather than a settlement currency", () => {
    const result = normalizeInstrumentCcy("SOMECO", "GBX");
    expect(result.currency).toBe("GBP");
    expect(result.corrected).toBe(true);
  });
});

describe("valuation of a tagged multi-venue book", () => {
  const { rows } = tagRowsCurrency(mistaggedBook(), BASE);
  const audit = auditPriceUnits({
    portfolioId: "p-venues",
    date: DAY,
    baseCcy: BASE,
    holdings: rows,
    prices: priceMap(),
    fx: FX,
    cash: 2500,
    stored: { holdings_value: EXPECTED_HOLDINGS, total_value: EXPECTED_HOLDINGS + 2500 },
  });

  it("applies the ÷100 pence fold only to GBX-quoted LSE listings", () => {
    for (const v of VENUES) {
      const row = audit.rows.find((r) => r.symbol === v.symbol)!;
      expect(row, v.symbol).toBeTruthy();
      expect(row.divisor, v.symbol).toBe(v.expectedDivisor);
      expect(row.pence_folded, v.symbol).toBe(v.expectedDivisor === 100);
      expect(row.instrument_ccy, v.symbol).toBe(v.expectedCcy);
      expect(row.price_in_instrument_ccy).toBeCloseTo(v.quote / v.expectedDivisor, 6);
    }
  });

  it("converts each leg into base currency with the supplied rate", () => {
    for (const v of VENUES) {
      const row = audit.rows.find((r) => r.symbol === v.symbol)!;
      expect(row.fx_source, v.symbol).toBe(v.expectedCcy === BASE ? "identity" : "rate");
      expect(row.value_base, v.symbol).toBeCloseTo(expectedBaseValue(v), 4);
      expect(row.warnings, v.symbol).toEqual([]);
    }
    expect(audit.holdings_value).toBeCloseTo(EXPECTED_HOLDINGS, 2);
    expect(audit.total_value).toBeCloseTo(EXPECTED_HOLDINGS + 2500, 2);
    expect(audit.stored_ratio).toBeCloseTo(1, 3);
  });

  it("produces an FX breakdown whose legs reconcile to the day's book", () => {
    const legs = fxBreakdownFor(audit, BASE);
    const currencies = legs.map((l) => l.from_ccy).sort();
    expect(currencies).toEqual(["AUD", "CHF", "EUR", "GBP", "JPY", "USD"]);

    for (const leg of legs) {
      expect(leg.to_ccy).toBe(BASE);
      expect(leg.assumed).toBe(false);
      expect(leg.value_to).toBeCloseTo(leg.value_from * (leg.from_ccy === BASE ? 1 : leg.rate), 1);
    }

    // GBP carries three positions (ISF, VUKE, BTC-GBP) and no conversion.
    const gbp = legs.find((l) => l.from_ccy === "GBP")!;
    expect(gbp.positions).toBe(3);
    expect(gbp.rate).toBe(1);

    const total = legs.reduce((sum, l) => sum + l.value_to, 0);
    expect(total).toBeCloseTo(EXPECTED_HOLDINGS, 1);
    expect(legs.reduce((sum, l) => sum + l.weight, 0)).toBeCloseTo(1, 3);
    // Sorted largest-first so the banner leads with the dominant currency.
    expect(legs).toEqual([...legs].sort((a, b) => b.value_to - a.value_to));
  });

  it("spells out the conversion arithmetic per symbol", () => {
    const jnj = audit.rows.find((r) => r.symbol === "JNJ:xnys")!;
    const fx = fxConversionFor(jnj, BASE);
    expect(fx.from_ccy).toBe("USD");
    expect(fx.to_ccy).toBe("GBP");
    expect(fx.assumed).toBe(false);
    expect(fx.detail).toContain("USD");
    expect(fx.detail).toContain("GBP");

    const isf = audit.rows.find((r) => r.symbol === "ISF:xlon")!;
    expect(fxConversionFor(isf, BASE).detail).toContain("no conversion");
  });

  it("raises no currency findings once the book is tagged by the rules", () => {
    const report = checkInstrumentCurrencies({
      portfolioId: "p-venues",
      baseCcy: BASE,
      holdings: rows,
      quotes: new Map(VENUES.map((v) => [v.symbol, { close: v.quote, date: DAY }])),
      fx: FX,
      snapshot: { date: DAY, holdings_value: EXPECTED_HOLDINGS },
    });
    expect(report.checked).toBe(VENUES.length);
    expect(report.findings).toEqual([]);
  });
});

describe("faults surfaced end to end", () => {
  it("flags the untagged book for skipped FX conversion on every foreign leg", () => {
    const report = checkInstrumentCurrencies({
      portfolioId: "p-venues",
      baseCcy: BASE,
      holdings: mistaggedBook(),
      quotes: new Map(VENUES.map((v) => [v.symbol, { close: v.quote, date: DAY }])),
      fx: FX,
      snapshot: { date: DAY, holdings_value: EXPECTED_HOLDINGS },
    });

    const flagged = report.findings.map((f) => f.symbol).sort();
    expect(flagged).toEqual(["7203.T", "BHP.AX", "JNJ:xnys", "NESN.SW", "SAP.DE"]);
    for (const finding of report.findings) {
      expect(finding.declared_ccy).toBe("GBP");
      expect(finding.issues.map((i) => i.code)).toContain("fx_conversion_skipped");
    }
  });

  it("classifies a 100x snapshot jump as a pence fold and attaches the FX legs", () => {
    const { rows } = tagRowsCurrency(mistaggedBook(), BASE);
    const audit = auditPriceUnits({
      portfolioId: "p-venues",
      date: DAY,
      baseCcy: BASE,
      holdings: rows,
      prices: priceMap(),
      fx: FX,
      cash: 2500,
    });

    const report = checkValuationConsistency({
      portfolioId: "p-venues",
      baseCcy: BASE,
      snapshots: [
        { snapshot_date: PRIOR, total_value: 20000, holdings_value: 17500, cash: 2500 },
        { snapshot_date: DAY, total_value: 1_752_500, holdings_value: 1_750_000, cash: 2500 },
      ],
      audits: { [DAY]: audit },
    });

    expect(report.jumps).toHaveLength(1);
    const jump = report.worst!;
    expect(jump.date).toBe(DAY);
    expect(jump.direction).toBe("up");
    expect(jump.suspected_source).toBe("gbx_pence_fold");
    expect(jump.suspect_symbols.map((s) => s.symbol)).toContain("ISF:xlon");
    expect(jump.fx_breakdown.map((l) => l.from_ccy)).toContain("USD");
    expect(jump.explanation.length).toBeGreaterThan(0);
  });

  it("classifies a missing FX rate as such and marks the leg assumed", () => {
    const { rows } = tagRowsCurrency(mistaggedBook(), BASE);
    const partialFx = new Map(FX);
    partialFx.delete("USD");

    const audit = auditPriceUnits({
      portfolioId: "p-venues",
      date: DAY,
      baseCcy: BASE,
      holdings: rows,
      prices: priceMap(),
      fx: partialFx,
      cash: 2500,
    });

    const usd = audit.rows.find((r) => r.symbol === "JNJ:xnys")!;
    expect(usd.fx_source).toBe("assumed_identity");
    expect(fxConversionFor(usd, BASE).assumed).toBe(true);
    const usdLeg = fxBreakdownFor(audit, BASE).find((l) => l.from_ccy === "USD")!;
    expect(usdLeg.assumed).toBe(true);

    const report = checkValuationConsistency({
      portfolioId: "p-venues",
      baseCcy: BASE,
      snapshots: [
        { snapshot_date: PRIOR, total_value: 20000, holdings_value: 17500, cash: 2500 },
        { snapshot_date: DAY, total_value: 90000, holdings_value: 87500, cash: 2500 },
      ],
      audits: { [DAY]: audit },
    });

    expect(report.worst?.suspected_source).toBe("missing_fx_rate");
    expect(report.worst?.suspect_symbols.map((s) => s.symbol)).toContain("JNJ:xnys");
  });

  it("carries a stale quote forward and warns rather than dropping the leg", () => {
    const { rows } = tagRowsCurrency(mistaggedBook(), BASE);
    const audit = auditPriceUnits({
      portfolioId: "p-venues",
      date: DAY,
      baseCcy: BASE,
      holdings: rows,
      // Only the prior day has closes: every leg must carry forward.
      prices: priceMap([PRIOR]),
      fx: FX,
      cash: 0,
    });

    for (const row of audit.rows) {
      expect(row.price_source, row.symbol).toBe("carried_close");
      expect(row.quote_date, row.symbol).toBe(PRIOR);
      expect(row.warnings.join(" "), row.symbol).toContain(PRIOR);
    }
    expect(audit.holdings_value).toBeCloseTo(EXPECTED_HOLDINGS, 2);
  });
});
