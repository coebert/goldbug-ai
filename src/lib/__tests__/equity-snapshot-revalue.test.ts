import { describe, expect, it } from "vitest";
import {
  closeOnOrBefore,
  instrumentCurrency,
  planHistoricalRevaluation,
  positionKey,
  positionsOn,
  symbolKeys,
} from "../equity-snapshot-revalue";

function priceMap(entries: Record<string, Record<string, number>>) {
  return new Map(
    Object.entries(entries).map(([sym, series]) => [sym, new Map(Object.entries(series))]),
  );
}

describe("symbol identity", () => {
  it("maps MIC-suffixed holdings onto Yahoo price-cache keys", () => {
    expect(symbolKeys("ISF:xlon")).toContain("ISF.L");
    expect(symbolKeys("ISF:xlon")).toContain("ISF");
    expect(symbolKeys("JNJ:xnys")).toContain("JNJ");
  });

  it("collapses every spelling onto one position key", () => {
    expect(positionKey("ISF:xlon")).toBe("ISF");
    expect(positionKey("ISF.L")).toBe("ISF");
    expect(positionKey("JNJ")).toBe("JNJ");
  });
});

describe("closeOnOrBefore", () => {
  const prices = priceMap({ "ISF.L": { "2026-07-23": 1036.6, "2026-07-28": 1058.6 } });

  it("carries the last known close forward across gaps", () => {
    expect(closeOnOrBefore(prices, "ISF:xlon", "2026-07-31")).toBeCloseTo(1058.6);
    expect(closeOnOrBefore(prices, "ISF:xlon", "2026-07-25")).toBeCloseTo(1036.6);
  });

  it("returns null before the first close", () => {
    expect(closeOnOrBefore(prices, "ISF:xlon", "2026-07-20")).toBeNull();
  });
});

describe("positionsOn", () => {
  const holdings = [
    { symbol: "ISF:xlon", quantity: 2266, avg_cost: 1052.4, asset_class: "etf" },
    { symbol: "ULVR:xlon", quantity: 91, avg_cost: 4619.5, asset_class: "stock" },
  ];
  const fills = [
    { symbol: "ISF.L", side: "buy", quantity: 2266, filled_at: "2026-07-28T09:00:00Z" },
    { symbol: "ULVR.L", side: "buy", quantity: 91, filled_at: "2026-07-27T07:00:00Z" },
  ];

  it("holds nothing before the first fill", () => {
    expect(positionsOn(holdings, fills, "2026-07-26").size).toBe(0);
  });

  it("rolls later buys back out of the book", () => {
    const book = positionsOn(holdings, fills, "2026-07-27");
    expect(book.get("ISF")).toBeUndefined();
    expect(book.get("ULVR")?.quantity).toBe(91);
  });

  it("returns the full book once every fill has happened", () => {
    const book = positionsOn(holdings, fills, "2026-07-29");
    expect(book.get("ISF")?.quantity).toBe(2266);
    expect(book.get("ULVR")?.quantity).toBe(91);
  });

  it("re-adds quantity for positions sold after the date", () => {
    const book = positionsOn(
      [{ symbol: "TSCO:xlon", quantity: 0, avg_cost: 487.8 }],
      [{ symbol: "TSCO.L", side: "sell", quantity: 119, filled_at: "2026-07-31T10:00:00Z" }],
      "2026-07-30",
    );
    expect(book.get("TSCO")?.quantity).toBe(119);
  });
});

