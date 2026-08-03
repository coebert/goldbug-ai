import { describe, it, expect } from "vitest";
import {
  netPositionsFromFills,
  reconcileHoldingsAgainstFills,
} from "@/lib/holdings-fills-recon";

const P = "portfolio-1";
const Q = "portfolio-2";

describe("netPositionsFromFills", () => {
  it("nets buys and sells on the canonical symbol key", () => {
    const net = netPositionsFromFills([
      { portfolioId: P, symbol: "V", side: "buy", quantity: 704 },
      { portfolioId: P, symbol: "V:xnys", side: "sell", quantity: 584 },
    ]);
    expect(net.get(`${P}\u0000V`)).toBe(120);
  });

  it("matches broker-native LSE symbols against Yahoo-style fills", () => {
    const net = netPositionsFromFills([
      { portfolioId: P, symbol: "MKS.L", side: "buy", quantity: 312 },
      { portfolioId: P, symbol: "MKS:xlon", side: "buy", quantity: 8 },
    ]);
    expect(net.get(`${P}\u0000MKS.L`)).toBe(320);
  });

  it("ignores zero and malformed quantities", () => {
    const net = netPositionsFromFills([
      { portfolioId: P, symbol: "V", side: "buy", quantity: 0 },
      { portfolioId: P, symbol: "V", side: "buy", quantity: null },
    ]);
    expect(net.size).toBe(0);
  });
});

describe("reconcileHoldingsAgainstFills", () => {
  it("reports no mismatches when the ledger replays to the holdings table", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [
        { portfolioId: P, symbol: "V", side: "buy", quantity: 704 },
        { portfolioId: P, symbol: "V", side: "sell", quantity: 584 },
      ],
      holdings: [{ portfolioId: P, symbol: "V:xnys", quantity: 120 }],
    });
    expect(r.mismatches).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("flags a phantom short as critical", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [
        { portfolioId: P, symbol: "SGLN.L", side: "buy", quantity: 445 },
        { portfolioId: P, symbol: "SGLN.L", side: "sell", quantity: 892 },
      ],
      holdings: [],
    });
    expect(r.rows[0]).toMatchObject({
      symbol: "SGLN.L",
      kind: "phantom_short",
      severity: "critical",
      fillsQuantity: -447,
    });
    expect(r.critical).toBe(1);
  });

  it("flags a holdings row with no fills behind it", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [],
      holdings: [{ portfolioId: P, symbol: "JNJ:xnys", quantity: 1587 }],
    });
    expect(r.rows[0]).toMatchObject({
      kind: "holding_without_fills",
      severity: "critical",
      holdingsQuantity: 1587,
      difference: -1587,
    });
  });

  it("flags fills with no holdings row", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [{ portfolioId: P, symbol: "TSCO.L", side: "buy", quantity: 119 }],
      holdings: [],
    });
    expect(r.rows[0]).toMatchObject({ kind: "fills_without_holding", severity: "critical" });
  });

  it("grades small quantity drift as a warning and large drift as critical", () => {
    const small = reconcileHoldingsAgainstFills({
      fills: [{ portfolioId: P, symbol: "ISF.L", side: "buy", quantity: 2266 }],
      holdings: [{ portfolioId: P, symbol: "ISF:xlon", quantity: 2265 }],
    });
    expect(small.rows[0]).toMatchObject({ kind: "quantity_mismatch", severity: "warn" });

    const large = reconcileHoldingsAgainstFills({
      fills: [{ portfolioId: P, symbol: "ISF.L", side: "buy", quantity: 2266 }],
      holdings: [{ portfolioId: P, symbol: "ISF:xlon", quantity: 1000 }],
    });
    expect(large.rows[0]).toMatchObject({ kind: "quantity_mismatch", severity: "critical" });
  });

  it("treats a fully closed position with no holdings row as clean", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [
        { portfolioId: P, symbol: "AAPL", side: "buy", quantity: 2 },
        { portfolioId: P, symbol: "AAPL", side: "sell", quantity: 2 },
      ],
      holdings: [],
    });
    expect(r.mismatches).toBe(0);
  });

  it("keeps portfolios independent and sorts critical breaks first", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [
        { portfolioId: P, symbol: "V", side: "buy", quantity: 100 },
        { portfolioId: Q, symbol: "V", side: "buy", quantity: 50 },
      ],
      holdings: [
        { portfolioId: P, symbol: "V", quantity: 99 },
        { portfolioId: Q, symbol: "V", quantity: 0 },
      ],
    });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].severity).toBe("critical");
    expect(r.rows[0].portfolioId).toBe(Q);
    expect(r.rows[1]).toMatchObject({ portfolioId: P, severity: "warn" });
  });

  it("can include matching rows for a full audit view", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [{ portfolioId: P, symbol: "V", side: "buy", quantity: 10 }],
      holdings: [{ portfolioId: P, symbol: "V", quantity: 10 }],
      includeMatches: true,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe("ok");
    expect(r.mismatches).toBe(0);
  });

  it("sums duplicate holdings rows for the same canonical symbol", () => {
    const r = reconcileHoldingsAgainstFills({
      fills: [{ portfolioId: P, symbol: "MKS.L", side: "buy", quantity: 320 }],
      holdings: [
        { portfolioId: P, symbol: "MKS.L", quantity: 300 },
        { portfolioId: P, symbol: "MKS:xlon", quantity: 20 },
      ],
    });
    expect(r.mismatches).toBe(0);
  });
});
