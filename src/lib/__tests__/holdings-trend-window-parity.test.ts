import { describe, it, expect } from "vitest";
import { buildHoldingSeries } from "../build-holding-series";
import { auditHoldingSeries } from "../holdings-series-sanity";

// The invariant this suite locks in: EVERY holding's sparkline must
//   1. start at the exact avg_cost baseline used by "% since purchase";
//   2. include only prices on or after opened_at (never pre-purchase);
//   3. end at the same currentPrice used to compute the headline %;
//   4. reproduce the headline % from (closes[last]-closes[0])/closes[0].

const closes = (dates: Array<[string, number]>) =>
  dates.map(([date, close]) => ({ date, close }));

describe("holding trend chart window & baseline parity", () => {
  it("clips pre-purchase history so window starts at opened_at", () => {
    const s = buildHoldingSeries(
      {
        symbol: "AAPL",
        quantity: 10,
        avg_cost: 150,
        opened_at: "2026-03-15T09:30:00Z",
        asset_class: "stock",
      },
      closes([
        ["2026-01-01", 100], // pre-purchase, must be dropped
        ["2026-02-01", 120], // pre-purchase, must be dropped
        ["2026-03-15", 150],
        ["2026-04-01", 165],
        ["2026-05-01", 175],
      ]),
    );
    // baseline = avg_cost
    expect(s.closes[0]).toBe(150);
    // no pre-purchase point survives
    expect(s.closes).not.toContain(100);
    expect(s.closes).not.toContain(120);
    // tail = currentPrice used by headline
    expect(s.closes[s.closes.length - 1]).toBe(s.currentPrice);
  });

  it("headline % is exactly reproducible from (tail-baseline)/baseline", () => {
    const s = buildHoldingSeries(
      {
        symbol: "MSFT",
        quantity: 5,
        avg_cost: 200,
        opened_at: "2026-04-01",
        asset_class: "stock",
      },
      closes([
        ["2026-04-01", 200],
        ["2026-05-01", 210],
        ["2026-06-01", 220],
      ]),
    );
    const first = s.closes[0];
    const tail = s.closes[s.closes.length - 1];
    const derived = (tail - first) / first;
    expect(derived).toBeCloseTo(s.pctChangeSincePurchase!, 10);
    expect(auditHoldingSeries(s)).toEqual([]);
  });

  it("LSE GBX rows use the same GBP baseline in chart and headline", () => {
    // HSBA.L stores avg_cost and closes in pence (GBX); normalizer converts
    // BOTH to GBP so the sparkline and headline share one currency.
    const s = buildHoldingSeries(
      {
        symbol: "HSBA:xlon",
        quantity: 100,
        avg_cost: 1500, // 1500p == £15.00
        opened_at: "2026-06-01",
        asset_class: "stock",
      },
      closes([
        ["2026-06-01", 1500],
        ["2026-07-01", 1600],
      ]),
    );
    expect(s.avg_cost).toBeCloseTo(15, 6);
    expect(s.closes[0]).toBeCloseTo(15, 6);
    expect(s.closes[s.closes.length - 1]).toBeCloseTo(16, 6);
    expect(s.pctChangeSincePurchase).toBeCloseTo(1 / 15, 6);
    expect(auditHoldingSeries(s)).toEqual([]);
  });

  it("holding opened today with zero prior closes still renders 2-pt series from cost", () => {
    const s = buildHoldingSeries(
      {
        symbol: "NVDA",
        quantity: 3,
        avg_cost: 900,
        opened_at: "2026-07-28",
        asset_class: "stock",
      },
      closes([["2026-07-28", 900]]),
    );
    expect(s.closes.length).toBeGreaterThanOrEqual(2);
    expect(s.closes[0]).toBe(900);
    expect(auditHoldingSeries(s)).toEqual([]);
  });

  it("batch: every returned series passes the runtime auditor", () => {
    const rows = [
      {
        h: { symbol: "AAPL", quantity: 10, avg_cost: 150, opened_at: "2026-03-15", asset_class: "stock" },
        p: closes([["2026-01-01", 100], ["2026-03-15", 150], ["2026-06-01", 170]]),
      },
      {
        h: { symbol: "VUKE.L", quantity: 50, avg_cost: 36, opened_at: "2026-02-01", asset_class: "etf" },
        p: closes([["2026-02-01", 36], ["2026-06-01", 38]]),
      },
      {
        h: { symbol: "HSBA:xlon", quantity: 100, avg_cost: 1500, opened_at: "2026-04-01", asset_class: "stock" },
        p: closes([["2026-04-01", 1500], ["2026-06-01", 1425]]),
      },
    ];
    for (const { h, p } of rows) {
      const s = buildHoldingSeries(h, p);
      // window
      const openedDate = (h.opened_at as string).slice(0, 10);
      for (let i = 1; i < s.closes.length; i++) {
        // every post-baseline point must correspond to a date >= opened_at
        const postDates = p.filter((x) => x.date >= openedDate);
        expect(postDates.length).toBeGreaterThan(0);
      }
      // baseline
      expect(s.closes[0]).toBeCloseTo(s.avg_cost, 6);
      // tail matches currentPrice
      expect(s.closes[s.closes.length - 1]).toBeCloseTo(s.currentPrice!, 6);
      // headline % reproduces from series endpoints
      const derived = (s.closes[s.closes.length - 1] - s.closes[0]) / s.closes[0];
      expect(derived).toBeCloseTo(s.pctChangeSincePurchase!, 6);
      // auditor agrees
      expect(auditHoldingSeries(s)).toEqual([]);
    }
  });

  it("opened_at with timestamp (ISO with T) still filters by date only", () => {
    const s = buildHoldingSeries(
      {
        symbol: "GOOG",
        quantity: 4,
        avg_cost: 130,
        opened_at: "2026-05-10T14:22:00.123Z",
        asset_class: "stock",
      },
      closes([
        ["2026-05-09", 128], // day before, must drop
        ["2026-05-10", 130], // same day, keep
        ["2026-06-01", 140],
      ]),
    );
    expect(s.closes).not.toContain(128);
    expect(s.closes[0]).toBe(130);
  });
});
