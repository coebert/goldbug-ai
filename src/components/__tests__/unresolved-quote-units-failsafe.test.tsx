// Fail-safe behaviour when a ticker's quote units cannot be resolved.
//
// Every money figure in this app depends on one question: is this quote in
// pence (GBX) or pounds (GBP) — or some third currency entirely? When the
// answer is knowable we answer it (observed quote currency > stored
// instrument_ccy > venue rules > the LSE GBX default). When it is NOT — an
// unrecognised venue, no stored tag, no observed currency — the old code
// silently defaulted to the portfolio's base currency with a divisor of 1.
// That guess is either right or 100x wrong, and the UI had no way to tell.
//
// The rule these tests lock in: an unresolvable ticker contributes NOTHING to
// the total, marks the valuation degraded with an `unresolved_quote_units`
// warning, and renders as "—" / "units unresolved" with no percentage at all.
// Silence is the correct output; a wrong percentage is not.

import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/components/__tests__/render-with-query";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import {
  computeValuation,
  quoteUnitsResolved,
  resolveQuoteUnits,
} from "@/lib/valuation/kernel";

const fx = (from: string, to: string) => (from === to ? 1 : from === "USD" ? 0.8 : null);

describe("unit resolution: fail-safe when GBX vs GBP is unknowable", () => {
  it("flags a symbol with no venue, no tag and no observed currency as unresolved", () => {
    const units = resolveQuoteUnits("MYSTERY123", null, null, "GBP");
    expect(units.resolved).toBe(false);
    expect(units.quoteCurrency).toBe("UNKNOWN");
    expect(units.quoteCurrencySource).toBe("unresolved");
    expect(units.unresolvedReason).toMatch(/GBX vs GBP cannot be decided/i);
    expect(quoteUnitsResolved("MYSTERY123")).toBe(false);
  });

  it("still resolves every path where the units ARE knowable", () => {
    // Venue rules (LSE default is pence).
    expect(resolveQuoteUnits("MKS:xlon", null, null, "GBP")).toMatchObject({
      resolved: true,
      quoteCurrency: "GBX",
      unitDivisor: 100,
    });
    // GBP-allowlisted LSE ticker.
    expect(resolveQuoteUnits("VUKE.L", null, null, "GBP")).toMatchObject({
      resolved: true,
      quoteCurrency: "GBP",
      unitDivisor: 1,
    });
    // Recognised US venue.
    expect(resolveQuoteUnits("AAPL:xnas", null, null, "GBP")).toMatchObject({
      resolved: true,
      quoteCurrency: "USD",
      unitDivisor: 1,
    });
    // An unrecognised symbol becomes resolvable as soon as it carries a tag…
    expect(resolveQuoteUnits("MYSTERY123", "USD", null, "GBP")).toMatchObject({
      resolved: true,
      quoteCurrency: "USD",
    });
    // …or an observed quote currency from the wire.
    expect(resolveQuoteUnits("MYSTERY123", null, "GBX", "GBP")).toMatchObject({
      resolved: true,
      quoteCurrency: "GBX",
      unitDivisor: 100,
      instrumentCurrency: "GBP",
    });
  });

  it("withholds the unresolvable row from the total instead of guessing", () => {
    const result = computeValuation({
      holdings: [
        { symbol: "MKS:xlon", quantity: 500, instrument_ccy: "GBX", avg_cost: 400 },
        { symbol: "MYSTERY123", quantity: 1000, avg_cost: 250 },
      ],
      wallet: { GBP: 1_000 },
      baseCcy: "GBP",
      price: (s) => (s.toUpperCase() === "MKS.L" ? 420 : s.toUpperCase() === "MYSTERY123" ? 250 : null),
      fx,
      asOf: "2026-08-01T10:00:00.000Z",
    });

    // Only the resolvable row contributes: 500 × 4.20 = 2100, plus 1000 cash.
    expect(result.holdingsValue).toBeCloseTo(2_100, 2);
    expect(result.totalValue).toBeCloseTo(3_100, 2);
    // The naive guesses would have been 250,000 (pounds) or 2,500 (pence) —
    // neither appears anywhere in the total.
    expect(result.totalValue).not.toBeCloseTo(253_100, 2);
    expect(result.totalValue).not.toBeCloseTo(5_600, 2);
  });

  it("marks the valuation degraded and explains which symbol is unresolved", () => {
    const result = computeValuation({
      holdings: [{ symbol: "MYSTERY123", quantity: 10, avg_cost: 5 }],
      wallet: { GBP: 100 },
      baseCcy: "GBP",
      price: () => 5,
      fx,
    });

    expect(result.provenance.degraded).toBe(true);
    const warning = result.provenance.warnings.find((w) => w.code === "unresolved_quote_units");
    expect(warning).toBeDefined();
    expect(warning!.symbol).toBe("MYSTERY123");
    expect(warning!.message).toContain("MYSTERY123");
  });

  it("keeps the unresolved row in provenance with zeroed value, for diagnostics", () => {
    const result = computeValuation({
      holdings: [{ symbol: "MYSTERY123", quantity: 10, avg_cost: 5 }],
      wallet: {},
      baseCcy: "GBP",
      price: () => 42,
      fx,
    });

    const line = result.provenance.lines.find((l) => l.symbol === "MYSTERY123")!;
    expect(line.unitsResolved).toBe(false);
    expect(line.priceSource).toBe("unresolved_units");
    expect(line.baseValue).toBe(0);
    expect(line.nativeValue).toBe(0);
    // The raw quote is retained so an operator can see what was on the wire.
    expect(line.nativeQuote).toBe(42);
  });

  it("does not let the cost-basis fallback rescue an unresolvable row", () => {
    // No market price AND unknown units: cost basis is in unknown units too,
    // so it must not be promoted into the total.
    const result = computeValuation({
      holdings: [{ symbol: "MYSTERY123", quantity: 100, avg_cost: 900 }],
      wallet: {},
      baseCcy: "GBP",
      price: () => null,
      fx,
    });
    expect(result.holdingsValue).toBe(0);
    expect(result.provenance.warnings.some((w) => w.code === "cost_basis_fallback")).toBe(false);
    expect(result.provenance.warnings.some((w) => w.code === "unresolved_quote_units")).toBe(true);
  });

  it("resolvable rows are unaffected — no new degradation, no withheld value", () => {
    const result = computeValuation({
      holdings: [
        { symbol: "MKS:xlon", quantity: 500, instrument_ccy: "GBX", avg_cost: 400 },
        { symbol: "VUKE.L", quantity: 50, instrument_ccy: "GBP", avg_cost: 46 },
        { symbol: "AAPL:xnas", quantity: 10, instrument_ccy: "USD", avg_cost: 200 },
      ],
      wallet: { GBP: 1_300.27 },
      baseCcy: "GBP",
      price: (s) => {
        const k = s.toUpperCase();
        if (k === "MKS.L") return 420;
        if (k === "VUKE.L") return 48.3;
        if (k === "AAPL") return 210;
        return null;
      },
      fx,
    });

    expect(result.provenance.degraded).toBe(false);
    expect(result.provenance.lines.every((l) => l.unitsResolved)).toBe(true);
    // 2100 + 2415 + (2100 USD × 0.8 = 1680) = 6195
    expect(result.holdingsValue).toBeCloseTo(6_195, 2);
  });
});

