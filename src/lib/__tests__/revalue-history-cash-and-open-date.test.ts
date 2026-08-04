import { describe, expect, it } from "vitest";
import {
  cashOn,
  planHistoricalRevaluation,
  positionsOn,
  type RevalueFill,
  type RevalueHolding,
} from "../equity-snapshot-revalue";

// A broker re-sync rewrites `holdings` rows and stamps `opened_at` with the
// sync time. Trusting it erased every day before the sync (holdings → 0) while
// stored cash stayed at today's balance, which is exactly what produced the
// "0.19x drop then 5.31x jump" alert.
const holdings: RevalueHolding[] = [
  { symbol: "HSBA.L", quantity: 100, avg_cost: 15, opened_at: "2026-08-01T09:00:00Z" },
];

const fills: RevalueFill[] = [
  {
    symbol: "HSBA.L",
    side: "buy",
    quantity: 100,
    fill_price: 15,
    filled_at: "2026-07-28T10:00:00Z",
  },
];

const prices = new Map([["HSBA.L", new Map([["2026-07-28", 1500], ["2026-07-30", 1600]])]]);

describe("historical revaluation trusts the fills ledger over a re-synced opened_at", () => {
  it("keeps a position on days after its first fill but before opened_at", () => {
    expect(positionsOn(holdings, fills, "2026-07-30").get("HSBA.L")?.quantity).toBe(100);
  });

  it("still excludes days before the first fill", () => {
    expect(positionsOn(holdings, fills, "2026-07-27").size).toBe(0);
  });

  it("falls back to opened_at when the ledger has no fill for the leg", () => {
    expect(positionsOn(holdings, [], "2026-07-30").size).toBe(0);
    expect(positionsOn(holdings, [], "2026-08-02").get("HSBA.L")?.quantity).toBe(100);
  });
});

describe("cashOn rolls the balance back through later activity", () => {
  it("undoes a later buy", () => {
    expect(cashOn(500, fills, [], "2026-07-27")).toBe(2000);
  });

  it("undoes a later deposit", () => {
    expect(cashOn(500, [], [{ at: "2026-07-30T10:00:00Z", amount: 200 }], "2026-07-27")).toBe(300);
  });

  it("leaves days at or after the last event untouched", () => {
    expect(cashOn(500, fills, [], "2026-07-29")).toBe(500);
  });

  it("returns null when a later fill has no usable price", () => {
    expect(cashOn(500, [{ ...fills[0]!, fill_price: 0 }], [], "2026-07-27")).toBeNull();
  });

  it("returns null rather than inventing a negative balance", () => {
    expect(cashOn(100, [{ ...fills[0]!, side: "sell" }], [], "2026-07-27")).toBeNull();
  });
});

describe("planHistoricalRevaluation produces a coherent series", () => {
  it("re-marks holdings and reconstructs cash instead of copying today's balance", () => {
    const report = planHistoricalRevaluation({
      portfolioId: "p1",
      snapshots: [
        { snapshot_date: "2026-07-27", cash: 500, holdings_value: 0, total_value: 500 },
        { snapshot_date: "2026-07-30", cash: 500, holdings_value: 0, total_value: 500 },
        { snapshot_date: "2026-08-01", cash: 500, holdings_value: 1600, total_value: 2100 },
      ],
      holdings,
      fills,
      prices,
      today: "2026-08-02",
    });

    const jul30 = report.rows.find((r) => r.snapshot_date === "2026-07-30")!;
    expect(jul30.holdings_value).toBe(1600);
    expect(jul30.cash).toBe(500);
    expect(jul30.total_value).toBe(2100);

    const jul27 = report.rows.find((r) => r.snapshot_date === "2026-07-27");
    expect(jul27?.cash).toBe(2000);
    expect(jul27?.total_value).toBe(2000);

    // No day in the rebuilt series is more than 3x its neighbour.
    const totals = [2000, jul30.total_value, 2100];
    for (let i = 1; i < totals.length; i += 1) {
      expect(totals[i]! / totals[i - 1]!).toBeLessThan(3);
    }
  });
});
