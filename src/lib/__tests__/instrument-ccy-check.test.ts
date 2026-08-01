import { describe, expect, it } from "vitest";
import { checkInstrumentCurrencies } from "../instrument-ccy-check";

const q = (close: number, date = "2026-07-31") => ({ close, date });

function run(args: Parameters<typeof checkInstrumentCurrencies>[0]) {
  return checkInstrumentCurrencies(args);
}

describe("instrument currency / price-unit check", () => {
  it("passes clean holdings with no findings", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [
        { symbol: "JNJ:xnys", quantity: 10, avg_cost: 150, instrument_ccy: "USD" },
        { symbol: "ISF.L", quantity: 5, avg_cost: 10.6, instrument_ccy: "GBP" },
      ],
      quotes: new Map([
        ["JNJ:xnys", q(155)],
        ["ISF.L", q(1062)],
      ]),
      fx: new Map([
        ["USD", 0.78],
        ["GBP", 1],
      ]),
    });
    expect(r.findings).toHaveLength(0);
    expect(r.checked).toBe(2);
    expect(r.summary).toContain("agree on currency");
  });

  it("flags a US holding tagged with the base currency as skipping FX", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "JNJ:xnys", quantity: 10, avg_cost: 150, instrument_ccy: "GBP" }],
      quotes: new Map([["JNJ:xnys", q(155)]]),
      fx: new Map([
        ["USD", 0.78],
        ["GBP", 1],
      ]),
    });
    const f = r.findings[0];
    expect(f.symbol).toBe("JNJ:xnys");
    expect(f.declared_ccy).toBe("GBP");
    expect(f.venue_ccy).toBe("USD");
    expect(f.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["venue_mismatch", "fx_conversion_skipped"]),
    );
    expect(f.severity).toBe("high");
    // Declared path overstates the leg because no FX is applied.
    expect(f.value_base_declared).toBeGreaterThan(f.value_base!);
  });

  it("flags a venue mismatch that does not skip FX at medium severity", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "EUR",
      holdings: [{ symbol: "JNJ:xnys", quantity: 1, avg_cost: 150, instrument_ccy: "GBP" }],
      quotes: new Map([["JNJ:xnys", q(155)]]),
      fx: new Map([
        ["USD", 0.92],
        ["GBP", 1.16],
      ]),
    });
    expect(r.findings[0].severity).toBe("medium");
    expect(r.findings[0].issues.map((i) => i.code)).toEqual(["venue_mismatch"]);
  });

  it("flags GBX stored as a currency", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "HSBA.L", quantity: 100, avg_cost: 8.9, instrument_ccy: "GBX" }],
      quotes: new Map([["HSBA.L", q(905)]]),
      fx: new Map([["GBP", 1]]),
    });
    expect(r.findings[0].issues[0].code).toBe("quote_unit_as_currency");
  });

  it("flags a missing currency", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "VTI", quantity: 3, avg_cost: 250, instrument_ccy: null }],
      quotes: new Map([["VTI", q(255)]]),
      fx: new Map([["USD", 0.78]]),
    });
    expect(r.findings[0].issues[0].code).toBe("missing_currency");
  });

  it("detects an unfolded pence quote against average cost (divisor mismatch)", () => {
    // Row treated as pounds (US-style symbol) but the feed is quoting pence.
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "SGLN", quantity: 10, avg_cost: 76.9, instrument_ccy: "USD" }],
      quotes: new Map([["SGLN", q(7690)]]),
      fx: new Map([
        ["USD", 0.78],
        ["GBP", 1],
      ]),
    });
    const f = r.findings[0];
    expect(f.expected_divisor).toBe(1);
    expect(f.implied_divisor).toBe(100);
    expect(f.issues.some((i) => i.code === "divisor_mismatch")).toBe(true);
    expect(f.severity).toBe("high");
  });

  it("detects an over-folded pound quote on an LSE symbol", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "ISF.L", quantity: 10, avg_cost: 1062, instrument_ccy: "GBP" }],
      quotes: new Map([["ISF.L", q(1062)]]),
      fx: new Map([["GBP", 1]]),
    });
    const f = r.findings[0];
    expect(f.expected_divisor).toBe(100);
    expect(f.implied_divisor).toBe(1);
    expect(f.issues.some((i) => i.code === "divisor_mismatch")).toBe(true);
  });

  it("does not flag ordinary drift between quote and average cost", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "AAPL:xnas", quantity: 4, avg_cost: 200, instrument_ccy: "USD" }],
      quotes: new Map([["AAPL:xnas", q(309)]]),
      fx: new Map([["USD", 0.78]]),
    });
    expect(r.findings).toHaveLength(0);
  });

  it("flags a snapshot that only reconciles at 100x", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "AAPL:xnas", quantity: 100, avg_cost: 200, instrument_ccy: "USD" }],
      quotes: new Map([["AAPL:xnas", q(200)]]),
      fx: new Map([["USD", 1]]),
      snapshot: { date: "2026-07-31", holdings_value: 200 },
    });
    expect(r.snapshot_ratio).toBe(100);
    expect(r.findings[0].issues.some((i) => i.code === "snapshot_implies_other_unit")).toBe(true);
    expect(r.snapshot).toEqual({ date: "2026-07-31", holdings_value: 200 });
  });

  it("leaves a matching snapshot alone", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "AAPL:xnas", quantity: 100, avg_cost: 200, instrument_ccy: "USD" }],
      quotes: new Map([["AAPL:xnas", q(200)]]),
      fx: new Map([["USD", 1]]),
      snapshot: { date: "2026-07-31", holdings_value: 20_000 },
    });
    expect(r.snapshot_ratio).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it("ignores closed positions and sorts worst-first", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [
        { symbol: "V:xnys", quantity: 0, avg_cost: 300, instrument_ccy: "GBP" },
        { symbol: "JPM", quantity: 1, avg_cost: 250, instrument_ccy: null },
        { symbol: "JNJ:xnys", quantity: 1, avg_cost: 150, instrument_ccy: "GBP" },
      ],
      quotes: new Map([
        ["JPM", q(255)],
        ["JNJ:xnys", q(155)],
      ]),
      fx: new Map([
        ["USD", 0.78],
        ["GBP", 1],
      ]),
    });
    expect(r.checked).toBe(2);
    expect(r.findings.map((f) => f.symbol)).toEqual(["JNJ:xnys", "JPM"]);
    expect(r.findings[0].severity).toBe("high");
  });

  it("reports no value when the FX rate for the venue currency is unknown", () => {
    const r = run({
      portfolioId: "p1",
      baseCcy: "GBP",
      holdings: [{ symbol: "7203:xtks", quantity: 10, avg_cost: 2500, instrument_ccy: "GBP" }],
      quotes: new Map([["7203:xtks", q(2600)]]),
      fx: new Map([["GBP", 1]]),
    });
    const f = r.findings[0];
    expect(f.venue_ccy).toBe("JPY");
    expect(f.value_base).toBeNull();
    expect(f.value_base_declared).not.toBeNull();
  });
});