describe("planHistoricalRevaluation", () => {
  const holdings = [
    { symbol: "ISF:xlon", quantity: 100, avg_cost: 1052.4, asset_class: "etf" },
    { symbol: "JNJ:xnys", quantity: 10, avg_cost: 262.67, asset_class: "stock" },
  ];
  const fills = [
    { symbol: "ISF.L", side: "buy", quantity: 100, filled_at: "2026-07-27T09:00:00Z" },
    { symbol: "JNJ", side: "buy", quantity: 10, filled_at: "2026-07-27T14:00:00Z" },
  ];
  const prices = priceMap({
    "ISF.L": { "2026-07-27": 1050, "2026-07-28": 1060 },
    JNJ: { "2026-07-27": 265, "2026-07-28": 266 },
  });

  it("folds historical pence quotes to pounds exactly once", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      // Stored history was written with raw GBX for ISF: 100 * 1050 = 105_000.
      snapshots: [
        { snapshot_date: "2026-07-27", cash: 1000, holdings_value: 107650, total_value: 108650 },
      ],
      holdings,
      fills,
      prices,
    });
    const row = report.rows[0]!;
    // 100 * 10.50 (GBP) + 10 * 265 = 3700
    expect(row.holdings_value).toBeCloseTo(3700, 2);
    expect(row.total_value).toBeCloseTo(4700, 2);
    expect(row.cash).toBe(1000);
    expect(row.previous_total_value).toBe(108650);
  });

  it("zeroes days before the positions were opened but keeps cash", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-26", cash: 5000, holdings_value: 99999, total_value: 104999 },
      ],
      holdings,
      fills,
      prices,
    });
    expect(report.rows[0]!.holdings_value).toBe(0);
    expect(report.rows[0]!.total_value).toBe(5000);
  });

  it("is idempotent — a corrected row is not rewritten", () => {
    const snapshots = [
      { snapshot_date: "2026-07-28", cash: 1000, holdings_value: 3720, total_value: 4720 },
    ];
    const first = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots,
      holdings,
      fills,
      prices,
    });
    expect(first.rows).toHaveLength(0);

    const second = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-28", cash: 1000, holdings_value: 1, total_value: 1001 },
      ],
      holdings,
      fills,
      prices,
    });
    expect(second.rows).toHaveLength(1);
    const third = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: second.rows.map((r) => ({
        snapshot_date: r.snapshot_date,
        cash: r.cash,
        holdings_value: r.holdings_value,
        total_value: r.total_value,
      })),
      holdings,
      fills,
      prices,
    });
    expect(third.rows).toHaveLength(0);
  });

  it("reports a ~100x ratio when the stored row used pence", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-27", cash: 0, holdings_value: 105000, total_value: 105000 },
      ],
      holdings: [holdings[0]!],
      fills: [fills[0]!],
      prices,
    });
    expect(report.rows[0]!.ratio).toBeCloseTo(100, 1);
  });

  it("ignores snapshots dated before inception", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-20", cash: 10, holdings_value: 999, total_value: 1009 },
        { snapshot_date: "2026-07-27", cash: 0, holdings_value: 999, total_value: 999 },
      ],
      holdings,
      fills,
      prices,
      inception: "2026-07-27",
    });
    expect(report.daysScanned).toBe(1);
    expect(report.rows.every((r) => r.snapshot_date >= "2026-07-27")).toBe(true);
  });
});

describe("currency handling", () => {
  it("derives the settlement currency from the listing", () => {
    expect(instrumentCurrency({ symbol: "ISF:xlon", quantity: 1 })).toBe("GBP");
    expect(instrumentCurrency({ symbol: "ISF.L", quantity: 1 })).toBe("GBP");
    expect(instrumentCurrency({ symbol: "JNJ:xnys", quantity: 1 })).toBe("USD");
    expect(
      instrumentCurrency({ symbol: "ISF:xlon", quantity: 1, instrument_ccy: "GBp" }),
    ).toBe("GBP");
    expect(
      instrumentCurrency({ symbol: "ASML:xams", quantity: 1, instrument_ccy: "EUR" }),
    ).toBe("EUR");
  });

  it("converts each leg into the portfolio base currency after the pence fold", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-28", cash: 0, holdings_value: 1, total_value: 1 },
      ],
      holdings: [
        { symbol: "ISF:xlon", quantity: 100, avg_cost: 1050, opened_at: "2026-07-27" },
        { symbol: "JNJ:xnys", quantity: 10, avg_cost: 260, opened_at: "2026-07-27" },
      ],
      fills: [],
      prices: priceMap({
        "ISF.L": { "2026-07-28": 1060 },
        JNJ: { "2026-07-28": 266 },
      }),
      fx: new Map([
        ["GBP", 1.15],
        ["USD", 0.89],
      ]),
      today: "2026-07-31",
    });
    // (100 * 10.60 * 1.15) + (10 * 266 * 0.89)
    expect(report.rows[0]!.holdings_value).toBeCloseTo(1219 + 2367.4, 1);
  });
});
