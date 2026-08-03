import { describe, expect, it } from "vitest";
import {
  buildHedgeFallbackSummary,
  parseHedgeFallbackNote,
  type HedgeRunRecord,
} from "../hedge-fallback-analytics";

const NOTE =
  " [hedge fallback: SGLN.L unusable (broker block (suitability/permissions)) → SGLD.L]";

function rec(over: Partial<HedgeRunRecord> = {}): HedgeRunRecord {
  return {
    decisionId: "d1",
    runDate: "2026-08-01",
    portfolioId: "p1",
    portfolioName: "Real money",
    currency: "GBP",
    symbol: "SGLD.L",
    side: "buy",
    applied: true,
    reason: `tail_hedge buy → target 5.00% NAV (vol spike)${NOTE}`,
    appliedNotional: 0,
    targetNotional: 1000,
    observedNotional: 0,
    slippageKind: "unfilled",
    deferralReason: null,
    ...over,
  };
}

describe("parseHedgeFallbackNote", () => {
  it("extracts the from/to pair and reason", () => {
    expect(parseHedgeFallbackNote(NOTE)).toEqual({
      from: "SGLN.L",
      to: "SGLD.L",
      why: "broker block (suitability/permissions",
    });
  });

  it("supports ascii arrows", () => {
    const p = parseHedgeFallbackNote("[hedge fallback: GLD unusable (no live price) -> IAU]");
    expect(p?.from).toBe("GLD");
    expect(p?.to).toBe("IAU");
  });

  it("returns null when there is no substitution", () => {
    expect(parseHedgeFallbackNote("tail_hedge buy → target 5% NAV")).toBeNull();
    expect(parseHedgeFallbackNote(null)).toBeNull();
  });
});

describe("buildHedgeFallbackSummary", () => {
  it("ignores runs with no fallback note", () => {
    const s = buildHedgeFallbackSummary([rec({ reason: "tail_hedge hold" })]);
    expect(s.totals.events).toBe(0);
    expect(s.byPair).toHaveLength(0);
  });

  it("marks the hedge established when a later run observes the target", () => {
    const s = buildHedgeFallbackSummary([
      rec({ decisionId: "d1", runDate: "2026-08-01" }),
      rec({
        decisionId: "d2",
        runDate: "2026-08-02",
        reason: "tail_hedge hold",
        observedNotional: 950,
      }),
    ]);
    expect(s.totals.events).toBe(1);
    expect(s.events[0]!.outcome).toBe("established");
    expect(s.events[0]!.succeededOn).toBe("2026-08-02");
    expect(s.totals.successRate).toBe(1);
  });

  it("marks failure when later runs never show the hedge", () => {
    const s = buildHedgeFallbackSummary([
      rec({ decisionId: "d1", runDate: "2026-08-01" }),
      rec({ decisionId: "d2", runDate: "2026-08-02", reason: "tail_hedge hold" }),
    ]);
    expect(s.events[0]!.outcome).toBe("failed");
    expect(s.totals.successRate).toBe(0);
  });

  it("keeps the latest run pending until a follow-up run exists", () => {
    const s = buildHedgeFallbackSummary([rec()]);
    expect(s.events[0]!.outcome).toBe("pending");
    expect(s.totals.successRate).toBeNull();
  });

  it("counts partial when some hedge is on but below the ratio", () => {
    const s = buildHedgeFallbackSummary([
      rec({ observedNotional: 300 }),
      rec({ decisionId: "d2", runDate: "2026-08-02", reason: "hold", observedNotional: 300 }),
    ]);
    expect(s.events[0]!.outcome).toBe("partial");
  });

  it("treats an applied unwind as a success regardless of target", () => {
    const s = buildHedgeFallbackSummary([
      rec({ side: "sell", applied: true, targetNotional: 0, appliedNotional: 400 }),
    ]);
    expect(s.events[0]!.outcome).toBe("established");
  });

  it("groups by currency and instrument pair", () => {
    const s = buildHedgeFallbackSummary([
      rec({ portfolioId: "p1", currency: "GBP", observedNotional: 1000 }),
      rec({
        decisionId: "d3",
        portfolioId: "p2",
        currency: "USD",
        observedNotional: 1000,
        reason: `tail_hedge buy${" [hedge fallback: GLD unusable (no live price) → IAU]"}`,
      }),
    ]);
    expect(s.byCurrency.map((g) => g.label).sort()).toEqual(["GBP", "USD"]);
    expect(s.byPair.map((g) => g.label).sort()).toEqual(["GLD→IAU", "SGLN.L→SGLD.L"]);
    expect(s.totals.distinctPairs).toBe(2);
    expect(s.byPair.every((g) => g.successRate === 1)).toBe(true);
  });

  it("scopes the forward-looking check to the same portfolio", () => {
    const s = buildHedgeFallbackSummary([
      rec({ portfolioId: "p1", runDate: "2026-08-01" }),
      rec({
        decisionId: "dx",
        portfolioId: "p2",
        runDate: "2026-08-02",
        reason: "hold",
        observedNotional: 5000,
      }),
      rec({ decisionId: "d2", portfolioId: "p1", runDate: "2026-08-03", reason: "hold" }),
    ]);
    const p1 = s.events.find((e) => e.portfolioId === "p1")!;
    expect(p1.outcome).toBe("failed");
  });
});
