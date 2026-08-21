import { describe, it, expect } from "vitest";
import {
  deriveAutoAssumptions,
  describeAutoAssumptions,
  MIN_FEE_TICKETS,
  MIN_SLIPPAGE_FILLS,
} from "@/lib/backtest/auto-assumptions";
import { ASSUMPTION_PRESETS } from "@/lib/backtest/execution-assumptions";

const spreads = (bps: number[]) =>
  bps.map((v, i) => ({
    symbol: `S${i}`,
    fullSpreadBps: v,
    sampleBars: 250,
    source: "corwin_schultz",
  }));

const fees = (n: number, invoiced: number, modelled: number) =>
  Array.from({ length: n }, () => ({
    notional: 1_000,
    invoicedCommission: invoiced,
    modelledCommission: modelled,
    invoicedTax: 5,
    modelledStamp: 5,
  }));

describe("deriveAutoAssumptions", () => {
  it("falls back to the realistic preset with no evidence", () => {
    const r = deriveAutoAssumptions();
    expect(r.assumptions).toEqual(ASSUMPTION_PRESETS.realistic);
    expect(r.derivedFields).toHaveLength(0);
    expect(r.summary).toContain("realistic");
  });

  it("derives the median spread and per-symbol overrides", () => {
    const r = deriveAutoAssumptions({ spreads: spreads([8, 12, 20, 40]) });
    expect(r.assumptions.spreadBps).toBe(16);
    expect(r.assumptions.spreadBpsBySymbol?.["S3"]).toBe(40);
    expect(r.derivedFields).toContain("spreadBps");
  });

  it("ignores symbols with too few bars", () => {
    const r = deriveAutoAssumptions({
      spreads: [{ symbol: "A", fullSpreadBps: 9, sampleBars: 10 }],
    });
    expect(r.assumptions.spreadBps).toBe(ASSUMPTION_PRESETS.realistic.spreadBps);
  });

  it("calibrates commission against invoiced fees", () => {
    const r = deriveAutoAssumptions({ fees: fees(MIN_FEE_TICKETS, 6, 4) });
    expect(r.assumptions.commissionMult).toBe(1.5);
    expect(r.assumptions.stampMult).toBe(1);
  });

  it("clamps absurd fee ratios", () => {
    const r = deriveAutoAssumptions({ fees: fees(MIN_FEE_TICKETS, 400, 4) });
    expect(r.assumptions.commissionMult).toBe(2);
  });

  it("nets the half-spread out of realised slippage and never goes negative", () => {
    const slippage = Array.from({ length: MIN_SLIPPAGE_FILLS }, () => ({
      symbol: "A",
      side: "buy" as const,
      referencePrice: 100,
      // 20bps adverse, against a 14bps preset spread (7bps half) => 13bps.
      fillPrice: 100.2,
    }));
    const r = deriveAutoAssumptions({ slippage });
    expect(r.assumptions.slippageBps).toBe(13);

    const favourable = slippage.map((s) => ({ ...s, fillPrice: 99.5 }));
    expect(deriveAutoAssumptions({ slippage: favourable }).assumptions.slippageBps).toBe(0);
  });

  it("treats a sell filled above the reference as favourable", () => {
    const slippage = Array.from({ length: MIN_SLIPPAGE_FILLS }, () => ({
      symbol: "A",
      side: "sell" as const,
      referencePrice: 100,
      fillPrice: 99.9, // 10bps adverse for a sell
    }));
    expect(deriveAutoAssumptions({ slippage }).assumptions.slippageBps).toBe(3);
  });

  it("never produces NaN or negative assumptions from junk input", () => {
    const r = deriveAutoAssumptions({
      spreads: spreads([Number.NaN, -5, 12, 14, 16]),
      fees: fees(MIN_FEE_TICKETS, Number.NaN, 0),
      slippage: [
        { symbol: "A", side: "buy", referencePrice: 0, fillPrice: 10 },
        { symbol: "A", side: "buy", referencePrice: 10, fillPrice: Number.NaN },
      ],
    });
    for (const v of Object.values(r.assumptions)) {
      if (typeof v === "number") expect(Number.isFinite(v) && v >= 0).toBe(true);
    }
  });

  it("explains where each number came from", () => {
    const text = describeAutoAssumptions(deriveAutoAssumptions({ spreads: spreads([10, 12, 14]) }));
    expect(text).toContain("spreadBps");
    expect(text).toContain("derived");
    expect(text).toContain("fallback");
  });
});
