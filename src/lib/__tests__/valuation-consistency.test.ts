import { describe, expect, it } from "vitest";
import { auditPriceUnits } from "../price-unit-audit";
import { checkValuationConsistency, suspectRowsFor } from "../valuation-consistency";

const snap = (date: string, total: number, cash = 0, holdings = total - cash) => ({
  snapshot_date: date,
  total_value: total,
  holdings_value: holdings,
  cash,
});

function penceAudit(date: string) {
  return auditPriceUnits({
    portfolioId: "p1",
    date,
    baseCcy: "GBP",
    holdings: [
      { symbol: "ISF:xlon", quantity: 100, avg_cost: 8 },
      { symbol: "VUKE.L", quantity: 5, avg_cost: 35 },
    ],
    prices: new Map([
      ["ISF.L", new Map([[date, 800]])],
      ["VUKE.L", new Map([[date, 35]])],
    ]),
  });
}

describe("checkValuationConsistency", () => {
  it("passes a normal series", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 10000), snap("2026-07-02", 10250), snap("2026-07-03", 9800)],
    });
    expect(report.jumps).toEqual([]);
    expect(report.worst).toBeNull();
    expect(report.daysChecked).toBe(2);
  });

  it("flags a 100x upward jump and names the pence quote", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 975), snap("2026-07-02", 97500)],
      audits: { "2026-07-02": penceAudit("2026-07-02") },
    });
    expect(report.jumps).toHaveLength(1);
    const jump = report.jumps[0]!;
    expect(jump.ratio).toBe(100);
    expect(jump.direction).toBe("up");
    expect(jump.suspected_source).toBe("gbx_pence_fold");
    expect(jump.suspect_symbols[0]!.symbol).toBe("ISF:xlon");
    expect(jump.suspect_symbols[0]!.quote_currency).toBe("GBX");
    expect(jump.explanation).toContain("pence (GBX)");
  });

  it("flags a downward collapse too", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 97500), snap("2026-07-02", 975)],
      audits: { "2026-07-02": penceAudit("2026-07-02") },
    });
    const jump = report.jumps[0]!;
    expect(jump.direction).toBe("down");
    expect(jump.ratio).toBe(0.01);
    expect(jump.suspected_source).toBe("gbx_pence_fold");
  });

  it("attributes a jump to a missing FX rate when one is absent", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: "2026-07-02",
      baseCcy: "EUR",
      holdings: [{ symbol: "AAPL", quantity: 100, avg_cost: 100, instrument_ccy: "USD" }],
      prices: new Map([["AAPL", new Map([["2026-07-02", 400]])]]),
    });
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 10000), snap("2026-07-02", 40000)],
      audits: { "2026-07-02": audit },
      baseCcy: "EUR",
    });
    const jump = report.jumps[0]!;
    expect(jump.suspected_source).toBe("missing_fx_rate");
    expect(jump.suspect_symbols[0]!.reason).toContain("USD/EUR");
  });

  it("does not blame pricing when cash explains the move", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [
        snap("2026-07-01", 1000, 0, 1000),
        snap("2026-07-02", 11000, 10000, 1000),
      ],
    });
    expect(report.jumps[0]!.suspected_source).toBe("cash_movement");
    expect(report.jumps[0]!.suspect_symbols).toEqual([]);
  });

  it("ignores funding from a zero starting value", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 0), snap("2026-07-02", 10000, 10000, 0)],
    });
    expect(report.jumps).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const snapshots = [snap("2026-07-01", 1000), snap("2026-07-02", 2500)];
    expect(checkValuationConsistency({ portfolioId: "p1", snapshots }).jumps).toEqual([]);
    expect(
      checkValuationConsistency({ portfolioId: "p1", snapshots, jumpFactor: 2 }).jumps,
    ).toHaveLength(1);
  });

  it("reports the worst jump first regardless of direction or order", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [
        snap("2026-07-03", 400),
        snap("2026-07-01", 100),
        snap("2026-07-02", 10000),
      ],
    });
    expect(report.jumps.map((j) => j.date)).toEqual(["2026-07-02", "2026-07-03"]);
    expect(report.worst!.date).toBe("2026-07-02");
    expect(report.worst!.ratio).toBe(100);
  });

  it("still classifies a 100x jump with no audit available", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 100), snap("2026-07-02", 10000)],
    });
    expect(report.jumps[0]!.suspected_source).toBe("gbx_pence_fold");
    expect(report.jumps[0]!.suspect_symbols).toEqual([]);
  });

  it("is idempotent for repeated runs", () => {
    const args = {
      portfolioId: "p1",
      snapshots: [snap("2026-07-01", 975), snap("2026-07-02", 97500)],
      audits: { "2026-07-02": penceAudit("2026-07-02") },
    };
    expect(checkValuationConsistency(args)).toEqual(checkValuationConsistency(args));
  });
});

describe("suspectRowsFor", () => {
  it("ranks pence legs by weight", () => {
    const { rows, source } = suspectRowsFor(penceAudit("2026-07-02"), 100);
    expect(source).toBe("gbx_pence_fold");
    expect(rows[0]!.symbol).toBe("ISF:xlon");
  });

  it("falls back to unknown with no audit and a modest ratio", () => {
    expect(suspectRowsFor(null, 4)).toEqual({ rows: [], source: "unknown" });
  });
});
