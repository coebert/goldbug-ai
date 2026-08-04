// Regression guard for the "broker-imported positions look like a 3.4x jump"
// bug on the High risk sim portfolio.
//
// A linked broker account can gain positions the app never executed (manual
// trades, transfers, or the first sync of an account that already held stock).
// Those positions have no row in `live_fills`, so the cash they consumed is
// invisible to the historical cash rollback: every day before they appear
// keeps *today's* depleted balance while showing no holdings, and the day the
// positions land reads as an implausible multi-x jump.
//
// The fix hands each unbacked position's cost basis back to the days before
// it opened, so the series is flat across the import instead of stepping.

import { describe, it, expect } from "vitest";
import {
  cashOn,
  planHistoricalRevaluation,
  unbackedOpenings,
  type RevalueFill,
  type RevalueHolding,
} from "@/lib/equity-snapshot-revalue";

const FX = new Map<string, number>([
  ["EUR", 1],
  ["USD", 0.87],
  ["GBP", 1.17],
]);

/** JNJ + V arrived by broker sync on 07-27; ISF was bought by the app on 07-28. */
const HOLDINGS: RevalueHolding[] = [
  {
    symbol: "JNJ:xnys",
    quantity: 1587,
    avg_cost: 262.67,
    asset_class: "stock",
    instrument_ccy: "USD",
    opened_at: "2026-07-27T14:20:34Z",
  },
  {
    symbol: "V:xnys",
    quantity: 1059,
    avg_cost: 359.69,
    asset_class: "stock",
    instrument_ccy: "USD",
    opened_at: "2026-07-27T14:20:34Z",
  },
  {
    symbol: "ISF:xlon",
    quantity: 2266,
    avg_cost: 10.524,
    asset_class: "etf",
    instrument_ccy: "GBP",
    opened_at: "2026-07-28T13:00:58Z",
  },
];

const FILLS: RevalueFill[] = [
  {
    symbol: "ISF.L",
    side: "buy",
    quantity: 2266,
    fill_price: 10.524,
    filled_at: "2026-07-28T13:00:59Z",
  },
];

const JNJ_BASE = 1587 * 262.67 * 0.87;
const V_BASE = 1059 * 359.69 * 0.87;
const ISF_BASE = 2266 * 10.524 * 1.17;

describe("unbackedOpenings", () => {
  it("reports only the positions the fills ledger never bought", () => {
    const openings = unbackedOpenings(HOLDINGS, FILLS, FX);
    expect(openings).toHaveLength(2);
    expect(openings.map((o) => o.at).sort()).toEqual(["2026-07-27", "2026-07-27"]);
    const total = openings.reduce((a, o) => a + o.costBase, 0);
    expect(total).toBeCloseTo(JNJ_BASE + V_BASE, 2);
  });

  it("converts the cost basis to base currency without re-applying the LSE fold", () => {
    const [only] = unbackedOpenings(
      [
        {
          symbol: "ULVR:xlon",
          quantity: 46,
          avg_cost: 46.195,
          instrument_ccy: "GBP",
          opened_at: "2026-07-27T07:01:05Z",
        },
      ],
      [],
      FX,
    );
    // 46 × £46.195 × 1.17, NOT divided by 100 a second time.
    expect(only!.costBase).toBeCloseTo(46 * 46.195 * 1.17, 2);
  });

  it("ignores positions with no open date, no quantity, or no cost", () => {
    expect(
      unbackedOpenings(
        [
          { symbol: "A", quantity: 10, avg_cost: 5, opened_at: null },
          { symbol: "B", quantity: 0, avg_cost: 5, opened_at: "2026-07-01" },
          { symbol: "C", quantity: 10, avg_cost: 0, opened_at: "2026-07-01" },
        ],
        [],
        FX,
      ),
    ).toEqual([]);
  });

  it("treats a position as backed as soon as one buy fill exists for any spelling", () => {
    const openings = unbackedOpenings(HOLDINGS, [
      ...FILLS,
      { symbol: "JNJ", side: "buy", quantity: 1587, fill_price: 262.67, filled_at: "2026-07-27T14:20:00Z" },
    ], FX);
    expect(openings.map((o) => o.costBase)).toHaveLength(1);
    expect(openings[0]!.costBase).toBeCloseTo(V_BASE, 2);
  });

  it("does not treat a sell-only leg as backed", () => {
    const openings = unbackedOpenings(HOLDINGS, [
      { symbol: "JNJ", side: "sell", quantity: 1, fill_price: 262.67, filled_at: "2026-07-30T10:00:00Z" },
    ], FX);
    expect(openings).toHaveLength(3);
  });
});

