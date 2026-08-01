import { describe, expect, it } from "vitest";
import { auditPriceUnits } from "../price-unit-audit";
import { checkValuationConsistency, fxBreakdownFor } from "../valuation-consistency";

const snap = (date: string, total: number, cash = 0, holdings = total - cash) => ({
  snapshot_date: date,
  total_value: total,
  holdings_value: holdings,
  cash,
});

function mixedAudit(date: string, fx?: Map<string, number>) {
  return auditPriceUnits({
    portfolioId: "p1",
    date,
    baseCcy: "GBP",
    holdings: [
      { symbol: "AAPL", quantity: 100, avg_cost: 100, instrument_ccy: "USD" },
      { symbol: "ISF:xlon", quantity: 100, avg_cost: 8, instrument_ccy: "GBP" },
    ],
    prices: new Map([
      ["AAPL", new Map([[date, 200]])],
      ["ISF.L", new Map([[date, 800]])],
    ]),
    ...(fx ? { fxRates: fx } : {}),
  });
}

describe("FX conversion breakdown on flagged days", () => {
  it("reports a per-currency leg with rate, source and target currency", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 200), snap("2026-07-02", 21000)],
      audits: { "2026-07-02": mixedAudit("2026-07-02") },
      baseCcy: "GBP",
    });
    const jump = report.jumps[0]!;
    expect(jump.fx_breakdown.length).toBeGreaterThan(0);

    const usd = jump.fx_breakdown.find((l) => l.from_ccy === "USD")!;
    expect(usd.to_ccy).toBe("GBP");
    expect(usd.pair).toBe("USD/GBP");
    expect(usd.positions).toBe(1);
    expect(usd.value_from).toBeGreaterThan(0);
    expect(usd.weight).toBeGreaterThan(0);
    expect(usd.weight).toBeLessThanOrEqual(1);
  });

  it("marks an assumed 1.0 rate when no FX rate exists", () => {
    const legs = fxBreakdownFor(mixedAudit("2026-07-02"), "GBP");
    const usd = legs.find((l) => l.from_ccy === "USD")!;
    expect(usd.assumed).toBe(true);
    expect(usd.source).toBe("assumed_identity");
    expect(usd.rate).toBe(1);
  });

  it("weights sum to 1 across legs", () => {
    const legs = fxBreakdownFor(mixedAudit("2026-07-02"), "GBP");
    const sum = legs.reduce((acc, l) => acc + l.weight, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it("attaches a per-symbol FX conversion with a readable detail line", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 200), snap("2026-07-02", 21000)],
      audits: { "2026-07-02": mixedAudit("2026-07-02") },
      baseCcy: "GBP",
    });
    const suspect = report.jumps[0]!.suspect_symbols[0]!;
    expect(suspect.fx.to_ccy).toBe("GBP");
    expect(suspect.fx.pair).toContain("/GBP");
    expect(suspect.fx.detail).toContain("GBP");
    expect(typeof suspect.fx.rate).toBe("number");
  });

  it("returns no legs without an audit", () => {
    expect(fxBreakdownFor(null, "GBP")).toEqual([]);
  });

  it("returns no FX breakdown when cash explains the move", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 1000, 0, 1000), snap("2026-07-02", 11000, 10000, 1000)],
      audits: { "2026-07-02": mixedAudit("2026-07-02") },
    });
    expect(report.jumps[0]!.fx_breakdown).toEqual([]);
  });
});