describe("UI: unresolvable units render as unknown, never as a percentage", () => {
  const holdings = [
    {
      id: "1",
      symbol: "MKS:xlon",
      quantity: 500,
      avg_cost: 4,
      instrument_ccy: "GBX",
      opened_at: "2026-07-01",
    },
    {
      id: "2",
      symbol: "MYSTERY123",
      quantity: 1000,
      avg_cost: 250,
      instrument_ccy: null,
      opened_at: "2026-07-01",
    },
  ];

  const series = {
    "MKS:xlon": {
      closes: [4, 4.2],
      dates: ["2026-07-31", "2026-08-01"],
      currentPrice: 4.2,
      // Fractions: the card renders these as percentages.
      pctChangeSincePurchase: 0.05,
      valueChangeSincePurchase: 100,
      opened_at: "2026-07-01",
      hourly: [],
    },
    MYSTERY123: {
      closes: [250, 275],
      dates: ["2026-07-31", "2026-08-01"],
      currentPrice: 275,
      // A number the pipeline would happily have rendered — it must not appear.
      pctChangeSincePurchase: 0.1,
      valueChangeSincePurchase: 25_000,
      opened_at: "2026-07-01",
      hourly: [],
    },
  };

  const render = () =>
    renderWithQuery(
      <LiveHoldingsCard
        portfolioId="pf-1"
        holdings={holdings as never}
        series={series as never}
        cash={1_000}
        totalValue={3_100}
        invested={2_100}
        currency="GBP"
        mode="paper"
      />,
    );

  it("labels the unresolved row and hides its money value", () => {
    const html = render();
    expect(html).toContain("MYSTERY123");
    expect(html).toContain("units unknown");
    expect(html).toContain("units unresolved");
  });

  it("never renders the unresolved row's percentage change", () => {
    const html = render();
    // The would-be percentage (+10.0%) and value change must be absent.
    expect(html).not.toMatch(/\+?10\.00\s*%/);
    expect(html).not.toContain("25,000");
    // The resolvable neighbour still shows its correct +5%.
    expect(html).toMatch(/\+5\.00\s*%/);
  });

  it("does not let unknown units inflate portfolio weights", () => {
    const html = render();
    // 1000 × 275 = 275,000 would have swamped every other row's weight.
    expect(html).not.toContain("275,000");
    expect(html).not.toContain("GBP 275,000.00");
    // MKS keeps a sane, non-zero weight of the portfolio.
    expect(html).toMatch(/\d+\.\d% of portfolio/);
  });
});
