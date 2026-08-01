import { describe, expect, it } from "vitest";
import type { InstrumentCcyFinding } from "../instrument-ccy-check";
import { planInstrumentCcyFixes } from "../instrument-ccy-fix";

const finding = (
  symbol: string,
  declared: string | null,
  codes: InstrumentCcyFinding["issues"][number]["code"][],
): InstrumentCcyFinding => ({
  symbol,
  quantity: 10,
  declared_ccy: declared,
  venue_ccy: "USD",
  pence_quoted: false,
  expected_divisor: 1,
  implied_divisor: 1,
  recent_quote: 100,
  recent_quote_date: "2026-08-01",
  avg_cost: 95,
  quote_cost_ratio: 1.05,
  value_base: 780,
  value_base_declared: 1000,
  issues: codes.map((code) => ({ code, severity: "high" as const, message: code })),
  severity: "high",
});

describe("planInstrumentCcyFixes", () => {
  it("corrects a US venue mis-tagged with the base currency", () => {
    const plan = planInstrumentCcyFixes([
      finding("JNJ:xnys", "GBP", ["venue_mismatch", "fx_conversion_skipped"]),
    ]);
    expect(plan.fixes).toHaveLength(1);
    expect(plan.fixes[0]).toMatchObject({ symbol: "JNJ:xnys", from_ccy: "GBP", to_ccy: "USD", source: "mic" });
    expect(plan.fixes[0].reason).toContain("skipped the FX conversion");
    expect(plan.skipped).toEqual([]);
  });

  it("handles suffix, pair and known-root symbols", () => {
    const plan = planInstrumentCcyFixes([
      finding("SAP.DE", "GBP", ["venue_mismatch"]),
      finding("BTC-USD", "GBP", ["venue_mismatch"]),
      finding("VTI", "GBP", ["venue_mismatch", "fx_conversion_skipped"]),
      finding("ISF.L", "GBX", ["quote_unit_as_currency"]),
    ]);
    expect(plan.fixes.map((f) => [f.symbol, f.to_ccy, f.source])).toEqual([
      ["SAP.DE", "EUR", "suffix"],
      ["BTC-USD", "USD", "pair"],
      ["VTI", "USD", "known_root"],
      ["ISF.L", "GBP", "suffix"],
    ]);
  });

  it("fills in a missing currency tag", () => {
    const plan = planInstrumentCcyFixes([finding("7203.T", null, ["missing_currency"])]);
    expect(plan.fixes[0]).toMatchObject({ from_ccy: null, to_ccy: "JPY" });
    expect(plan.fixes[0].reason).toContain("no currency tag");
  });

  it("never touches a holding with an ambiguous divisor mismatch", () => {
    const plan = planInstrumentCcyFixes([
      finding("BARC.L", "GBP", ["divisor_mismatch"]),
      finding("VOD.L", "GBP", ["venue_mismatch", "divisor_mismatch"]),
    ]);
    expect(plan.fixes).toEqual([]);
    expect(plan.skipped.map((s) => s.symbol)).toEqual(["BARC.L", "VOD.L"]);
    expect(plan.skipped[0].reason).toContain("ambiguous");
  });

  it("skips symbols with no venue marker at all", () => {
    const plan = planInstrumentCcyFixes([finding("WEIRDCO", "GBP", ["venue_mismatch"])]);
    expect(plan.fixes).toEqual([]);
    expect(plan.skipped[0].reason).toContain("cannot be inferred");
  });

  it("skips findings a re-tag would not fix", () => {
    const plan = planInstrumentCcyFixes([
      finding("JNJ:xnys", "USD", ["snapshot_implies_other_unit"]),
    ]);
    expect(plan.fixes).toEqual([]);
    expect(plan.skipped[0].reason).toContain("would not fix");
  });

  it("skips a row already carrying the venue currency", () => {
    const plan = planInstrumentCcyFixes([finding("JNJ:xnys", "USD", ["venue_mismatch"])]);
    expect(plan.fixes).toEqual([]);
    expect(plan.skipped[0].reason).toBe("Already tagged USD.");
  });

  it("summarises mixed plans and is idempotent once applied", () => {
    const mixed = [
      finding("JNJ:xnys", "GBP", ["venue_mismatch", "fx_conversion_skipped"]),
      finding("BARC.L", "GBP", ["divisor_mismatch"]),
    ];
    const plan = planInstrumentCcyFixes(mixed);
    expect(plan.summary).toBe("1 holding can be re-tagged automatically; 1 need a manual decision.");

    const afterApply = planInstrumentCcyFixes([
      finding("JNJ:xnys", "USD", ["venue_mismatch"]),
      finding("BARC.L", "GBP", ["divisor_mismatch"]),
    ]);
    expect(afterApply.fixes).toEqual([]);
  });

  it("returns nothing for an empty finding list", () => {
    expect(planInstrumentCcyFixes([])).toEqual({ fixes: [], skipped: [], summary: "Nothing to correct." });
  });
});
