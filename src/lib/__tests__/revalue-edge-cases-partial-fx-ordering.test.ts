// Edge-case guards for `unbackedOpenings` / `cashOn`, the two functions that
// reconstruct historical cash. Each hole below produced the same symptom in
// production: a rolled-back balance that is quietly wrong, which surfaces one
// day later as an "implausible value jump" on the equity tile.
//
// Three families are covered:
//   1. Partial ledgers  — some, but not all, of a position's shares have fills.
//   2. Multi-currency   — a leg whose currency has no FX rate into the base.
//   3. Bad ordering     — missing, malformed, or post-anchor timestamps.
//
// The shared rule: when the ledger cannot explain a day, `cashOn` must return
// null so the caller keeps the stored balance. Guessing is what caused jumps.

import { describe, it, expect } from "vitest";
import {
  cashOn,
  parseDay,
  planHistoricalRevaluation,
  resolveRate,
  unbackedOpenings,
  type RevalueFill,
  type RevalueFundEvent,
  type RevalueHolding,
} from "@/lib/equity-snapshot-revalue";

const FX = new Map<string, number>([
  ["GBP", 1],
  ["USD", 0.79],
]);

const buy = (
  symbol: string,
  quantity: number,
  fill_price: number,
  filled_at: string,
): RevalueFill => ({ symbol, side: "buy", quantity, fill_price, filled_at });

const sell = (
  symbol: string,
  quantity: number,
  fill_price: number,
  filled_at: string,
): RevalueFill => ({ symbol, side: "sell", quantity, fill_price, filled_at });

describe("parseDay", () => {
  it("accepts ISO timestamps and dates, rejects everything else", () => {
    expect(parseDay("2026-07-28T13:00:59Z")).toBe("2026-07-28");
    expect(parseDay("2026-07-28")).toBe("2026-07-28");
    expect(parseDay(" 2026-07-28 ")).toBe("2026-07-28");
    for (const bad of ["", null, undefined, "not-a-date", "2026-7-8", "28/07/2026", "2026-07"]) {
      expect(parseDay(bad as string)).toBeNull();
    }
  });
});

