import { describe, it, expect } from "vitest";
import {
  closeOnOrBefore,
  rebuildLedgerFromFills,
  resolveFillPrice,
  type CloseLookup,
  type FillLite,
} from "@/lib/fills-ledger-rebuild";

const closes: CloseLookup = new Map([
  [
    "SGLN.L",
    [
      { date: "2026-07-27", close: 5940 },
      { date: "2026-07-28", close: 5879 },
    ],
  ],
  ["V", [{ date: "2026-07-27", close: 362.53 }]],
]);

function fill(p: Partial<FillLite> & { symbol: string }): FillLite {
  return {
    id: p.id ?? "f1",
    symbol: p.symbol,
    side: p.side ?? "buy",
    quantity: p.quantity ?? 1,
    fill_price: p.fill_price ?? 0,
    filled_at: p.filled_at ?? "2026-07-27T14:20:00Z",
  };
}

describe("resolveFillPrice", () => {
  it("falls back to the cached close when the broker gave no price", () => {
    expect(resolveFillPrice(fill({ symbol: "V", quantity: 234 }), closes)).toBeCloseTo(362.53, 6);
  });

  it("trusts the stored fill price as-is — it is already in base units", () => {
    // Both write paths resolve through `resolveFillRecord`, and the
    // fill-unit backfill re-normalised the history, so folding here would
    // divide correct pounds by 100 a second time.
    expect(resolveFillPrice(fill({ symbol: "SGLN.L", fill_price: 58.7231 }), closes)).toBeCloseTo(
      58.7231,
      6,
    );
  });

  it("folds the cached-close fallback from GBX to GBP", () => {
    expect(resolveFillPrice(fill({ symbol: "SGLN.L" }), closes)).toBeCloseTo(59.4, 6);
  });


  it("returns 0 when neither a fill price nor a cached close exists", () => {
    expect(resolveFillPrice(fill({ symbol: "JNJ" }), closes)).toBe(0);
  });

  it("uses the latest close on or before the fill date", () => {
    expect(closeOnOrBefore(closes, "SGLN.L", "2026-07-28")).toBe(5879);
    expect(closeOnOrBefore(closes, "SGLN.L", "2026-07-26")).toBeNull();
  });
});

describe("rebuildLedgerFromFills", () => {
  it("weights average cost across multiple buys and debits cash", () => {
    const ledger = rebuildLedgerFromFills([
      { ...fill({ symbol: "V", quantity: 100, filled_at: "2026-07-27T10:00:00Z" }), price: 10 },
      { ...fill({ symbol: "V", quantity: 100, filled_at: "2026-07-27T11:00:00Z" }), price: 20 },
    ]);
    expect(ledger.positions).toEqual([{ symbol: "V", quantity: 200, avgCost: 15 }]);
    expect(ledger.cashDelta).toBe(-3000);
  });

  it("reduces quantity on sells, credits cash, and drops flat positions", () => {
    const ledger = rebuildLedgerFromFills([
      { ...fill({ symbol: "V", quantity: 10, filled_at: "2026-07-27T10:00:00Z" }), price: 10 },
      {
        ...fill({ symbol: "V", side: "sell", quantity: 10, filled_at: "2026-07-27T12:00:00Z" }),
        price: 12,
      },
    ]);
    expect(ledger.positions).toEqual([]);
    expect(ledger.cashDelta).toBe(20);
  });

  it("ignores unpriced or zero-quantity fills", () => {
    const ledger = rebuildLedgerFromFills([
      { ...fill({ symbol: "V", quantity: 10 }), price: 0 },
      { ...fill({ symbol: "JNJ", quantity: 0 }), price: 5 },
    ]);
    expect(ledger.positions).toEqual([]);
    expect(ledger.cashDelta).toBe(0);
  });

  it("replays fills in chronological order regardless of input order", () => {
    const late = { ...fill({ symbol: "V", quantity: 10, filled_at: "2026-07-28T10:00:00Z" }), price: 20 };
    const early = { ...fill({ symbol: "V", quantity: 10, filled_at: "2026-07-27T10:00:00Z" }), price: 10 };
    expect(rebuildLedgerFromFills([late, early])).toEqual(
      rebuildLedgerFromFills([early, late]),
    );
  });
});
