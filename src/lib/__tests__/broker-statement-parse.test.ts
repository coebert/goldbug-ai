import { describe, expect, it } from "vitest";
import {
  parseAmount,
  parseBrokerStatement,
  earliestChargeDate,
} from "@/lib/broker-statement-parse";

describe("parseAmount", () => {
  it("reads currency symbols, thousands and bracketed negatives as magnitudes", () => {
    expect(parseAmount("£1,234.56")).toBeCloseTo(1234.56);
    expect(parseAmount("(12.30)")).toBeCloseTo(12.3);
    expect(parseAmount("-4.10")).toBeCloseTo(4.1);
    expect(parseAmount("1.234,50")).toBeCloseTo(1234.5);
    expect(parseAmount("")).toBeNull();
  });
});

describe("parseBrokerStatement", () => {
  it("maps a Saxo-style CSV onto charges", () => {
    const csv = [
      "Trade Id,Order Id,Instrument,Buy/Sell,Quantity,Trade Date,Currency,Commission,Stamp Duty,Exchange Fee,Total Cost",
      "T1,O1,BP.L,Bought,154,21/08/2026,GBP,3.00,4.24,0.50,7.74",
      'T2,O2,"TSLA:xnas",Sold,2,04/09/2026,USD,1.00,0,0,1.00',
    ].join("\n");
    const res = parseBrokerStatement(csv);
    expect(res.charges).toHaveLength(2);
    const [a, b] = res.charges;
    expect(a?.brokerTradeId).toBe("T1");
    expect(a?.side).toBe("buy");
    expect(a?.tax).toBeCloseTo(4.24);
    expect(a?.total).toBeCloseTo(7.74);
    expect(b?.side).toBe("sell");
    expect(b?.currency).toBe("USD");
    expect(res.totalsByCurrency["GBP"]).toBeCloseTo(7.74);
  });

  it("skips rows with no money rather than booking a zero charge", () => {
    const csv = "Trade Id,Instrument,Commission\nT1,BP.L,0\nT2,VOD.L,2.50";
    const res = parseBrokerStatement(csv);
    expect(res.charges).toHaveLength(1);
    expect(res.rowsRead).toBe(2);
    expect(res.skipped[0]?.reason).toMatch(/no charge amount/);
  });

  it("keeps a declared total above its itemisation", () => {
    const csv = "Trade Id,Commission,Total\nT1,1.00,3.00";
    expect(parseBrokerStatement(csv).charges[0]?.total).toBeCloseTo(3);
  });

  it("synthesises a stable id when the statement has none", () => {
    const csv = "Instrument,Buy/Sell,Quantity,Trade Date,Commission\nBP.L,B,10,2026-08-21,3.00";
    const first = parseBrokerStatement(csv).charges[0]?.brokerTradeId;
    const second = parseBrokerStatement(csv).charges[0]?.brokerTradeId;
    expect(first).toBe(second);
    expect(first).toContain("BP.L");
  });

  it("handles semicolon and tab exports", () => {
    expect(parseBrokerStatement("Trade Id;Commission\nT1;2,50").charges[0]?.total).toBeCloseTo(2.5);
    expect(parseBrokerStatement("Trade Id\tCommission\nT1\t2.50").charges[0]?.total).toBeCloseTo(2.5);
  });

  it("refuses a file with no charge column", () => {
    const res = parseBrokerStatement("Instrument,Quantity\nBP.L,10");
    expect(res.charges).toHaveLength(0);
    expect(res.skipped[0]?.reason).toMatch(/no charge column/);
  });

  it("reports the earliest traded date for lookback sizing", () => {
    const csv = [
      "Trade Id,Trade Date,Commission",
      "T1,2026-08-21,3.00",
      "T2,2026-06-01,3.00",
    ].join("\n");
    expect(earliestChargeDate(parseBrokerStatement(csv).charges)?.slice(0, 10)).toBe("2026-06-01");
  });
});
