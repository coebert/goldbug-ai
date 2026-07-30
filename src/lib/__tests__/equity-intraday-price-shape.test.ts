import { describe, expect, it } from "vitest";
import {
  deriveIntradayFromPrices,
  reconstructQuantitiesByDay,
  type PriceObs,
} from "../equity-intraday-price-shape";

const NOW = new Date("2026-07-30T23:00:00.000Z");

const snap = (date: string, cash: number, holdings: number) => ({
  snapshot_date: date,
  cash,
  holdings_value: holdings,
  total_value: cash + holdings,
});

const px = (symbol: string, bucket_hour: string, price: number): PriceObs => ({
  symbol,
  bucket_hour,
  price,
});

describe("reconstructQuantitiesByDay", () => {
  it("rewinds later trades out of today's holdings", () => {
    const out = reconstructQuantitiesByDay(
      new Map([["AAA", 10]]),
      [{ symbol: "AAA", side: "buy", quantity: 4, executed_at: "2026-07-29T14:00:00Z" }],
      ["2026-07-27", "2026-07-29"],
    );
    expect(out.get("2026-07-29")!.get("AAA")).toBe(10);
    expect(out.get("2026-07-27")!.get("AAA")).toBe(6);
  });

  it("adds back quantity sold after the day", () => {
    const out = reconstructQuantitiesByDay(
      new Map([["AAA", 2]]),
      [{ symbol: "AAA", side: "sell", quantity: 3, executed_at: "2026-07-29T10:00:00Z" }],
      ["2026-07-28"],
    );
    expect(out.get("2026-07-28")!.get("AAA")).toBe(5);
  });

  it("never produces a negative quantity", () => {
    const out = reconstructQuantitiesByDay(
      new Map([["AAA", 1]]),
      [{ symbol: "AAA", side: "buy", quantity: 9, executed_at: "2026-07-29T10:00:00Z" }],
      ["2026-07-28"],
    );
    expect(out.get("2026-07-28")!.has("AAA")).toBe(false);
  });
});

describe("deriveIntradayFromPrices", () => {
  const qty = new Map([["2026-07-28", new Map([["AAA", 10]])]]);

  it("emits one row per observed hour and matches the snapshot at the close", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-28", 500, 1000)],
      [
        px("AAA", "2026-07-28T09:00:00Z", 90),
        px("AAA", "2026-07-28T13:00:00Z", 95),
        px("AAA", "2026-07-28T21:00:00Z", 100),
      ],
      qty,
      [],
      NOW,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].holdings_value).toBeCloseTo(900);
    expect(rows[1].total_value).toBeCloseTo(500 + 950);
    const close = rows[rows.length - 1];
    expect(close.holdings_value).toBeCloseTo(1000);
    expect(close.total_value).toBeCloseTo(1500);
  });

  it("skips days with fewer than two observations", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-28", 500, 1000)],
      [px("AAA", "2026-07-28T21:00:00Z", 100)],
      qty,
      [],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("skips snapshots without a cash/holdings split", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [{ snapshot_date: "2026-07-28", total_value: 1500 }],
      [px("AAA", "2026-07-28T09:00:00Z", 90), px("AAA", "2026-07-28T21:00:00Z", 100)],
      qty,
      [],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("never overwrites an hour that was genuinely recorded", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-28", 500, 1000)],
      [
        px("AAA", "2026-07-28T09:00:00Z", 90),
        px("AAA", "2026-07-28T13:00:00Z", 95),
        px("AAA", "2026-07-28T21:00:00Z", 100),
      ],
      qty,
      ["2026-07-28T13:00:00.000Z"],
      NOW,
    );
    expect(rows.map((r) => r.bucket_hour)).toEqual([
      "2026-07-28T09:00:00.000Z",
      "2026-07-28T21:00:00.000Z",
    ]);
  });

  it("weights multiple holdings and carries a stale symbol forward", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-28", 0, 2000)],
      [
        px("AAA", "2026-07-28T09:00:00Z", 100),
        px("BBB", "2026-07-28T09:00:00Z", 100),
        // BBB has no 21:00 print; its 09:00 price carries forward.
        px("AAA", "2026-07-28T21:00:00Z", 120),
      ],
      new Map([["2026-07-28", new Map([["AAA", 10], ["BBB", 10]])]]),
      [],
      NOW,
    );
    // index 09:00 = 2000, close = 2200 -> first point is 2000/2200 of close.
    expect(rows[0].holdings_value).toBeCloseTo(2000 * (2000 / 2200));
    expect(rows[1].holdings_value).toBeCloseTo(2000);
  });

  it("ignores hours recorded after the day's anchor", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-28", 0, 1000)],
      [
        px("AAA", "2026-07-28T09:00:00Z", 90),
        px("AAA", "2026-07-28T21:00:00Z", 100),
        px("AAA", "2026-07-28T22:00:00Z", 130),
      ],
      qty,
      [],
      NOW,
    );
    expect(rows.map((r) => r.bucket_hour)).toEqual([
      "2026-07-28T09:00:00.000Z",
      "2026-07-28T21:00:00.000Z",
    ]);
  });

  it("returns rows in chronological order across days", () => {
    const rows = deriveIntradayFromPrices(
      "p1",
      [snap("2026-07-29", 0, 1000), snap("2026-07-28", 0, 900)],
      [
        px("AAA", "2026-07-29T09:00:00Z", 100),
        px("AAA", "2026-07-29T21:00:00Z", 110),
        px("AAA", "2026-07-28T09:00:00Z", 80),
        px("AAA", "2026-07-28T21:00:00Z", 90),
      ],
      new Map([
        ["2026-07-28", new Map([["AAA", 10]])],
        ["2026-07-29", new Map([["AAA", 10]])],
      ]),
      [],
      NOW,
    );
    const buckets = rows.map((r) => r.bucket_hour);
    expect(buckets).toEqual([...buckets].sort());
    expect(buckets).toHaveLength(4);
  });
});