describe("resolveRate", () => {
  it("uses the base currency at par even when the map omits it", () => {
    expect(resolveRate(new Map([["USD", 0.79]]), "GBP", "GBP")).toBe(1);
  });

  it("returns null for an unknown currency rather than silently using 1.0", () => {
    expect(resolveRate(new Map([["USD", 0.79]]), "JPY", "GBP")).toBeNull();
  });

  it("treats an empty map as single-currency mode", () => {
    expect(resolveRate(new Map(), "USD", "GBP")).toBe(1);
  });

  it("rejects non-finite and non-positive stored rates", () => {
    expect(resolveRate(new Map([["USD", 0]]), "USD", "GBP")).toBeNull();
    expect(resolveRate(new Map([["USD", Number.NaN]]), "USD", "GBP")).toBeNull();
    expect(resolveRate(new Map([["USD", -1]]), "USD", "GBP")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1. Partial ledgers
// ---------------------------------------------------------------------------

describe("unbackedOpenings — partial ledgers", () => {
  // The real shape from the Balanced sim: 704 V shares held, only 120 of them
  // traceable to fills. The old presence-based check called the whole leg
  // backed and handed back nothing.
  const partial: RevalueHolding[] = [
    {
      symbol: "V:xnys",
      quantity: 704,
      avg_cost: 362.53,
      instrument_ccy: "USD",
      opened_at: "2026-07-31T09:00:00Z",
    },
  ];

  it("credits only the shares the ledger cannot account for", () => {
    const openings = unbackedOpenings(
      partial,
      [buy("V", 120, 355, "2026-07-31T10:00:00Z")],
      FX,
      "GBP",
    );
    expect(openings).toHaveLength(1);
    expect(openings[0]!.unbackedQuantity).toBeCloseTo(584, 6);
    expect(openings[0]!.costBase).toBeCloseTo(584 * 362.53 * 0.79, 2);
    expect(openings[0]!.unresolved).toBeFalsy();
  });

  it("emits nothing once the ledger covers the whole position", () => {
    expect(
      unbackedOpenings(partial, [buy("V", 704, 355, "2026-07-31T10:00:00Z")], FX, "GBP"),
    ).toEqual([]);
  });

  it("lets sells consume backing, so a resynced leg is unbacked again", () => {
    // Bought 100, sold 100, yet 100 are held: the held shares came from
    // somewhere the ledger never saw.
    const openings = unbackedOpenings(
      [{ symbol: "MKS:xlon", quantity: 100, avg_cost: 4, instrument_ccy: "GBP", opened_at: "2026-07-20" }],
      [buy("MKS.L", 100, 4, "2026-07-20T10:00:00Z"), sell("MKS.L", 100, 4.2, "2026-07-22T10:00:00Z")],
      FX,
      "GBP",
    );
    expect(openings).toHaveLength(1);
    expect(openings[0]!.unbackedQuantity).toBeCloseTo(100, 6);
  });

  it("does not double-count backing shared by two spellings of one position", () => {
    // `ISF.L` and `ISF:xlon` are the same leg; 300 bought shares back the pair
    // once, not once each.
    const openings = unbackedOpenings(
      [
        { symbol: "ISF.L", quantity: 200, avg_cost: 10, instrument_ccy: "GBP", opened_at: "2026-07-10" },
        { symbol: "ISF:xlon", quantity: 200, avg_cost: 10, instrument_ccy: "GBP", opened_at: "2026-07-12" },
      ],
      [buy("ISF", 300, 10, "2026-07-10T10:00:00Z")],
      FX,
      "GBP",
    );
    const unbacked = openings.reduce((a, o) => a + (o.unbackedQuantity ?? 0), 0);
    expect(unbacked).toBeCloseTo(100, 6);
    // The earlier row absorbs the backing first.
    expect(openings).toHaveLength(1);
    expect(openings[0]!.at).toBe("2026-07-12");
  });

  it("ignores sub-share rounding residue from fractional fills", () => {
    expect(
      unbackedOpenings(
        [{ symbol: "VTI", quantity: 10, avg_cost: 300, instrument_ccy: "USD", opened_at: "2026-07-10" }],
        [buy("VTI", 9.9999999, 300, "2026-07-10T10:00:00Z")],
        FX,
        "GBP",
      ),
    ).toEqual([]);
  });

  it("refuses to be double-credited: partial cost lands once in the rollback", () => {
    const openings = unbackedOpenings(
      partial,
      [buy("V", 120, 355, "2026-07-31T10:00:00Z")],
      FX,
      "GBP",
    );
    const before = cashOn(
      10_000,
      [buy("V", 120, 355, "2026-07-31T10:00:00Z")],
      [],
      "2026-07-30",
      FX,
      openings,
      { anchorDate: "2026-08-04", baseCcy: "GBP" },
    );
    // 120 shares from the ledger + 584 unbacked shares = the full 704.
    expect(before).toBeCloseTo(
      Math.round((10_000 + 120 * 355 * 0.79 + 584 * 362.53 * 0.79) * 100) / 100,
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-currency legs
// ---------------------------------------------------------------------------

describe("multi-currency legs", () => {
  it("flags an opening whose currency has no rate instead of converting at 1.0", () => {
    const openings = unbackedOpenings(
      [{ symbol: "7203:xtks", quantity: 100, avg_cost: 2500, instrument_ccy: "JPY", opened_at: "2026-07-20" }],
      [],
      FX,
      "GBP",
    );
    expect(openings[0]!.unresolved).toBe(true);
    expect(openings[0]!.reason).toBe("no_fx");
    expect(openings[0]!.costBase).toBe(0);
  });

  it("refuses the day rather than roll cash back through an unresolved leg", () => {
    const openings = unbackedOpenings(
      [{ symbol: "7203:xtks", quantity: 100, avg_cost: 2500, instrument_ccy: "JPY", opened_at: "2026-07-20" }],
      [],
      FX,
      "GBP",
    );
    expect(
      cashOn(10_000, [], [], "2026-07-19", FX, openings, { anchorDate: "2026-07-31", baseCcy: "GBP" }),
    ).toBeNull();
    // On and after the opening it no longer matters.
    expect(
      cashOn(10_000, [], [], "2026-07-20", FX, openings, { anchorDate: "2026-07-31", baseCcy: "GBP" }),
    ).toBe(10_000);
  });

  it("refuses a fill in a currency with no rate", () => {
    expect(
      cashOn(
        10_000,
        [buy("7203:xtks", 100, 2500, "2026-07-25T02:00:00Z")],
        [],
        "2026-07-20",
        FX,
        [],
        { anchorDate: "2026-07-31", baseCcy: "GBP" },
      ),
    ).toBeNull();
  });

  it("converts each leg with its own rate, base currency at par", () => {
    const cash = cashOn(
      10_000,
      [buy("MKS:xlon", 100, 4, "2026-07-25T10:00:00Z"), buy("V:xnys", 10, 350, "2026-07-26T10:00:00Z")],
      [],
      "2026-07-20",
      FX,
      [],
      { anchorDate: "2026-07-31", baseCcy: "GBP" },
    );
    expect(cash).toBeCloseTo(10_000 + 100 * 4 + 10 * 350 * 0.79, 2);
  });

  it("stays at 1.0 when no FX map is supplied at all (single-currency callers)", () => {
    expect(
      cashOn(1_000, [buy("MKS:xlon", 10, 4, "2026-07-25T10:00:00Z")], [], "2026-07-20"),
    ).toBeCloseTo(1_040, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Out-of-order and malformed timestamps
// ---------------------------------------------------------------------------

describe("timestamp ordering", () => {
  const anchorDate = "2026-07-31";

  it("refuses a day when a fill cannot be placed in time", () => {
    for (const bad of ["", "not-a-date", "31-07-2026"]) {
      expect(
        cashOn(10_000, [buy("MKS:xlon", 10, 4, bad)], [], "2026-07-20", FX, [], {
          anchorDate,
          baseCcy: "GBP",
        }),
      ).toBeNull();
    }
  });

  it("does not silently treat an undated fill as already settled", () => {
    // The old `slice(0,10)` path turned "" into a date that sorts before every
    // day, so the fill was skipped and its cash never rolled back.
    const good = cashOn(10_000, [buy("MKS:xlon", 10, 4, "2026-07-25")], [], "2026-07-20", FX, [], {
      anchorDate,
      baseCcy: "GBP",
    });
    expect(good).toBeCloseTo(10_040, 2);
    expect(
      cashOn(10_000, [buy("MKS:xlon", 10, 4, "")], [], "2026-07-20", FX, [], { anchorDate, baseCcy: "GBP" }),
    ).toBeNull();
  });

  it("ignores fills dated after the anchor, which the anchor cannot include", () => {
    // A future-stamped or late-arriving fill must not shift the whole series:
    // the anchor balance was measured before it happened.
    const withFuture = cashOn(
      10_000,
      [buy("MKS:xlon", 10, 4, "2026-07-25"), buy("MKS:xlon", 1_000, 4, "2026-08-15")],
      [],
      "2026-07-20",
      FX,
      [],
      { anchorDate, baseCcy: "GBP" },
    );
    expect(withFuture).toBeCloseTo(10_040, 2);
  });

  it("is order-insensitive: shuffling the ledger yields the same balance", () => {
    const fills = [
      buy("MKS:xlon", 10, 4, "2026-07-25T10:00:00Z"),
      sell("MKS:xlon", 4, 4.5, "2026-07-28T10:00:00Z"),
      buy("V:xnys", 3, 350, "2026-07-26T10:00:00Z"),
      sell("V:xnys", 1, 360, "2026-07-27T10:00:00Z"),
    ];
    const forward = cashOn(50_000, fills, [], "2026-07-20", FX, [], { anchorDate, baseCcy: "GBP" });
    const reversed = cashOn(50_000, [...fills].reverse(), [], "2026-07-20", FX, [], {
      anchorDate,
      baseCcy: "GBP",
    });
    const shuffled = cashOn(50_000, [fills[2]!, fills[0]!, fills[3]!, fills[1]!], [], "2026-07-20", FX, [], {
      anchorDate,
      baseCcy: "GBP",
    });
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("refuses a day when a funding event has an unusable timestamp", () => {
    const events: RevalueFundEvent[] = [{ at: "sometime", amount: 500 }];
    expect(
      cashOn(10_000, [], events, "2026-07-20", FX, [], { anchorDate, baseCcy: "GBP" }),
    ).toBeNull();
  });

  it("ignores funding events dated after the anchor", () => {
    const events: RevalueFundEvent[] = [
      { at: "2026-07-25", amount: 500 },
      { at: "2026-08-20", amount: 100_000 },
    ];
    expect(cashOn(10_000, [], events, "2026-07-20", FX, [], { anchorDate, baseCcy: "GBP" })).toBeCloseTo(
      9_500,
      2,
    );
  });

  it("refuses a fill with a missing or non-positive quantity", () => {
    for (const qty of [0, -5, null, Number.NaN]) {
      expect(
        cashOn(
          10_000,
          [{ symbol: "MKS:xlon", side: "buy", quantity: qty, fill_price: 4, filled_at: "2026-07-25" }],
          [],
          "2026-07-20",
          FX,
          [],
          { anchorDate, baseCcy: "GBP" },
        ),
      ).toBeNull();
    }
  });

  it("refuses a malformed target date", () => {
    expect(cashOn(10_000, [], [], "yesterday", FX, [], { anchorDate, baseCcy: "GBP" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end: a partial, multi-currency, out-of-order ledger stays flat
// ---------------------------------------------------------------------------

describe("planHistoricalRevaluation — no jump from a messy ledger", () => {
  it("keeps the series continuous across a partially-backed USD import", () => {
    const holdings: RevalueHolding[] = [
      // 500 shares held, only 200 traceable to fills, priced in USD.
      { symbol: "V:xnys", quantity: 500, avg_cost: 300, instrument_ccy: "USD", opened_at: "2026-07-05" },
    ];
    const fills: RevalueFill[] = [
      // Deliberately out of chronological order in the array.
      buy("V", 100, 300, "2026-07-05T15:00:00Z"),
      buy("V", 100, 300, "2026-07-05T14:00:00Z"),
    ];
    const prices = new Map([["V", new Map([["2026-07-04", 300], ["2026-07-05", 300], ["2026-07-06", 300]])]]);
    const anchorCash = 1_000;
    const snapshots = [
      { snapshot_date: "2026-07-04", cash: anchorCash, holdings_value: 0, total_value: anchorCash },
      { snapshot_date: "2026-07-05", cash: anchorCash, holdings_value: 0, total_value: anchorCash },
      {
        snapshot_date: "2026-07-06",
        cash: anchorCash,
        holdings_value: 500 * 300 * 0.79,
        total_value: anchorCash + 500 * 300 * 0.79,
      },
    ];

    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots,
      holdings,
      fills,
      prices,
      fx: FX,
      baseCcy: "GBP",
      today: "2026-07-07",
    });

    const byDate = new Map(report.rows.map((r) => [r.snapshot_date, r]));
    const totals = snapshots.map(
      (s) => byDate.get(s.snapshot_date)?.total_value ?? Number(s.total_value),
    );
    // Every day carries the same wealth: before the position exists it is all
    // cash, afterwards it is the position plus what is left.
    for (const t of totals) expect(t).toBeCloseTo(totals[0]!, 0);
    // And no day-on-day ratio anywhere near the 3x jump threshold.
    for (let i = 1; i < totals.length; i += 1) {
      expect(totals[i]! / totals[i - 1]!).toBeLessThan(1.5);
    }
  });

  it("falls back to stored cash instead of guessing when a leg has no FX rate", () => {
    const holdings: RevalueHolding[] = [
      { symbol: "7203:xtks", quantity: 100, avg_cost: 2500, instrument_ccy: "JPY", opened_at: "2026-07-05" },
    ];
    const snapshots = [
      { snapshot_date: "2026-07-04", cash: 5_000, holdings_value: 0, total_value: 5_000 },
      { snapshot_date: "2026-07-05", cash: 3_000, holdings_value: 2_000, total_value: 5_000 },
    ];
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots,
      holdings,
      fills: [],
      prices: new Map(),
      fx: FX,
      baseCcy: "GBP",
      today: "2026-07-06",
    });
    // The 07-04 row keeps its stored 5,000 cash rather than an invented figure.
    const row = report.rows.find((r) => r.snapshot_date === "2026-07-04");
    expect(row?.cash ?? 5_000).toBeCloseTo(5_000, 2);
  });
});
