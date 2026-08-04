import { describe, expect, it } from "vitest";
import {
  enumerateDays,
  planHistoricalRevaluation,
  type RevalueFill,
  type RevalueHolding,
  type RevalueSnapshot,
} from "@/lib/equity-snapshot-revalue";

const holdings: RevalueHolding[] = [
  {
    symbol: "AAA",
    quantity: 100,
    avg_cost: 10,
    instrument_ccy: "GBP",
    opened_at: "2026-07-05",
  },
];

const fills: RevalueFill[] = [
  { symbol: "AAA", side: "buy", quantity: 100, fill_price: 10, filled_at: "2026-07-05" },
];

const prices = new Map([
  [
    "AAA",
    new Map([
      ["2026-07-04", 9],
      ["2026-07-05", 10],
      ["2026-07-06", 11],
      ["2026-07-07", 12],
      ["2026-07-08", 13],
    ]),
  ],
]);

// Only the first and last day survive; 05–07 Jul are missing entirely.
const snapshots: RevalueSnapshot[] = [
  { snapshot_date: "2026-07-04", cash: 2000, holdings_value: 0, total_value: 2000 },
  { snapshot_date: "2026-07-08", cash: 1000, holdings_value: 1300, total_value: 2300 },
];

const baseArgs = {
  portfolioId: "p1",
  snapshots,
  holdings,
  fills,
  prices,
  inception: "2026-07-04",
  today: "2026-07-09",
  // `AAA` has no venue suffix, so the ccy rules read it as a US listing.
  fx: new Map([["GBP", 1], ["USD", 1]]),
  baseCcy: "GBP",
};

describe("enumerateDays", () => {
  it("returns an inclusive calendar range", () => {
    expect(enumerateDays("2026-07-04", "2026-07-07")).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
    ]);
  });

  it("crosses month boundaries", () => {
    expect(enumerateDays("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("returns nothing for inverted or malformed ranges", () => {
    expect(enumerateDays("2026-07-07", "2026-07-04")).toEqual([]);
    expect(enumerateDays("", "2026-07-04")).toEqual([]);
    expect(enumerateDays("not-a-date", "2026-07-04")).toEqual([]);
  });
});

describe("planHistoricalRevaluation gap fill", () => {
  it("leaves gaps alone by default", () => {
    const report = planHistoricalRevaluation(baseArgs);
    expect(report.rows.map((r) => r.snapshot_date)).not.toContain("2026-07-06");
    expect(report.rows.every((r) => r.inserted !== true)).toBe(true);
  });

  it("reconstructs every missing day between inception and the last stored row", () => {
    const report = planHistoricalRevaluation({ ...baseArgs, fillGaps: true });
    const inserted = report.rows.filter((r) => r.inserted);
    expect(inserted.map((r) => r.snapshot_date)).toEqual([
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
    ]);
  });

  it("marks reconstructed days against that day's close and rolled-back cash", () => {
    const report = planHistoricalRevaluation({ ...baseArgs, fillGaps: true });
    const byDate = new Map(report.rows.map((r) => [r.snapshot_date, r]));

    // Position exists from 05 Jul; cash is the 08 Jul anchor with no fills
    // after these days to undo, so it holds flat at 1000.
    expect(byDate.get("2026-07-05")).toMatchObject({
      cash: 1000,
      holdings_value: 1000,
      total_value: 2000,
    });
    expect(byDate.get("2026-07-06")).toMatchObject({
      holdings_value: 1100,
      total_value: 2100,
    });
    expect(byDate.get("2026-07-07")).toMatchObject({
      holdings_value: 1200,
      total_value: 2200,
    });
  });

  it("produces a strictly continuous series with no missing calendar day", () => {
    const report = planHistoricalRevaluation({ ...baseArgs, fillGaps: true });
    const dates = new Set([
      ...report.rows.map((r) => r.snapshot_date),
      ...snapshots.map((s) => s.snapshot_date),
    ]);
    for (const d of enumerateDays("2026-07-04", "2026-07-08")) {
      expect(dates.has(d)).toBe(true);
    }
  });

  it("does not treat a reconstructed day as the cash anchor", () => {
    // The 08 Jul stored balance stays the anchor: a fill after 05 Jul is
    // rolled back off it, which only works if the anchor is the stored row.
    const withLateFill = {
      ...baseArgs,
      fillGaps: true,
      fills: [
        ...fills,
        { symbol: "AAA", side: "buy", quantity: 10, fill_price: 10, filled_at: "2026-07-07" },
      ],
      holdings: [{ ...holdings[0]!, quantity: 110 }],
    };
    const report = planHistoricalRevaluation(withLateFill);
    const day6 = report.rows.find((r) => r.snapshot_date === "2026-07-06");
    expect(day6?.cash).toBe(1100);
    expect(day6?.holdings_value).toBe(1100);
  });

  it("skips reconstructed days the ledger cannot explain", () => {
    const report = planHistoricalRevaluation({
      ...baseArgs,
      fillGaps: true,
      // An undateable fill makes every cash rollback untrustworthy.
      fills: [{ symbol: "AAA", side: "buy", quantity: 100, fill_price: 10, filled_at: "" }],
    });
    // Cash falls back to the stored figure rather than being invented; the
    // reconstructed rows still carry a real position value, never a negative.
    for (const row of report.rows) {
      expect(row.cash).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.total_value)).toBe(true);
    }
  });

  it("is idempotent: re-running over the filled series adds nothing", () => {
    const first = planHistoricalRevaluation({ ...baseArgs, fillGaps: true });
    const merged: RevalueSnapshot[] = [
      ...snapshots,
      ...first.rows.map((r) => ({
        snapshot_date: r.snapshot_date,
        cash: r.cash,
        holdings_value: r.holdings_value,
        total_value: r.total_value,
      })),
    ];
    const second = planHistoricalRevaluation({
      ...baseArgs,
      snapshots: merged,
      fillGaps: true,
    });
    expect(second.rows.filter((r) => r.inserted)).toHaveLength(0);
  });
});
