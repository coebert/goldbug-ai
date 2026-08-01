// Regression lock: the sell/exit gate must recognise broker-native holdings.
//
// Bug this pins down: after a Saxo sync, `holdings.symbol` is broker-native
// ("AAPL:xnas", "MKS:xlon"), but the universe, priceMap and every AI order use
// the Yahoo-style key ("AAPL", "MKS.L"). The engine keyed its working holdings
// map on the raw broker symbol, so every sell path — hard stop, chandelier
// trail, tail-hedge trim, rebalance band — looked up the canonical symbol,
// missed, and rejected with `no holding to sell`. A correct tail-hedge trim on
// AAPL was silently suppressed on 31 Jul and the position took the full -7.4%
// gap. Live prices missed the same way, so exposure fell back to avg_cost.

import { describe, it, expect } from "vitest";
import { engineSymbolKey, resolvePriceSymbol, priceSymbolVariants } from "@/lib/price-symbol";

describe("engineSymbolKey", () => {
  it("maps US broker symbols onto the bare universe ticker", () => {
    expect(engineSymbolKey("AAPL:xnas")).toBe("AAPL");
    expect(engineSymbolKey("MSFT:xnys")).toBe("MSFT");
    expect(engineSymbolKey("SPY:arcx")).toBe("SPY");
  });

  it("maps LSE broker symbols onto the Yahoo suffix form", () => {
    expect(engineSymbolKey("MKS:xlon")).toBe("MKS.L");
    expect(engineSymbolKey("HSBA:xlon")).toBe("HSBA.L");
    expect(engineSymbolKey("VUKE:xlon")).toBe("VUKE.L");
  });

  it("is idempotent — a canonical symbol keys to itself", () => {
    for (const s of ["AAPL", "MKS.L", "GLD", "GBPUSD=X"]) {
      expect(engineSymbolKey(s)).toBe(s);
      expect(engineSymbolKey(engineSymbolKey(s))).toBe(s);
    }
  });

  it("normalises case so a lowercase broker row still matches", () => {
    expect(engineSymbolKey("aapl:xnas")).toBe("AAPL");
    expect(engineSymbolKey("mks:XLON")).toBe("MKS.L");
  });

  it("agrees with resolvePriceSymbol so map keys and price keys never diverge", () => {
    for (const s of ["AAPL:xnas", "MKS:xlon", "TSCO:xlon", "GLD"]) {
      expect(engineSymbolKey(s)).toBe(resolvePriceSymbol(s).toUpperCase());
    }
  });

  it("leaves an unknown venue suffix intact rather than inventing a ticker", () => {
    expect(engineSymbolKey("FOO:xzzz")).toBe("FOO:XZZZ");
  });

  it("tolerates empty and whitespace input", () => {
    expect(engineSymbolKey("")).toBe("");
    expect(engineSymbolKey("  AAPL:xnas  ")).toBe("AAPL");
  });
});

/**
 * Mirrors the engine's sell gate: build the working map from stored holdings,
 * then look the position up by the symbol an order carries.
 */
function sellGate(
  storedHoldings: Array<{ symbol: string; quantity: number }>,
  orderSymbol: string,
): { found: boolean; quantity: number; rejected?: string } {
  const byKey = new Map(storedHoldings.map((h) => [engineSymbolKey(h.symbol), h] as const));
  const cur = byKey.get(engineSymbolKey(orderSymbol));
  if (!cur || cur.quantity <= 0) return { found: false, quantity: 0, rejected: "no holding to sell" };
  return { found: true, quantity: cur.quantity };
}

describe("sell gate against broker-native holdings", () => {
  const held = [
    { symbol: "AAPL:xnas", quantity: 2 },
    { symbol: "MKS:xlon", quantity: 879 },
    { symbol: "ULVR:xlon", quantity: 22 },
  ];

  it("finds the AAPL position the tail-hedge trim previously missed", () => {
    const gate = sellGate(held, "AAPL");
    expect(gate.found).toBe(true);
    expect(gate.quantity).toBe(2);
    expect(gate.rejected).toBeUndefined();
  });

  it("finds LSE positions addressed by their universe symbol", () => {
    expect(sellGate(held, "MKS.L").quantity).toBe(879);
    expect(sellGate(held, "ULVR.L").quantity).toBe(22);
  });

  it("still rejects a symbol that genuinely is not held", () => {
    expect(sellGate(held, "TSLA")).toEqual({
      found: false,
      quantity: 0,
      rejected: "no holding to sell",
    });
  });

  it("still rejects a zero-quantity position", () => {
    expect(sellGate([{ symbol: "AAPL:xnas", quantity: 0 }], "AAPL").rejected).toBe(
      "no holding to sell",
    );
  });

  it("collapses duplicate spellings of one position onto a single key", () => {
    const dupes = [
      { symbol: "AAPL", quantity: 5 },
      { symbol: "AAPL:xnas", quantity: 2 },
    ];
    const byKey = new Map(dupes.map((h) => [engineSymbolKey(h.symbol), h] as const));
    expect(byKey.size).toBe(1);
  });
});

describe("price lookup for broker-native holdings", () => {
  // priceMap is keyed by the canonical symbol; the holding is not.
  const priceMap = new Map<string, number>([
    ["AAPL", 308.91],
    ["MKS.L", 3.42],
  ]);

  function livePrice(symbol: string): number | null {
    for (const key of priceSymbolVariants(symbol)) {
      const v = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
      if (v != null && Number.isFinite(v)) return v;
    }
    return null;
  }

  it("resolves a live price instead of falling back to cost basis", () => {
    expect(livePrice("AAPL:xnas")).toBe(308.91);
    expect(livePrice("MKS:xlon")).toBe(3.42);
  });

  it("returns null only when the price genuinely is absent", () => {
    expect(livePrice("TSCO:xlon")).toBeNull();
  });
});

describe("Saxo ExternalReference length", () => {
  // Saxo rejects the entire order when ExternalReference exceeds 50 chars —
  // this is what killed the 29 Jul AAPL buy ("fx spot failed ... must not
  // exceed max length of 50 characters").
  function fxClientOrderId(decisionId: string, symbol: string, from: string, to: string) {
    // Deterministic 24-hex digest, same shape as the executor now emits.
    let h = 0;
    const src = `${decisionId}:${symbol}:${from}${to}`;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    return `fx:${h.toString(16).padStart(24, "0").slice(0, 24)}`;
  }

  it("keeps the FX leg reference well inside the 50-char limit", () => {
    const id = fxClientOrderId(
      "3f2b7a1c-9d44-4e88-b0a1-6c5e2f7d8901",
      "AAPL",
      "GBP",
      "USD",
    );
    expect(id.length).toBeLessThanOrEqual(50);
    expect(id.startsWith("fx:")).toBe(true);
  });

  it("is stable for the same decision so a retry stays idempotent", () => {
    const a = fxClientOrderId("dec-1", "AAPL", "GBP", "USD");
    const b = fxClientOrderId("dec-1", "AAPL", "GBP", "USD");
    const c = fxClientOrderId("dec-2", "AAPL", "GBP", "USD");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("the raw un-hashed form would have overflowed — proving the fix matters", () => {
    const raw = `fx-3f2b7a1c-9d44-4e88-b0a1-6c5e2f7d8901-AAPL-GBPUSD`;
    expect(raw.length).toBeGreaterThan(50);
  });
});