describe("cashOn with unbacked broker positions", () => {
  const anchor = 267_068.89; // most recent broker-synced balance
  const openings = unbackedOpenings(HOLDINGS, FILLS, FX);

  it("gives the imported positions' cost back to earlier days", () => {
    const before = cashOn(anchor, FILLS, [], "2026-07-26", FX, openings);
    expect(before).toBeCloseTo(anchor + ISF_BASE + JNJ_BASE + V_BASE, 1);
  });

  it("stops crediting on and after the day the positions appeared", () => {
    const onDay = cashOn(anchor, FILLS, [], "2026-07-27", FX, openings);
    expect(onDay).toBeCloseTo(anchor + ISF_BASE, 1);
  });

  it("is unchanged when no openings are supplied (legacy behaviour)", () => {
    expect(cashOn(anchor, FILLS, [], "2026-07-26", FX)).toBeCloseTo(anchor + ISF_BASE, 1);
  });
});

describe("planHistoricalRevaluation across a broker position import", () => {
  const prices = new Map<string, Map<string, number>>([
    ["JNJ", new Map([["2026-07-27", 262.67], ["2026-07-28", 263.5]])],
    ["V", new Map([["2026-07-27", 359.69], ["2026-07-28", 360.1]])],
    ["ISF.L", new Map([["2026-07-28", 1052.4]])],
  ]);

  const snapshots = [
    // Pre-import days: only a tiny residual stub was ever recorded.
    { snapshot_date: "2026-07-25", cash: 267_068.89, holdings_value: 2404.47, total_value: 269_473.36 },
    { snapshot_date: "2026-07-26", cash: 267_068.89, holdings_value: 2404.47, total_value: 269_473.36 },
    { snapshot_date: "2026-07-27", cash: 267_068.89, holdings_value: 900_324.43, total_value: 1_167_393.32 },
    { snapshot_date: "2026-07-28", cash: 267_068.89, holdings_value: 767_406.32, total_value: 1_034_475.21 },
  ];

  const report = planHistoricalRevaluation({
    portfolioId: "p1",
    snapshots,
    holdings: HOLDINGS,
    fills: FILLS,
    prices,
    fx: FX,
    today: "2026-07-29",
  });

  const byDate = new Map(report.rows.map((r) => [r.snapshot_date, r]));

  it("rebuilds the pre-import days instead of skipping them as unattributable", () => {
    expect(report.skipped.map((s) => s.snapshot_date)).not.toContain("2026-07-25");
    expect(byDate.has("2026-07-25")).toBe(true);
    expect(byDate.has("2026-07-26")).toBe(true);
  });

  it("keeps total value flat across the import — no multi-x jump", () => {
    const totals = ["2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"].map(
      (d) => byDate.get(d)?.total_value ?? 0,
    );
    for (let i = 1; i < totals.length; i += 1) {
      const ratio = totals[i]! / totals[i - 1]!;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it("still refuses to rewrite a day whose missing holdings are material", () => {
    const materialStub = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        // Half the day's value sat in a position no longer reconstructable.
        { snapshot_date: "2026-07-25", cash: 100_000, holdings_value: 100_000, total_value: 200_000 },
        { snapshot_date: "2026-07-28", cash: 267_068.89, holdings_value: 767_406.32, total_value: 1_034_475.21 },
      ],
      holdings: HOLDINGS,
      fills: FILLS,
      prices,
      fx: FX,
      today: "2026-07-29",
    });
    expect(
      materialStub.skipped.find((s) => s.snapshot_date === "2026-07-25")?.reason,
    ).toBe("unattributable_history");
  });

  it("is idempotent: replanning the rebuilt series proposes no further writes", () => {
    const rebuilt = snapshots.map((s) => {
      const row = byDate.get(s.snapshot_date);
      return row
        ? {
            snapshot_date: row.snapshot_date,
            cash: row.cash,
            holdings_value: row.holdings_value,
            total_value: row.total_value,
          }
        : s;
    });
    const second = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: rebuilt,
      holdings: HOLDINGS,
      fills: FILLS,
      prices,
      fx: FX,
      today: "2026-07-29",
    });
    expect(second.rows).toEqual([]);
  });
});
