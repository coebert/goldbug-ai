import { describe, expect, it } from "vitest";
import { buildHoldingSeries } from "@/lib/build-holding-series";
import { dedupePricePoints } from "@/lib/price-intraday.server";

const DAILY = [
  { date: "2026-07-28", close: 4.0 },
  { date: "2026-07-29", close: 4.1 },
  { date: "2026-07-30", close: 4.05 },
];

const HOURLY = [
  { at: "2026-07-29T09:00:00.000Z", close: 4.02 },
  { at: "2026-07-29T13:00:00.000Z", close: 4.11 },
  { at: "2026-07-30T09:00:00.000Z", close: 4.07 },
  { at: "2026-07-30T14:00:00.000Z", close: 4.05 },
];

const HOLDING = {
  symbol: "ULVR:xlon",
  quantity: 22,
  avg_cost: 4.0,
  opened_at: "2026-07-29T08:00:00.000Z",
  asset_class: "stock",
};

describe("hourly holding series", () => {
  it("returns more points than the daily series for the same window", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, HOURLY);
    expect(s.hourly.length).toBeGreaterThan(s.closes.length);
    expect(s.hourly).toHaveLength(s.hourlyAt.length);
  });

  it("anchors the hourly line at avg_cost, same as the daily line", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, HOURLY);
    expect(s.hourly[0]).toBeCloseTo(4.0, 6);
    expect(s.closes[0]).toBeCloseTo(4.0, 6);
  });

  it("drops observations from before the position was opened", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, [
      { at: "2026-07-20T10:00:00.000Z", close: 3.1 },
      ...HOURLY,
    ]);
    expect(Math.min(...s.hourly)).toBeGreaterThan(3.5);
  });

  it("sorts observations oldest → newest regardless of query order", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, [...HOURLY].reverse());
    expect(s.hourlyAt.slice(1)).toEqual(HOURLY.map((h) => h.at));
  });

  it("prefers the freshest hourly observation for the current price", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, HOURLY);
    expect(s.currentPrice).toBeCloseTo(4.05, 6);
    // % since purchase must stay consistent with that price.
    expect(s.pctChangeSincePurchase).toBeCloseTo((4.05 - 4) / 4, 6);
  });

  it("falls back to daily closes when no hourly points exist yet", () => {
    const s = buildHoldingSeries(HOLDING, DAILY, []);
    expect(s.hourly).toEqual([]);
    expect(s.currentPrice).toBeCloseTo(4.05, 6);
  });

  it("normalises GBX holdings the same way on both resolutions", () => {
    const gbx = { ...HOLDING, symbol: "MKS:xlon", avg_cost: 404 };
    const s = buildHoldingSeries(
      gbx,
      [{ date: "2026-07-30", close: 410 }],
      [{ at: "2026-07-30T10:00:00.000Z", close: 410 }],
    );
    // Whatever scaling applies, it must apply identically to both series.
    expect(s.hourly[s.hourly.length - 1]).toBeCloseTo(s.closes[s.closes.length - 1], 6);
  });
});

describe("intraday price recorder input hygiene", () => {
  it("keeps the last observation per symbol and drops junk", () => {
    const out = dedupePricePoints([
      { symbol: "MKS:xlon", price: 4.0 },
      { symbol: "MKS:xlon", price: 4.2 },
      { symbol: "BAD", price: 0 },
      { symbol: "", price: 5 },
      { symbol: "NAN", price: Number.NaN },
    ]);
    expect(out).toEqual([{ symbol: "MKS:xlon", price: 4.2 }]);
  });
});
